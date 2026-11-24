import { describe, expect, it } from "vitest";
import {
  causedByVersionBump,
  clip,
  deterministicCause,
  deterministicTitle,
  externalSource,
  findingId,
  groupByRootCause,
  identityName,
  policyDifference,
  primaryRule,
  typeOfAddress,
} from "../src/findings.js";
import { describePath } from "../src/plan/paths.js";
import type { Finding, Lineage, LineageStep, PlanModel, ResourceChange, ScoredChange } from "../src/types.js";

function change(over: Partial<ResourceChange> = {}): ResourceChange {
  return {
    address: "aws_db_instance.main",
    moduleAddress: null,
    configModulePath: [],
    mode: "managed",
    type: "aws_db_instance",
    name: "main",
    providerName: "registry.terraform.io/hashicorp/aws",
    actions: ["delete", "create"],
    action: "replace",
    replacePaths: [],
    before: { identifier: "orders-prod" },
    after: { identifier: "orders-prod-v2" },
    afterUnknown: {},
    changedPaths: [],
    unknownPaths: [],
    sensitiveChangedPaths: [],
    ...over,
  };
}

function scored(c: ResourceChange, reason = "x"): ScoredChange {
  return {
    change: c,
    severity: "critical",
    score: 1000,
    signals: [{ ruleId: "stateful-replace", severity: "critical", reason }],
  };
}

function lineage(over: Partial<Lineage> = {}): Lineage {
  return {
    address: "a",
    attribute: [],
    steps: [],
    rootCauseIds: [],
    explanation: "external",
    notes: [],
    ...over,
  };
}

function step(
  id: string,
  kind: LineageStep["kind"],
  label: string,
  over: Partial<LineageStep> = {},
): LineageStep {
  return { id, kind, modulePath: [], label, references: [], changedInDiff: false, ...over };
}

const plan = { drift: [] } as unknown as PlanModel;

describe("titles", () => {
  it("names what is destroyed by its current name and fits 100 characters with suffixes", () => {
    const t = deterministicTitle(scored(change()));
    expect(t).toBe("RDS database orders-prod (aws_db_instance) will be destroyed and re-created");
    const long = deterministicTitle(scored(change({ before: { identifier: "x".repeat(70) } })), 12, true);
    expect([...long].length).toBeLessThanOrEqual(100);
    expect(long).toMatch(/\(and 12 related changes\) \(not caused by this PR\)$/);
    // Cut at a word boundary, never mid-word, never "…." .
    expect(long).not.toMatch(/\w…\w|…\./);
  });

  it("tells a deposed leftover apart from the live object at the same address", () => {
    const c = change({ action: "delete", actions: ["delete"], deposed: "00cc22dd", after: null });
    expect(deterministicTitle(scored(c))).toBe(
      "RDS database orders-prod (aws_db_instance) (deposed object 00cc22dd) will be destroyed",
    );
  });

  it("falls back to the Name tag, then to the real address, when no name attribute is readable", () => {
    const c = change({
      address: "module.db.aws_db_instance.this",
      moduleAddress: "module.db",
      before: { identifier: "(sensitive)" },
      after: {},
    });
    expect(identityName(c)).toBe("module.db.aws_db_instance.this");
    expect(identityName(change({ before: { tags: { Name: "orders-primary" } }, after: {} }))).toBe(
      "orders-primary",
    );
  });

  it("titles an update by the first clause of its reason and cuts long ones at a word", () => {
    const update = change({ action: "update", actions: ["update"] });
    const t = deterministicTitle({
      change: update,
      severity: "critical",
      score: 1,
      signals: [
        {
          ruleId: "sg-open-world",
          severity: "critical",
          reason: "Ingress now allows TCP port 5432 from 0.0.0.0/0, so anyone on the internet can reach it.",
        },
      ],
    });
    expect(t).toBe(
      "RDS database orders-prod-v2 (aws_db_instance): Ingress now allows TCP port 5432 from 0.0.0.0/0",
    );
    expect(clip("one two three four five six", 12)).toBe("one two…");
  });
});

describe("ids", () => {
  it("are 12 hex characters, stable, and keyed on the address and the primary rule", () => {
    const id = findingId("a.b", "stateful-replace");
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(findingId("a.b", "stateful-replace")).toBe(id);
    expect(findingId("a.b", "other")).not.toBe(id);
    expect(primaryRule(scored(change()))).toBe("stateful-replace");
    expect(primaryRule(null)).toBe("agent");
  });
});

describe("externalSource", () => {
  it.each([
    [{ actionReason: "replace_because_tainted" }, lineage(), "tainted"],
    [{ actionReason: "replace_by_request" }, lineage(), "replace-request"],
    [
      {},
      lineage({
        notes: ["The plan's value of var.snap matches no default or .tfvars value in the repository: x"],
      }),
      "injected-variable",
    ],
    [
      {},
      lineage({ notes: ["… but this PR's diff does not remove it: it was removed before this PR, or …"] }),
      "removed-earlier",
    ],
    [{}, lineage({ steps: [step("s0", "upstream_resource", "data.aws_ami.base")] }), "data-source"],
    [{}, lineage(), "unknown"],
  ])("categorizes %j", (over, l, kind) => {
    expect(externalSource(change(over as Partial<ResourceChange>), l, plan).kind).toBe(kind);
  });

  it("names drift when the plan reports it", () => {
    const drifted = { drift: [change()] } as unknown as PlanModel;
    expect(externalSource(change(), lineage(), drifted).text).toMatch(/^drift:/);
  });

  it("recognizes a module or provider version bump as the only PR cause", () => {
    const l = lineage({
      explanation: "diff",
      steps: [
        step("s0", "resource_attribute", "x"),
        step("s1", "module_source", 'module "db" version', { changedInDiff: true }),
      ],
      rootCauseIds: ["s1"],
    });
    expect(causedByVersionBump(l)).toBe(true);
    expect(causedByVersionBump({ ...l, rootCauseIds: ["s0"] })).toBe(false);
  });
});

describe("groupByRootCause", () => {
  const f = (address: string, root: string, over: Partial<Finding> = {}): Finding => ({
    id: address,
    address,
    action: "replace",
    severity: "critical",
    title: address,
    impact: "",
    cause: "",
    causeLinks: [],
    signals: [],
    confidence: "high",
    origin: "rules",
    lineage: lineage({
      explanation: "diff",
      steps: [
        step("s0", "variable_value", "v", {
          location: { file: root, startLine: 2, endLine: 2 },
          changedInDiff: true,
        }),
      ],
      rootCauseIds: ["s0"],
    }),
    ...over,
  });

  it("folds every finding with the same root cause into the first, listing each with its own action", () => {
    const out = groupByRootCause([
      f("aws_s3_bucket.d[0]", "terraform.tfvars"),
      f("aws_s3_bucket.d[1]", "terraform.tfvars"),
      f("aws_s3_bucket.d[4]", "terraform.tfvars", { action: "delete" }),
      f("aws_s3_bucket.d[2]", "other.tfvars"),
      f("aws_s3_bucket_versioning.d[0]", "terraform.tfvars", { severity: "high" }),
      f("aws_s3_bucket.x", "terraform.tfvars", { lineage: undefined }),
    ]);
    expect(out.map((x) => [x.address, x.relatedAddresses ?? []])).toEqual([
      ["aws_s3_bucket.d[0]", ["aws_s3_bucket.d[1]", "aws_s3_bucket.d[4]", "aws_s3_bucket_versioning.d[0]"]],
      ["aws_s3_bucket.d[2]", []],
      ["aws_s3_bucket.x", []],
    ]);
    expect(out[0]?.relatedChanges?.map((r) => `${r.address} ${r.action} ${r.severity}`)).toEqual([
      "aws_s3_bucket.d[1] replace critical",
      "aws_s3_bucket.d[4] delete critical",
      "aws_s3_bucket_versioning.d[0] replace high",
    ]);
  });

  it("keeps a second critical exposure on an in-place change, and AI-written findings of another kind, apart", () => {
    const sig = (ruleId: string) => [{ ruleId, severity: "critical" as const, reason: "x" }];
    const out = groupByRootCause([
      f("aws_security_group.a", "prod.tfvars", { action: "update", signals: sig("sg-open-world") }),
      f("aws_db_instance.b", "prod.tfvars", { action: "update", signals: sig("db-public") }),
      f("aws_security_group.c", "prod.tfvars", { action: "update", signals: sig("sg-open-world") }),
      f("aws_s3_bucket.d", "prod.tfvars", { origin: "agent", severity: "high" }),
    ]);
    expect(out.map((x) => [x.address, x.relatedAddresses ?? []])).toEqual([
      ["aws_security_group.a", ["aws_security_group.c"]],
      ["aws_db_instance.b", []],
      ["aws_s3_bucket.d", []],
    ]);
  });

  it("folds AI-written findings of one kind whatever their severity, and by the lines the AI cited when nothing was traced", () => {
    const cited = (address: string, severity: Finding["severity"], line: number): Finding =>
      f(address, "x", {
        action: "update",
        origin: "agent",
        severity,
        lineage: undefined,
        agentCauseLinks: [
          { location: { file: "vars.tf", startLine: line, endLine: line }, label: "", changedInDiff: true },
        ],
      });
    const out = groupByRootCause([
      f('aws_cloudwatch_log_group.s["a"]', "vars.tf", {
        action: "update",
        origin: "agent",
        severity: "high",
      }),
      f('aws_cloudwatch_log_group.s["b"]', "vars.tf", {
        action: "update",
        origin: "agent",
        severity: "medium",
      }),
      cited('aws_sqs_queue.q["a"]', "high", 7),
      cited('aws_sqs_queue.q["b"]', "medium", 7),
      cited('aws_sqs_queue.q["c"]', "medium", 8),
    ]);
    expect(out.map((x) => [x.address, x.relatedChanges?.map((r) => r.severity) ?? []])).toEqual([
      ['aws_cloudwatch_log_group.s["a"]', ["medium"]],
      ['aws_sqs_queue.q["a"]', ["medium"]],
      ['aws_sqs_queue.q["c"]', []],
    ]);
  });

  it("groups a removed module's resources by the module call, not their own removed blocks", () => {
    const removed = (address: string, own: number): Finding =>
      f(address, "x", {
        action: "delete",
        lineage: lineage({
          explanation: "diff",
          attribute: [],
          steps: [
            step("s0", "removed_code", "own block", {
              location: { file: "modules/m/main.tf", startLine: own, endLine: own + 3, side: "base" },
              changedInDiff: true,
            }),
            step("s1", "removed_code", 'module "m"', {
              location: { file: "main.tf", startLine: 4, endLine: 8, side: "base" },
              changedInDiff: true,
              parentId: "s0",
            }),
          ],
          rootCauseIds: ["s1", "s0"],
        }),
      });
    const out = groupByRootCause([
      removed("module.m.aws_s3_bucket.a", 1),
      removed("module.m.aws_sqs_queue.b", 9),
    ]);
    expect(out.map((x) => [x.address, x.relatedAddresses ?? []])).toEqual([
      ["module.m.aws_s3_bucket.a", ["module.m.aws_sqs_queue.b"]],
    ]);
  });
});

describe("typeOfAddress", () => {
  it("finds the resource type after module instance keys that contain ']' or '.'", () => {
    expect(typeOfAddress('module.svc["x]y"].aws_s3_bucket.b')).toBe("aws_s3_bucket");
    expect(typeOfAddress('module.a["k.1"].module.b[0].data.aws_iam_policy_document.p')).toBe(
      "data:aws_iam_policy_document",
    );
    expect(typeOfAddress('aws_s3_bucket.b["x]y"]')).toBe("aws_s3_bucket");
  });
});

describe("why a delete happens", () => {
  const configuredPlan = (changes: ResourceChange[]) =>
    ({
      formatVersion: "1.2",
      drift: [],
      changes,
      modules: {
        "": {
          path: [],
          resources: {
            "terraform_data.gone": {
              address: "terraform_data.gone",
              mode: "managed",
              type: "terraform_data",
              name: "gone",
              expressions: {},
            },
          },
          moduleCalls: {},
          variables: {},
          outputs: {},
        },
      },
    }) as unknown as PlanModel;
  const gone = (over: Partial<ResourceChange>) =>
    change({
      address: "terraform_data.gone[1]",
      type: "terraform_data",
      name: "gone",
      index: 1,
      action: "delete",
      actions: ["delete"],
      after: null,
      ...over,
    });
  // What lineage says for a deleted instance of a resource that is still configured.
  const instanceGone = lineage({
    steps: [step("s0", "resource_block", 'resource "terraform_data" "gone" (instance [1] no longer exists)')],
  });

  it("an OpenTofu enabled = false delete keeps its block: the cause says so, not 'instance no longer exists'", () => {
    const c = gone({ actionReason: "delete_because_enabled_false" });
    expect(deterministicCause(c, instanceGone, configuredPlan([c]))).toMatch(
      /^The configuration still has the resource, but its enabled argument is now false\./,
    );
  });

  it("a deposed leftover is named as one, with where it really comes from", () => {
    const c = gone({ deposed: "00cc22dd", index: 0, address: "terraform_data.gone[0]" });
    const live = gone({ actionReason: "delete_because_count_index" });
    const text = deterministicCause(c, instanceGone, configuredPlan([c, live]));
    expect(text).toMatch(
      /^This is a leftover \(deposed\) object from an earlier create_before_destroy replacement/,
    );
    expect(text).toMatch(
      /Not caused by this PR: an earlier create_before_destroy replacement did not finish/,
    );
    expect(text).not.toMatch(/no longer exists/);
  });

  it("a destroy plan's deletes are caused by -destroy, not by the configuration", () => {
    const a = gone({});
    const b = gone({ address: "terraform_data.gone[0]", index: 0 });
    const p = configuredPlan([a, b]);
    expect(deterministicCause(a, instanceGone, p)).toMatch(/^This is a destroy plan/);
    expect(externalSource(a, instanceGone, p).kind).toBe("destroy-plan");
    // The same deletes with a reason are a normal plan.
    const c = gone({ actionReason: "delete_because_count_index" });
    expect(externalSource(c, instanceGone, configuredPlan([c])).kind).toBe("unknown");
  });
});

describe("policyDifference and describePath", () => {
  it("shows a policy change per statement, matched by Sid", () => {
    const before = JSON.stringify({
      Statement: [
        {
          Sid: "Read",
          Effect: "Allow",
          Action: ["s3:GetObject", "s3:ListBucket"],
          Resource: ["arn:aws:s3:::b/*"],
        },
        { Sid: "Old", Effect: "Allow", Action: "sqs:SendMessage", Resource: "*" },
      ],
    });
    const after = JSON.stringify({
      Statement: [{ Sid: "Read", Effect: "Allow", Action: "s3:*", Resource: "*" }],
    });
    expect(policyDifference(before, after)).toBe(
      'statement "Read" Action [s3:GetObject, s3:ListBucket] → s3:*, Resource arn:aws:s3:::b/* → *; statement "Old" removed',
    );
    expect(policyDifference("not json", after)).toBeNull();
  });

  it("names a nested block element by its description instead of its set index", () => {
    const value = { ingress: [{ description: "office", cidr_blocks: [] }, { cidr_blocks: [] }] };
    expect(describePath(value, ["ingress", 0, "cidr_blocks"])).toBe('ingress "office" cidr_blocks');
    expect(describePath(value, ["ingress", 1, "cidr_blocks"])).toBe("ingress[1].cidr_blocks");
  });
});

describe("nested block elements added or removed", () => {
  const sg = (before: unknown, after: unknown): ResourceChange =>
    change({
      address: "aws_security_group.db",
      type: "aws_security_group",
      name: "db",
      action: "update",
      actions: ["update"],
      before: { ingress: before },
      after: { ingress: after },
      changedPaths: [["ingress", 0]],
    });
  const open = { cidr_blocks: ["0.0.0.0/0"], description: "ssh debug", from_port: 22, protocol: "tcp" };
  const kept = { cidr_blocks: ["10.0.0.0/16"], description: "app", from_port: 5432, protocol: "tcp" };
  const traced = (attribute: (string | number)[]): Lineage =>
    lineage({
      attribute,
      explanation: "diff",
      steps: [
        step("s0", "resource_attribute", 'aws_security_group.db ingress "ssh debug"', {
          changedInDiff: true,
          location: { file: "main.tf", startLine: 13, endLine: 19 },
        }),
      ],
      rootCauseIds: ["s0"],
    });

  it("reads as an addition, not 'changes from null to {…}'", () => {
    const c = sg([null, kept], [open, kept]);
    const text = deterministicCause(c, traced(["ingress", 0]), plan);
    expect(text).toContain('is added (cidr_blocks ["0.0.0.0/0"], from_port 22, protocol "tcp")');
    expect(text).not.toMatch(/changes from null/);
  });

  it("reads as a removal when the element is gone after the change", () => {
    const c = sg([open, kept], [null, kept]);
    const text = deterministicCause(c, traced(["ingress", 0]), plan);
    expect(text).toMatch(/is removed \(cidr_blocks \["0\.0\.0\.0\/0"\]/);
  });
});
