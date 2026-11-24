import { describe, expect, it } from "vitest";
import {
  abacTagKeys,
  analyzePolicyChange,
  canonicalPolicy,
  isAdminPolicyArn,
  parsePolicyDocument,
  policiesEquivalent,
  principalAccount,
} from "../../src/risk/policy.js";
import type { PolicyKind } from "../../src/risk/policy.js";
import { SENSITIVE_PLACEHOLDER } from "../../src/types.js";
import { policyJson } from "./helpers.js";

describe("parsePolicyDocument", () => {
  it("normalizes a single Statement object and string values into sorted arrays", () => {
    const doc = parsePolicyDocument(
      JSON.stringify({
        Version: "2012-10-17",
        Statement: { Sid: "A", Effect: "allow", Action: "S3:GetObject", Resource: "arn:aws:s3:::b/*" },
      }),
    );
    expect(doc?.statements).toEqual([
      {
        sid: "A",
        effect: "Allow",
        action: ["s3:getobject"],
        notAction: [],
        resource: ["arn:aws:s3:::b/*"],
        notResource: [],
        principal: null,
        notPrincipal: null,
        condition: null,
      },
    ]);
  });

  it.each([
    ["masked value", SENSITIVE_PLACEHOLDER],
    ["unknown (undefined)", undefined],
    ["null", null],
    ["not JSON", "{not json"],
    ["empty string", ""],
    ["a number", 42],
  ])("returns null for %s", (_label, value) => {
    expect(parsePolicyDocument(value)).toBeNull();
  });

  it("normalizes Principal '*' and condition values", () => {
    const doc = parsePolicyDocument(
      policyJson([
        {
          Effect: "Allow",
          Principal: "*",
          Action: "s3:GetObject",
          Resource: "*",
          Condition: { Bool: { "aws:SecureTransport": false } },
        },
      ]),
    );
    expect(doc?.statements[0]?.principal).toEqual({ AWS: ["*"] });
    expect(doc?.statements[0]?.condition).toEqual({ Bool: { "aws:securetransport": ["false"] } });
  });
});

describe("policiesEquivalent (NOISE-04)", () => {
  const base = policyJson([
    {
      Sid: "Read",
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:ListBucket"],
      Resource: ["arn:aws:s3:::b", "arn:aws:s3:::b/*"],
    },
    { Effect: "Allow", Action: "logs:PutLogEvents", Resource: "*" },
  ]);

  it.each([
    ["whitespace and key order", JSON.stringify(JSON.parse(base), null, 2).replace('"Version"', '"Version"')],
    [
      "array order, statement order and single-string vs array",
      policyJson([
        { Resource: ["*"], Action: ["logs:PutLogEvents"], Effect: "Allow" },
        {
          Effect: "Allow",
          Action: ["s3:ListBucket", "s3:GetObject"],
          Resource: ["arn:aws:s3:::b/*", "arn:aws:s3:::b"],
          Sid: "Read",
        },
      ]),
    ],
    [
      "Sid removed and action case",
      policyJson([
        {
          Effect: "Allow",
          Action: ["S3:GETOBJECT", "s3:ListBucket"],
          Resource: ["arn:aws:s3:::b", "arn:aws:s3:::b/*"],
        },
        { Effect: "Allow", Action: "logs:PutLogEvents", Resource: "*" },
      ]),
    ],
  ])("treats %s as the same policy", (_label, other) => {
    expect(policiesEquivalent(base, other)).toBe(true);
  });

  it("detects a real difference", () => {
    const wider = policyJson([{ Effect: "Allow", Action: "s3:*", Resource: "*" }]);
    expect(policiesEquivalent(base, wider)).toBe(false);
  });

  it("returns null when a side cannot be parsed", () => {
    expect(policiesEquivalent(base, undefined)).toBeNull();
    expect(policiesEquivalent(SENSITIVE_PLACEHOLDER, base)).toBeNull();
  });

  it("canonical form is stable across orderings", () => {
    const a = parsePolicyDocument(base)!;
    const b = parsePolicyDocument(JSON.stringify(JSON.parse(base)))!;
    expect(canonicalPolicy(a)).toBe(canonicalPolicy(b));
  });
});

const narrow = { Effect: "Allow", Action: ["s3:GetObject"], Resource: ["arn:aws:s3:::reports/*"] };

function analyze(
  kind: PolicyKind,
  before: unknown[] | null,
  after: unknown[],
  opts: { isCreate?: boolean; knownAccounts?: string[] } = {},
) {
  return analyzePolicyChange(
    before ? parsePolicyDocument(policyJson(before)) : null,
    parsePolicyDocument(policyJson(after)),
    kind,
    {
      attr: kind === "trust" ? "assume_role_policy" : "policy",
      isCreate: opts.isCreate ?? false,
      knownAccounts: new Set(opts.knownAccounts ?? []),
    },
  );
}

describe("analyzePolicyChange (AWS-U08)", () => {
  it.each([
    ["svc:* on Resource *", { Effect: "Allow", Action: "s3:*", Resource: "*" }, "iam-wildcard", "critical"],
    ["* on *", { Effect: "Allow", Action: "*", Resource: "*" }, "iam-wildcard", "critical"],
    [
      "svc:* on an all-resources ARN",
      { Effect: "Allow", Action: "dynamodb:*", Resource: "arn:aws:dynamodb:*:*:*" },
      "iam-wildcard",
      "critical",
    ],
    ["NotAction", { Effect: "Allow", NotAction: "iam:*", Resource: "*" }, "iam-not-action", "high"],
    [
      "NotResource",
      { Effect: "Allow", Action: "s3:GetObject", NotResource: "arn:aws:s3:::secret/*" },
      "iam-not-action",
      "high",
    ],
    [
      "iam:PassRole on *",
      { Effect: "Allow", Action: "iam:PassRole", Resource: "*" },
      "iam-passrole-wildcard",
      "high",
    ],
    [
      "sts:AssumeRole on *",
      { Effect: "Allow", Action: "sts:AssumeRole", Resource: "*" },
      "iam-assume-any-role",
      "high",
    ],
    [
      "a scoped new statement",
      { Effect: "Allow", Action: "s3:PutObject", Resource: "arn:aws:s3:::drop/*" },
      "policy-new-statement",
      "medium",
    ],
    [
      "svc:* on one bucket",
      { Effect: "Allow", Action: "s3:*", Resource: "arn:aws:s3:::drop/*" },
      "policy-new-statement",
      "medium",
    ],
  ])("identity policy gaining %s → %s (%s)", (_label, statement, ruleId, severity) => {
    const findings = analyze("identity", [narrow], [narrow, statement]);
    expect(findings[0]).toMatchObject({ ruleId, severity });
    expect(findings[0]?.reason).toMatch(/^policy /);
  });

  it("judges only statements that are new (an existing wildcard is not re-flagged)", () => {
    const wildcard = { Effect: "Allow", Action: "s3:*", Resource: "*" };
    expect(analyze("identity", [wildcard], [wildcard, narrow]).map((f) => f.ruleId)).toEqual([
      "policy-new-statement",
    ]);
  });

  it("a create reports only critical/high findings", () => {
    expect(analyze("identity", null, [narrow], { isCreate: true })).toEqual([]);
    expect(
      analyze("identity", null, [{ Effect: "Allow", Action: "*", Resource: "*" }], { isCreate: true })[0]
        ?.severity,
    ).toBe("critical");
  });

  it("no finding when the policy is unchanged after normalization", () => {
    expect(analyze("identity", [narrow], [{ ...narrow, Sid: "renamed" }])).toEqual([]);
  });

  it("flags a removed Deny statement", () => {
    const deny = { Effect: "Deny", Action: "s3:DeleteBucket", Resource: "*" };
    expect(analyze("identity", [narrow, deny], [narrow])).toEqual([
      expect.objectContaining({ ruleId: "policy-deny-removed", severity: "medium" }),
    ]);
  });

  it.each([
    [
      "Principal *",
      { Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: "arn:aws:s3:::b/*" },
      "critical",
    ],
    [
      "AWS: *",
      { Effect: "Allow", Principal: { AWS: "*" }, Action: "s3:GetObject", Resource: "arn:aws:s3:::b/*" },
      "critical",
    ],
    [
      "Principal * with only aws:SecureTransport",
      {
        Effect: "Allow",
        Principal: "*",
        Action: "s3:GetObject",
        Resource: "arn:aws:s3:::b/*",
        Condition: { Bool: { "aws:SecureTransport": "true" } },
      },
      "critical",
    ],
  ])("resource policy gaining %s is public", (_label, statement, severity) => {
    expect(analyze("resource", [], [statement])[0]).toMatchObject({ ruleId: "policy-public", severity });
  });

  it("a restrictive condition (aws:SourceArn) keeps Principal * from counting as public", () => {
    const st = {
      Effect: "Allow",
      Principal: { Service: "cloudtrail.amazonaws.com", AWS: "*" },
      Action: "s3:PutObject",
      Resource: "arn:aws:s3:::logs/*",
      Condition: { ArnLike: { "aws:SourceArn": "arn:aws:cloudtrail:eu-west-1:111122223333:trail/main" } },
    };
    expect(analyze("resource", [], [st]).map((f) => f.ruleId)).toEqual(["policy-new-statement"]);
  });

  describe("trust policies", () => {
    const lambda = {
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
      Action: "sts:AssumeRole",
    };
    it.each([
      [
        "Principal *",
        { Effect: "Allow", Principal: "*", Action: "sts:AssumeRole" },
        ["111122223333"],
        "trust-public",
        "critical",
      ],
      [
        "an account that appears nowhere else",
        { Effect: "Allow", Principal: { AWS: "arn:aws:iam::999988887777:root" }, Action: "sts:AssumeRole" },
        ["111122223333"],
        "trust-external-account",
        "critical",
      ],
      [
        "an account when no accounts are known",
        { Effect: "Allow", Principal: { AWS: "999988887777" }, Action: "sts:AssumeRole" },
        [],
        "trust-new-account",
        "high",
      ],
      [
        "GitHub OIDC without conditions",
        {
          Effect: "Allow",
          Principal: {
            Federated: "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com",
          },
          Action: "sts:AssumeRoleWithWebIdentity",
        },
        ["111122223333"],
        "trust-oidc-unscoped",
        "critical",
      ],
      [
        "GitHub OIDC with only an aud condition",
        {
          Effect: "Allow",
          Principal: {
            Federated: "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com",
          },
          Action: "sts:AssumeRoleWithWebIdentity",
          Condition: { StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" } },
        },
        ["111122223333"],
        "trust-oidc-unscoped",
        "high",
      ],
    ])("gaining %s → %s", (_label, statement, accounts, ruleId, severity) => {
      expect(analyze("trust", [lambda], [lambda, statement], { knownAccounts: accounts })[0]).toMatchObject({
        ruleId,
        severity,
      });
    });

    it("a scoped OIDC trust and a known account are not critical", () => {
      const scoped = {
        Effect: "Allow",
        Principal: {
          Federated: "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com",
        },
        Action: "sts:AssumeRoleWithWebIdentity",
        Condition: {
          StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
          StringLike: { "token.actions.githubusercontent.com:sub": "repo:acme/infra:ref:refs/heads/main" },
        },
      };
      const own = {
        Effect: "Allow",
        Principal: { AWS: "arn:aws:iam::111122223333:role/ci" },
        Action: "sts:AssumeRole",
      };
      const findings = analyze("trust", [lambda], [lambda, scoped, own], { knownAccounts: ["111122223333"] });
      expect(findings.map((f) => f.severity)).toEqual(["medium"]);
    });
  });
});

describe("helpers", () => {
  it.each([
    ["arn:aws:iam::aws:policy/AdministratorAccess", true],
    ["arn:aws:iam::aws:policy/PowerUserAccess", true],
    ["arn:aws:iam::aws:policy/IAMFullAccess", true],
    ["arn:aws:iam::aws:policy/ReadOnlyAccess", false],
    ["arn:aws:iam::111122223333:policy/MyAdministratorAccessHelper", false],
    [undefined, false],
  ])("isAdminPolicyArn(%s) = %s", (arn, expected) => {
    expect(isAdminPolicyArn(arn)).toBe(expected);
  });

  it.each([
    ["111122223333", "111122223333"],
    ["arn:aws:iam::111122223333:root", "111122223333"],
    ["arn:aws:sts::111122223333:assumed-role/x/y", "111122223333"],
    ["*", null],
  ])("principalAccount(%s) = %s", (p, expected) => {
    expect(principalAccount(p)).toBe(expected);
  });

  it("finds ABAC tag keys in conditions", () => {
    const doc = parsePolicyDocument(
      policyJson([
        {
          Effect: "Allow",
          Action: "ec2:StartInstances",
          Resource: "*",
          Condition: { StringEquals: { "aws:ResourceTag/Team": "${aws:PrincipalTag/Team}" } },
        },
      ]),
    );
    expect(abacTagKeys(doc)).toEqual(["team"]);
  });
});
