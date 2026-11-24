// End-to-end tests of reviewPlan: every eval fixture in rules-only mode (no crash, no leak, sound
// structure), the merge policy with a scripted agent, grouping by root cause, plan-health banners,
// lineage through file(), PLAN-13, and a 5,000-change plan.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPlan } from "../src/plan/load.js";
import { renderCliReport, renderJson, renderReviewComment } from "../src/report/markdown.js";
import { MAX_TRACED, planNotices, reviewPlan, traceAttributes } from "../src/review.js";
import type { AgentOptions, Review, ScoredChange } from "../src/types.js";
import { createFsWorkspace } from "../src/workspace.js";
import { json, reply, scriptedClient, thinking, toolUse, verdictReply } from "./helpers/anthropic.js";

const FIXTURES = join(import.meta.dirname, "..", "evals", "fixtures");
/** Planted in the fixtures: the RDS master password, and the mock provider credentials of the generator. */
const PLANTED = ["not-a-real-password-123", "mock_secret_key", "mock_access_key"];

function fixtureNames(): string[] {
  if (!existsSync(FIXTURES)) return [];
  return (
    readdirSync(FIXTURES)
      // ho-* fixtures are the blind held-out set: never run against them here.
      .filter(
        (n) =>
          !n.startsWith(".") &&
          !n.startsWith("_") &&
          !n.startsWith("ho-") &&
          existsSync(join(FIXTURES, n, "plan.json")),
      )
      .sort()
  );
}

function readFixture(name: string): { planJson: unknown; diffText: string | null; repo: string } {
  const dir = join(FIXTURES, name);
  const diffPath = join(dir, "pr.diff");
  return {
    planJson: JSON.parse(readFileSync(join(dir, "plan.json"), "utf8")) as unknown,
    diffText: existsSync(diffPath) ? readFileSync(diffPath, "utf8") : null,
    repo: join(dir, "repo"),
  };
}

async function reviewFixture(name: string, agent: AgentOptions | null = null): Promise<Review> {
  const f = readFixture(name);
  return reviewPlan({
    planJson: f.planJson,
    workspace: createFsWorkspace(f.repo, ""),
    diffText: f.diffText,
    agent,
    maxFindings: 7,
  });
}

function allRendered(review: Review): string {
  return [
    JSON.stringify(review),
    renderReviewComment([review], { version: "test" }),
    renderCliReport([review]),
    renderJson([review]),
  ].join("\n");
}

function tempRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "tfcr-review-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function countBy(values: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return m;
}

// ───────────────────────────── every fixture ─────────────────────────────

describe("reviewPlan on every eval fixture (rules only)", () => {
  const names = fixtureNames();
  it("has fixtures to run", () => {
    expect(names.length).toBeGreaterThan(5);
  });

  for (const name of names) {
    it(`${name}: no crash, no leak, sound structure`, async () => {
      const f = readFixture(name);
      const review = await reviewFixture(name);
      const plan = loadPlan(f.planJson);
      const changes = plan.changes.filter((c) => c.action !== "no-op");

      // No secret survives anywhere the review goes.
      const out = allRendered(review);
      for (const secret of PLANTED) expect(out).not.toContain(secret);

      // Every non-no-op change is either a finding (or grouped into one) or an "other change", once.
      expect(review.stats.totalChanges).toBe(changes.length);
      const listed = [
        ...review.findings.flatMap((x) => [x.address, ...(x.relatedAddresses ?? [])]),
        ...review.others.map((o) => o.change.address),
      ];
      expect(countBy(listed)).toEqual(countBy(changes.map((c) => c.address)));
      expect(review.findings.length).toBeLessThanOrEqual(7);
      expect(review.agent).toBeUndefined();
      expect(review.summary.length).toBeGreaterThan(0);

      const rank = ["critical", "high", "medium"];
      let last = 0;
      for (const finding of review.findings) {
        expect(finding.id).toMatch(/^[0-9a-f]{12}$/);
        expect(rank).toContain(finding.severity);
        expect(rank.indexOf(finding.severity)).toBeGreaterThanOrEqual(last);
        last = rank.indexOf(finding.severity);
        expect(finding.origin).toBe("rules");
        expect([...finding.title].length).toBeLessThanOrEqual(100);
        expect(finding.title.trim()).not.toBe("");
        expect(finding.impact.trim()).not.toBe("");
        expect(finding.cause.trim()).not.toBe("");
        // Cut at a word boundary, never followed by a full stop; no escaped JSON in the text.
        for (const text of [finding.title, finding.impact, finding.cause]) {
          expect(text).not.toMatch(/…\./);
          expect(text).not.toContain('\\"');
        }
        expect(finding.relatedChanges?.map((r) => r.address) ?? []).toEqual(finding.relatedAddresses ?? []);
        for (const link of finding.causeLinks) {
          if (link.location.side === "base") {
            expect(f.diffText ?? "").toContain(link.location.file);
            continue;
          }
          const file = join(f.repo, link.location.file);
          expect(existsSync(file), link.location.file).toBe(true);
          const lines = readFileSync(file, "utf8").split("\n").length;
          expect(link.location.endLine).toBeLessThanOrEqual(lines);
        }
        const steps = finding.lineage?.steps ?? [];
        steps.forEach((s, i) => expect(s.id).toBe(`s${i}`));
        for (const id of finding.lineage?.rootCauseIds ?? [])
          expect(steps.some((s) => s.id === id)).toBe(true);
      }
      // Stable ids: a second run gives the same findings.
      const again = await reviewFixture(name);
      expect(again.findings.map((x) => x.id)).toEqual(review.findings.map((x) => x.id));
    });
  }
});

// ───────────────────────────── grouping ─────────────────────────────

describe("grouping by root cause", () => {
  it("folds instances replaced by one tfvars line into one finding with related addresses", async () => {
    const review = await reviewFixture("s3-count-reindex");
    const buckets = review.findings.find((f) => f.address.startsWith("aws_s3_bucket.data["));
    expect(buckets?.relatedAddresses?.length).toBeGreaterThanOrEqual(3);
    expect(buckets?.title).toMatch(/\(and \d+ related changes\)$/);
    // The shifted delete at the end of the list is listed as a delete, not under "re-created".
    expect(buckets?.relatedChanges?.find((r) => r.address === "aws_s3_bucket.data[4]")?.action).toBe(
      "delete",
    );
    expect(buckets?.causeLinks.some((l) => l.location.file === "terraform.tfvars" && l.changedInDiff)).toBe(
      true,
    );
    const comment = renderReviewComment([review], { version: "test" });
    expect(comment).toContain("Same cause, also changes (");
    expect(comment).toContain('"related":["aws_s3_bucket.data[');
  });

  it("folds the instances a replaced subnet takes down into the subnet's finding", async () => {
    const review = await reviewFixture("subnet-cascade");
    const subnet = review.findings.find((f) => f.address.includes("aws_subnet.private"));
    expect(subnet?.relatedChanges?.map((r) => `${r.address} ${r.action}`)).toEqual([
      'aws_instance.ledger["ledger-a1"] replace',
      'aws_instance.ledger["ledger-a2"] replace',
    ]);
    expect(review.findings.some((f) => f.address.startsWith("aws_instance.ledger"))).toBe(false);
  });
});

// ───────────────────────────── what each card says (dev fixtures) ─────────────────────────────

describe("finding text on the dev fixtures", () => {
  it("pairs a security group rule with its own before value, whatever order Terraform listed the set in", async () => {
    const review = await reviewFixture("sg-open-world");
    const sg = review.findings.find((f) => f.address === "aws_security_group.db");
    expect(sg?.cause).toContain(
      'ingress "Postgres from office and VPN" cidr_blocks changes from ["203.0.113.0/24", "198.51.100.0/25"] to ["0.0.0.0/0"]',
    );
    expect(sg?.cause).not.toContain("10.40.10.0/24");
    expect(sg?.title).toBe(
      "Security group billing-prod-postgres: Ingress now allows TCP port 5432 (PostgreSQL) from 0.0.0.0/0",
    );
    // The chain follows only the branch to the changed line: not the unchanged office_cidrs input.
    const comment = renderReviewComment([review], { version: "test" });
    expect(comment).toMatch(
      /\*\*Cause chain:\*\* `ingress "Postgres from office and VPN" cidr_blocks` ← `main\.tf:23` ← `main\.tf:2` ← \*\*`prod\.auto\.tfvars:5`\*\* ✏️ ·/,
    );
  });

  it("explains every safety net a multi-signal change turns off, each with its own changed line", async () => {
    const review = await reviewFixture("rds-protection-off");
    const db = review.findings[0];
    const lines = (db?.causeLinks ?? [])
      .filter((l) => l.changedInDiff)
      .map((l) => `${l.location.file}:${l.location.startLine}`);
    expect(lines).toEqual(
      expect.arrayContaining(["terraform.tfvars:12", "terraform.tfvars:13", "terraform.tfvars:14"]),
    );
    expect(db?.cause).toMatch(/backup_retention_period changes from 14 to 0/);
    expect(db?.impact).toMatch(/deletes the existing automated backups and point-in-time recovery/);
    expect(db?.impact).not.toMatch(/usually the first step/);
  });

  it("folds a load balancer rename's cascade into one finding and says the blast radius once", async () => {
    const review = await reviewFixture("lb-rename-replace");
    expect(review.findings).toHaveLength(1);
    const alb = review.findings[0];
    expect(alb?.address).toBe("aws_lb.public");
    expect(alb?.relatedChanges).toHaveLength(13);
    expect(alb?.relatedChanges?.find((r) => r.address === "aws_route53_record.storefront")?.action).toBe(
      "update",
    );
    expect(alb?.impact).not.toMatch(/This plan destroys/);
    expect(alb?.impact).toMatch(/DNS records this plan manages follow/);
    expect((review.notices ?? []).join(" ")).toMatch(/This plan destroys 13 resources/);
  });

  it("makes one finding of a removed module, and never mentions prevent_destroy it did not have", async () => {
    const review = await reviewFixture("module-removed");
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0]?.relatedAddresses).toHaveLength(3);
    expect(JSON.stringify(review)).not.toContain("prevent_destroy");
  });

  it("says a deleted KMS alias is still used by resources the plan keeps, and that decrypts fail at once", async () => {
    const review = await reviewFixture("kms-key-removed");
    const alias = review.findings.find((f) => f.address === "aws_kms_alias.documents");
    expect(alias?.signals.some((s) => s.ruleId === "still-referenced")).toBe(true);
    expect(alias?.impact).toMatch(/resources this plan keeps still use its "alias\/prod-documents"/);
    const key = review.findings.find((f) => f.address === "aws_kms_key.documents");
    expect(key?.impact).toMatch(/fails from this apply on/);
  });

  it("shows a policy change statement by statement, and the changed lines, not the block around them", async () => {
    const review = await reviewFixture("iam-wildcard");
    const policy = review.findings[0];
    expect(policy?.cause).toMatch(/statement "ReportsBucket" Action \[[^\]]*s3:GetObject[^\]]*\] → s3:\*/);
    expect(policy?.impact).toMatch(/full control of S3/);
    const comment = renderReviewComment([review], { version: "test" });
    expect(comment).toMatch(/← \*\*`iam\.tf:25`\*\* ✏️, \*\*`iam\.tf:26`\*\* ✏️/);
    expect(comment).not.toMatch(/`iam\.tf:21-34`\*\* ✏️/);
  });

  it("with no diff, claims nothing about the PR: no 'not explained' signal, title or sentence", async () => {
    const f = readFixture("db-encryption-replace");
    const review = await reviewPlan({
      planJson: f.planJson,
      workspace: createFsWorkspace(f.repo, ""),
      diffText: null,
      agent: null,
      maxFindings: 7,
    });
    expect(review.findings.length).toBeGreaterThan(0);
    for (const finding of review.findings) {
      expect(finding.signals.map((s) => s.ruleId)).not.toContain("not-explained-by-diff");
      expect(finding.title).not.toContain("not caused by this PR");
      expect(finding.cause).not.toMatch(/outside|Not caused|No changed line/);
    }
    expect(review.summary).not.toMatch(/not explained/);
    expect(review.notices?.filter((n) => /No PR diff was available/.test(n))).toHaveLength(1);
    expect(renderReviewComment([review], { version: "test" })).not.toContain("Tracing stopped");
  });
});

// ───────────────────────────── not explained by the PR ─────────────────────────────

describe("changes the PR does not explain", () => {
  it("says plainly that an injected variable, not the diff, replaces the database", async () => {
    const review = await reviewFixture("injected-var-external");
    const db = review.findings[0];
    expect(db?.severity).toBe("critical");
    expect(db?.lineage?.explanation).toBe("external");
    expect(db?.title).toContain("(not caused by this PR)");
    expect(db?.cause).toMatch(/Not caused by this PR/);
    expect(db?.cause).toMatch(/injected variable value: var\.\w+ is set outside the repository/);
  });

  it("explains a rename without a moved block", async () => {
    const review = await reviewFixture("renamed-without-moved");
    const table = review.findings.find((f) => f.address === "aws_dynamodb_table.orders");
    expect(table?.cause).toMatch(
      /This PR renames resource "aws_dynamodb_table" "orders" to "orders_table" without a moved block \(storage\.tf:1 in the base version, now storage\.tf:1\)/,
    );
    expect(table?.title).toMatch(/re-created empty \(renamed without a moved block\)/);
    expect(table?.impact).toMatch(
      /moved \{ from = aws_dynamodb_table\.orders to = aws_dynamodb_table\.orders_table \}/,
    );
    // Only the label line changed: the link is that line, not the whole (kept) block.
    expect(table?.causeLinks[0]?.location).toMatchObject({ side: "base", startLine: 1, endLine: 1 });
    expect(table?.causeLinks[1]?.location).toEqual({ file: "storage.tf", startLine: 1, endLine: 1 });
  });
});

// ───────────────────────────── agent merge policy ─────────────────────────────

const SUBNET = 'module.vpc.aws_subnet.private["eu-west-1a"]';
const LEDGER_A1 = 'aws_instance.ledger["ledger-a1"]';
const LEDGER_A2 = 'aws_instance.ledger["ledger-a2"]';

function agentOptions(client: unknown): AgentOptions {
  return {
    model: "claude-opus-5-5",
    apiKey: "sk-test",
    effort: "high",
    maxTurns: 4,
    maxCostUsd: 5,
    timeoutMs: 60_000,
    client,
  };
}

const finding = (
  address: string,
  severity: "critical" | "high" | "medium",
  refs = [{ file: "terraform.tfvars", line: 11 }],
) => ({
  address,
  severity,
  title: `Agent title for ${address}`,
  impact: "Agent impact.",
  cause: "Agent cause: terraform.tfvars:11 widens the subnet.",
  cause_refs: refs,
  confidence: "high" as const,
});

describe("merge policy with the agent", () => {
  it("confirms, adds, drops invalid references, and moves a dismissed high to other changes", async () => {
    const rules = await reviewFixture("subnet-cascade");
    const other = rules.others.find((o) => o.severity === "low" || o.severity === "medium") as ScoredChange;
    expect(other).toBeDefined();
    const { client, requests } = scriptedClient([
      verdictReply({
        summary: "The PR widens a subnet, which replaces it and the ledger nodes in it.",
        findings: [
          finding(SUBNET, "critical", [
            { file: "terraform.tfvars", line: 11 },
            { file: "does-not-exist.tf", line: 3 },
            { file: "terraform.tfvars", line: 9999 },
          ]),
          finding(other.change.address, "medium"),
          finding("aws_s3_bucket.not_in_this_plan", "high"),
        ],
        dismissed: [{ address: LEDGER_A1, reason: "Ledger nodes are rebuilt from the snapshot nightly." }],
      }),
    ]);

    const review = await reviewFixture("subnet-cascade", agentOptions(client));

    expect(requests).toHaveLength(1);
    expect(review.agent?.status).toBe("complete");
    expect(review.summary).toBe("The PR widens a subnet, which replaces it and the ledger nodes in it.");
    const subnet = review.findings.find((f) => f.address === SUBNET);
    expect(subnet).toMatchObject({
      origin: "both",
      severity: "critical",
      title: `Agent title for ${SUBNET}`,
    });
    expect(subnet?.causeLinks.filter((l) => l.location.file === "does-not-exist.tf")).toEqual([]);
    expect(
      subnet?.causeLinks.some((l) => l.location.file === "terraform.tfvars" && l.location.startLine === 11),
    ).toBe(true);
    expect(review.findings.find((f) => f.address === other.change.address)).toMatchObject({
      origin: "agent",
      severity: "medium",
    });
    expect(review.findings.some((f) => f.address === "aws_s3_bucket.not_in_this_plan")).toBe(false);
    expect(review.warnings.join("\n")).toMatch(/named 1 address\(es\) that do not change/);
    expect(review.warnings.join("\n")).toMatch(/cited 2 lines that do not exist/);

    // Dismissed high: moved to other changes with the reason; its sibling stays a finding.
    expect(
      review.findings.some((f) => f.address === LEDGER_A1 || f.relatedAddresses?.includes(LEDGER_A1)),
    ).toBe(false);
    const dismissed = review.others.find((o) => o.change.address === LEDGER_A1);
    expect(dismissed?.signals[0]).toMatchObject({ ruleId: "agent-dismissed", severity: "high" });
    expect(dismissed?.signals[0]?.reason).toContain("rebuilt from the snapshot");
    expect(review.findings.some((f) => f.address === LEDGER_A2)).toBe(true);
  });

  it("never drops a deterministic critical the agent dismisses: it stays, confidence lowered, reason shown", async () => {
    const { client } = scriptedClient([
      verdictReply({
        summary: "Nothing to see.",
        findings: [],
        dismissed: [{ address: SUBNET, reason: "Looks fine." }],
      }),
    ]);
    const review = await reviewFixture("subnet-cascade", agentOptions(client));
    const subnet = review.findings.find((f) => f.address === SUBNET);
    expect(subnet).toMatchObject({ severity: "critical", origin: "rules", confidence: "medium" });
    expect(subnet?.cause).toContain('The AI review dismissed this finding ("Looks fine.")');
  });

  it("groups agent-only findings that share one root cause like rule findings, before the cap", async () => {
    const groups = [
      "audit",
      "billing-api",
      "billing-worker",
      "notifications",
      "orders-api",
      "orders-worker",
    ].map((k) => `module.platform.aws_cloudwatch_log_group.service["${k}"]`);
    const ref = [{ file: "modules/platform/main.tf", line: 11 }];
    const { client } = scriptedClient([
      verdictReply({
        summary: "Shorter log retention everywhere.",
        findings: groups.map((a, i) => ({
          ...finding(a, i === 2 ? "high" : "medium", ref),
          title: `Log group ${i} keeps logs for 14 days`,
        })),
        dismissed: [],
      }),
    ]);
    const review = await reviewFixture("db-encryption-replace", agentOptions(client));
    const cards = review.findings.filter((f) => groups.includes(f.address));
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    // The highest severity stands for the group; each member keeps its own severity.
    expect(card).toMatchObject({ address: groups[2], severity: "high", origin: "agent" });
    expect(card.relatedAddresses).toHaveLength(5);
    expect(card.relatedChanges?.every((r) => r.severity === "medium")).toBe(true);
    expect(card.agentCauseLinks?.map((l) => l.location)).toEqual([
      { file: "modules/platform/main.tf", startLine: 11, endLine: 11 },
    ]);
    expect(review.warnings.join("\n")).not.toMatch(/beyond max-findings/);
  });

  it("fails open: an API error leaves the deterministic review, with a warning", async () => {
    const rules = await reviewFixture("subnet-cascade");
    const { client } = scriptedClient([
      json({ type: "error", error: { type: "api_error", message: "boom" } }, 500),
    ]);
    const review = await reviewFixture("subnet-cascade", agentOptions(client));
    expect(review.agent?.status).toBe("error");
    expect(review.findings.map((f) => f.id)).toEqual(rules.findings.map((f) => f.id));
    expect(review.warnings.join("\n")).toMatch(/AI review did not finish \(error\)/);
  });
});

// ───────────────────────────── masking: strict union + value equality ─────────────────────────────

const CANARY = {
  marked: "Canary-Marked-91xQ",
  rootVar: "Canary-RootVar-27pL",
  rootDefault: "Canary-Default-55mZ",
  moduleCall: "Canary-ModCall-38vK",
  provider: "Canary-Provider-64nW",
  output: "Canary-Output-12rT",
  drift: "Canary-Drift-83sY",
};
const ALL_CANARIES = Object.values(CANARY);
const AWS = "registry.terraform.io/hashicorp/aws";

function canaryPlan(): unknown {
  const copies = ALL_CANARIES.join(" ");
  return {
    format_version: "1.2",
    terraform_version: "1.10.5",
    variables: { seed_value: { value: CANARY.rootVar }, fallback: { value: CANARY.rootDefault } },
    resource_changes: [
      {
        address: "aws_db_instance.main",
        mode: "managed",
        type: "aws_db_instance",
        name: "main",
        provider_name: AWS,
        action_reason: "replace_because_cannot_update",
        change: {
          actions: ["delete", "create"],
          before: { identifier: "app-db", password: CANARY.marked, storage_encrypted: true },
          after: { identifier: "app-db", password: CANARY.marked, storage_encrypted: false },
          after_unknown: {},
          before_sensitive: { password: true },
          after_sensitive: { password: true },
          replace_paths: [["storage_encrypted"]],
        },
      },
      {
        address: "aws_ssm_parameter.notes",
        mode: "managed",
        type: "aws_ssm_parameter",
        name: "notes",
        provider_name: AWS,
        change: {
          actions: ["update"],
          before: { name: "/app/notes", type: "String", value: "v1", description: "old" },
          // Derived copies Terraform leaves unmarked: every canary, in a plain attribute.
          after: { name: "/app/notes", type: "String", value: "v2", description: `copies: ${copies}` },
          after_unknown: {},
          before_sensitive: {},
          after_sensitive: {},
        },
      },
      {
        address: "aws_s3_bucket.logs",
        mode: "managed",
        type: "aws_s3_bucket",
        name: "logs",
        provider_name: AWS,
        change: {
          actions: ["update"],
          before: { bucket: "app-logs", tags: { Note: "x" } },
          after: { bucket: "app-logs", tags: { Note: CANARY.drift, Seed: CANARY.rootVar } },
          after_unknown: {},
          before_sensitive: {},
          after_sensitive: {},
        },
      },
    ],
    resource_drift: [
      {
        address: "aws_s3_bucket.logs",
        mode: "managed",
        type: "aws_s3_bucket",
        name: "logs",
        provider_name: AWS,
        change: {
          actions: ["update"],
          before: { bucket: "app-logs", secret_tag: CANARY.drift },
          after: { bucket: "app-logs", secret_tag: "" },
          after_unknown: {},
          before_sensitive: { secret_tag: true },
          after_sensitive: { secret_tag: true },
        },
      },
    ],
    output_changes: {
      conn: {
        actions: ["update"],
        before: CANARY.output,
        after: CANARY.output,
        before_sensitive: true,
        after_sensitive: true,
      },
    },
    configuration: {
      provider_config: {
        aws: {
          name: "aws",
          full_name: AWS,
          expressions: {
            region: { constant_value: "eu-west-1" },
            secret_key: { constant_value: CANARY.provider },
          },
        },
      },
      root_module: {
        variables: {
          seed_value: { sensitive: true },
          fallback: { sensitive: true, default: CANARY.rootDefault },
          encrypted: { default: false },
        },
        outputs: { conn: { sensitive: true, expression: { references: ["aws_db_instance.main.endpoint"] } } },
        resources: [
          {
            address: "aws_db_instance.main",
            mode: "managed",
            type: "aws_db_instance",
            name: "main",
            expressions: { storage_encrypted: { references: ["var.encrypted"] } },
          },
        ],
        module_calls: {
          app: {
            source: "./modules/app",
            expressions: { init_value: { constant_value: CANARY.moduleCall } },
            module: { variables: { init_value: { sensitive: true } } },
          },
        },
      },
    },
  };
}

function canaryRepo(): string {
  return tempRepo({
    "main.tf": [
      `# legacy notes: ${CANARY.marked} ${CANARY.output} ${CANARY.drift}`,
      'resource "aws_db_instance" "main" {',
      '  identifier        = "app-db"',
      "  storage_encrypted = var.encrypted",
      "}",
      'module "app" {',
      '  source     = "./modules/app"',
      `  init_value = "${CANARY.moduleCall}"`,
      "}",
      "",
    ].join("\n"),
    "variables.tf": [
      'variable "encrypted" {',
      "  default = false",
      "}",
      'variable "fallback" {',
      "  sensitive = true",
      `  default   = "${CANARY.rootDefault}"`,
      "}",
      'variable "seed_value" {',
      "  sensitive = true",
      "}",
      "",
    ].join("\n"),
    "terraform.tfvars": `seed_value = "${CANARY.rootVar}"\n`,
    "providers.tf": `provider "aws" {\n  region     = "eu-west-1"\n  secret_key = "${CANARY.provider}"\n}\n`,
    "modules/app/main.tf": 'variable "init_value" {\n  sensitive = true\n}\n',
  });
}

const CANARY_DIFF = [
  "diff --git a/variables.tf b/variables.tf",
  "--- a/variables.tf",
  "+++ b/variables.tf",
  "@@ -1,3 +1,3 @@",
  ' variable "encrypted" {',
  "-  default = true",
  "+  default = false",
  " }",
  "diff --git a/main.tf b/main.tf",
  "--- a/main.tf",
  "+++ b/main.tf",
  "@@ -1 +1 @@",
  "-# legacy notes",
  `+# legacy notes: ${CANARY.marked} ${CANARY.output} ${CANARY.drift}`,
  "diff --git a/terraform.tfvars b/terraform.tfvars",
  "--- a/terraform.tfvars",
  "+++ b/terraform.tfvars",
  "@@ -0,0 +1 @@",
  `+seed_value = "${CANARY.rootVar}"`,
  "",
].join("\n");

describe("no sensitive value leaves the process (canaries in every marked place)", () => {
  it("keeps every canary out of the review, the digest, every tool output and the rendered report", async () => {
    const { client, requests } = scriptedClient([
      reply(
        [
          thinking,
          toolUse("t1", "list_changes", {}),
          toolUse("t2", "get_change", { address: "aws_ssm_parameter.notes" }),
          toolUse("t3", "get_change", { address: "aws_s3_bucket.logs" }),
          toolUse("t4", "trace_cause", { address: "aws_db_instance.main" }),
          toolUse("t5", "read_file", { path: "main.tf" }),
          toolUse("t6", "read_file", { path: "terraform.tfvars" }),
          toolUse("t7", "search_repo", { pattern: "Canary" }),
          toolUse("t8", "get_diff", {}),
        ],
        "tool_use",
      ),
      verdictReply({ summary: "Database replaced.", findings: [], dismissed: [] }),
    ]);
    const review = await reviewPlan({
      planJson: canaryPlan(),
      workspace: createFsWorkspace(canaryRepo(), ""),
      diffText: CANARY_DIFF,
      agent: agentOptions(client),
      maxFindings: 7,
    });

    expect(review.agent?.status).toBe("complete");
    expect(requests).toHaveLength(2);
    // The second request carries all eight tool results; the first one is the digest.
    expect(requests[1]?.raw).toContain("tool_result");
    for (const r of requests) for (const c of ALL_CANARIES) expect(r.raw).not.toContain(c);
    const out = allRendered(review);
    for (const c of ALL_CANARIES) expect(out).not.toContain(c);
    // The replacement is still found and traced: masking hides values, not structure.
    expect(review.findings[0]?.address).toBe("aws_db_instance.main");
    expect(review.findings[0]?.causeLinks.some((l) => l.location.file === "variables.tf")).toBe(true);
  });
});

// ───────────────────────────── lineage through file() ─────────────────────────────

/** A policy read with file() from a JSON file the PR changes. */
function exporterCase(extraFiles: Record<string, string> = {}): {
  planJson: unknown;
  repo: string;
  diff: string;
} {
  const policy = (action: string, resource: string) =>
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: action, Resource: resource }],
    });
  const repo = tempRepo({
    "iam.tf": [
      'resource "aws_iam_policy" "exporter" {',
      '  name   = "exporter"',
      '  policy = file("${path.module}/policies/exporter.json")',
      "}",
      "",
    ].join("\n"),
    "policies/exporter.json": `{\n  "Version": "2012-10-17",\n  "Statement": [\n    { "Effect": "Allow", "Action": "s3:*", "Resource": "*" }\n  ]\n}\n`,
    ...extraFiles,
  });
  const diff = [
    "diff --git a/policies/exporter.json b/policies/exporter.json",
    "--- a/policies/exporter.json",
    "+++ b/policies/exporter.json",
    "@@ -3,3 +3,3 @@",
    '   "Statement": [',
    '-    { "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::reports/*" }',
    '+    { "Effect": "Allow", "Action": "s3:*", "Resource": "*" }',
    "   ]",
    "",
  ].join("\n");
  return {
    repo,
    diff,
    planJson: {
      format_version: "1.2",
      terraform_version: "1.10.5",
      resource_changes: [
        {
          address: "aws_iam_policy.exporter",
          mode: "managed",
          type: "aws_iam_policy",
          name: "exporter",
          provider_name: AWS,
          change: {
            actions: ["update"],
            before: { name: "exporter", policy: policy("s3:GetObject", "arn:aws:s3:::reports/*") },
            after: { name: "exporter", policy: policy("s3:*", "*") },
            after_unknown: {},
            before_sensitive: {},
            after_sensitive: {},
          },
        },
      ],
      configuration: {
        root_module: {
          resources: [
            {
              address: "aws_iam_policy.exporter",
              mode: "managed",
              type: "aws_iam_policy",
              name: "exporter",
              expressions: { name: { constant_value: "exporter" }, policy: {} },
            },
          ],
        },
      },
    },
  };
}

describe("causes outside .tf files", () => {
  it("links the changed JSON file a policy reads with file(), not just the attribute", async () => {
    const { planJson, repo, diff } = exporterCase();
    const review = await reviewPlan({
      planJson,
      workspace: createFsWorkspace(repo, ""),
      diffText: diff,
      agent: null,
      maxFindings: 7,
    });
    const f = review.findings[0];
    expect(f?.address).toBe("aws_iam_policy.exporter");
    const step = f?.lineage?.steps.find((s) => s.kind === "file_content");
    expect(step).toMatchObject({
      changedInDiff: true,
      location: { file: "policies/exporter.json", startLine: 4 },
    });
    expect(f?.lineage?.rootCauseIds).toContain(step?.id);
    expect(f?.lineage?.explanation).toBe("diff");
    expect(f?.causeLinks.some((l) => l.location.file === "policies/exporter.json" && l.changedInDiff)).toBe(
      true,
    );
    expect(f?.cause).toContain(
      "the content of policies/exporter.json (policies/exporter.json:4, changed in this PR)",
    );
  });
});

describe("lines the AI review cites", () => {
  const ENV_SECRET = "Plain-Env-Secret-91";
  const STATE_SECRET = "State-Pw-77";

  it("links only Terraform sources (or a file a traced file() reads), never state, plans or credentials", async () => {
    const { planJson, repo, diff } = exporterCase({
      ".env": `TOKEN=x\nPLAIN=${ENV_SECRET}\n`,
      "terraform.tfstate": `{\n  "version": 4,\n  "password": "${STATE_SECRET}"\n}\n`,
      ".git/config": "[core]\n\tbare = false\n",
      "plan.json": JSON.stringify({ format_version: "1.2", resource_changes: [], token: STATE_SECRET }),
      "backup/state.json": JSON.stringify({
        version: 4,
        serial: 3,
        lineage: "x",
        resources: [],
        pw: STATE_SECRET,
      }),
      "notes.txt": `deploy key ${ENV_SECRET}\n`,
      "policies/other.json": '{ "Statement": [] }\n',
    });
    const refs = [
      { file: ".env", line: 2 },
      { file: "terraform.tfstate", line: 3 },
      { file: ".git/config", line: 1 },
      { file: "plan.json", line: 1 },
      { file: "backup/state.json", line: 1 },
      { file: "notes.txt", line: 1 },
      { file: "policies/other.json", line: 1 },
      { file: "iam.tf", line: 3 },
      { file: "policies/exporter.json", line: 4 },
    ];
    const { client } = scriptedClient([
      verdictReply({
        summary: "The exporter policy now allows s3:* on everything.",
        findings: [finding("aws_iam_policy.exporter", "high", refs)],
        dismissed: [],
      }),
    ]);
    const review = await reviewPlan({
      planJson,
      workspace: createFsWorkspace(repo, ""),
      diffText: diff,
      agent: agentOptions(client),
      maxFindings: 7,
    });
    const f = review.findings.find((x) => x.address === "aws_iam_policy.exporter");
    expect(f?.agentCauseLinks?.map((l) => `${l.location.file}:${l.location.startLine}`)).toEqual([
      "iam.tf:3",
      "policies/exporter.json:4",
    ]);
    expect(f?.causeLinks.every((l) => ["iam.tf", "policies/exporter.json"].includes(l.location.file))).toBe(
      true,
    );
    expect(review.warnings.join("\n")).toMatch(/cited 7 lines outside the Terraform sources/);
    const out = allRendered(review);
    for (const secret of [ENV_SECRET, STATE_SECRET, "[core]"]) expect(out).not.toContain(secret);
  });

  it("are kept apart from the lineage's links: [] when the agent cites nothing, absent on rules-only findings", async () => {
    const { planJson, repo, diff } = exporterCase();
    const run = async (agent: AgentOptions | null) =>
      reviewPlan({ planJson, workspace: createFsWorkspace(repo, ""), diffText: diff, agent, maxFindings: 7 });
    const rules = await run(null);
    expect(rules.findings[0]?.agentCauseLinks).toBeUndefined();
    const { client } = scriptedClient([
      verdictReply({
        summary: "s",
        findings: [finding("aws_iam_policy.exporter", "high", [])],
        dismissed: [],
      }),
    ]);
    const agent = await run(agentOptions(client));
    expect(agent.findings[0]?.agentCauseLinks).toEqual([]);
    // The merged links still carry the deterministic trace.
    expect(agent.findings[0]?.causeLinks.length).toBeGreaterThan(0);
  });
});

// ───────────────────────────── plan health ─────────────────────────────

function minimalPlan(extra: Record<string, unknown> = {}, changes: unknown[] = []): Record<string, unknown> {
  return {
    format_version: "1.2",
    terraform_version: "1.10.5",
    resource_changes: changes,
    configuration: { root_module: {} },
    ...extra,
  };
}

describe("plan health banners", () => {
  it("flags partial, errored and unapplyable plans", async () => {
    const workspace = createFsWorkspace(tempRepo({}), "");
    const partial = await reviewPlan({
      planJson: minimalPlan({ complete: false, applyable: true, errored: false }),
      workspace,
      diffText: "",
      agent: null,
      maxFindings: 7,
    });
    expect(partial.notices?.[0]).toMatch(/partial \(made with -target/);
    const deferred = loadPlan(minimalPlan({ deferred_changes: [{ reason: "provider_config_unknown" }] }));
    expect(deferred.complete).toBe(false);
    expect(planNotices(deferred)[0]).toMatch(/1 change is deferred/);
    const errored = loadPlan(minimalPlan({ errored: true, applyable: false, complete: false }));
    const notices = planNotices(errored);
    expect(notices[0]).toMatch(/errored/);
    // complete:false comes from the error, so there is no "-target" guess.
    expect(notices).toHaveLength(1);
    const erroredReview = await reviewPlan({
      planJson: minimalPlan({ errored: true, applyable: false, complete: false }),
      workspace,
      diffText: "",
      agent: null,
      maxFindings: 7,
    });
    expect(erroredReview.summary).not.toMatch(/^No changes: the infrastructure matches/);
    expect(erroredReview.summary).toMatch(/errored/);
    const noConfig = { ...minimalPlan() };
    delete noConfig.configuration;
    expect(loadPlan(noConfig).configurationMissing).toBe(true);
    expect(loadPlan(minimalPlan()).configurationMissing).toBeUndefined();
    expect(planNotices(loadPlan(noConfig))).toEqual([expect.stringMatching(/no configuration section/)]);
    expect(planNotices(loadPlan(minimalPlan({ applyable: false, complete: true })))).toEqual([
      expect.stringMatching(/not applyable/),
    ]);
    const comment = renderReviewComment([partial], { version: "test" });
    expect(comment).toContain("> [!WARNING]");
  });

  it("counts data source reads apart in the summary, as the headline does", async () => {
    const workspace = createFsWorkspace(tempRepo({}), "");
    const raw = (address: string, mode: string, actions: string[], before: unknown, after: unknown) => {
      const [type, name] = address.replace(/^data\./, "").split(".");
      return {
        address,
        mode,
        type,
        name,
        provider_name: "registry.terraform.io/hashicorp/aws",
        change: { actions, before, after, after_unknown: {} },
      };
    };
    const review = await reviewPlan({
      planJson: minimalPlan({}, [
        raw(
          "aws_ssm_parameter.p",
          "managed",
          ["update"],
          { value: "a", tags: {} },
          { value: "a", tags: { x: "1" } },
        ),
        raw("data.aws_caller_identity.me", "data", ["read"], null, {}),
      ]),
      workspace,
      diffText: "",
      agent: null,
      maxFindings: 7,
    });
    expect(review.summary).toMatch(/^None of the 1 change \(and 1 data source read\) needs your attention/);
    // The severity split covers the same 1 change, not the read.
    const split = /needs your attention \(([^)]*)\)/.exec(review.summary)?.[1] ?? "";
    const counted = [...split.matchAll(/(\d+) \w+/g)].reduce((n, m) => n + Number(m[1]), 0);
    expect(counted).toBe(1);
  });

  it("reviews a plan with no changes", async () => {
    const review = await reviewPlan({
      planJson: minimalPlan(),
      workspace: createFsWorkspace(tempRepo({}), ""),
      diffText: null,
      agent: null,
      maxFindings: 7,
    });
    expect(review.findings).toEqual([]);
    expect(review.others).toEqual([]);
    expect(review.summary).toMatch(/^No changes/);
    expect((review.notices ?? []).join(" ")).toMatch(/No PR diff was available/);
    expect(renderReviewComment([review], { version: "test" })).toContain("No changes.");
  });
});

describe("destroy plans and refresh-only plans", () => {
  const del = (address: string, before: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const [type = "", name = ""] = address.replace(/\[.*$/, "").split(".");
    return {
      address,
      mode: "managed",
      type,
      name,
      provider_name: type === "terraform_data" ? "terraform.io/builtin/terraform" : AWS,
      ...extra,
      change: {
        actions: ["delete"],
        before,
        after: null,
        after_unknown: {},
        before_sensitive: {},
        after_sensitive: false,
      },
    };
  };
  const configured = (address: string, extra: Record<string, unknown> = {}) => {
    const [type, name] = address.split(".");
    return { address, mode: "managed", type, name, expressions: {}, ...extra };
  };
  const diff = [
    "diff --git a/main.tf b/main.tf",
    "--- a/main.tf",
    "+++ b/main.tf",
    "@@ -1,3 +1,3 @@",
    ' resource "terraform_data" "gone" {',
    "-  count = 3",
    "+  count = 1",
    " }",
    "",
  ].join("\n");

  it("recognises a destroy plan: one banner, no moved-but-destroyed, no 'not caused by this PR'", async () => {
    const repo = tempRepo({
      "main.tf":
        'resource "terraform_data" "gone" {\n  count = 1\n}\nresource "terraform_data" "new_name" {}\nresource "aws_sqs_queue" "jobs" {\n  name = "jobs"\n}\n',
    });
    const review = await reviewPlan({
      planJson: minimalPlan(
        {
          configuration: {
            root_module: {
              resources: [
                configured("terraform_data.gone", { count_expression: { constant_value: 1 } }),
                configured("terraform_data.new_name"),
                configured("aws_sqs_queue.jobs"),
                configured("aws_db_instance.orders"),
              ],
            },
          },
        },
        [
          del("terraform_data.gone[0]", { id: "a", input: "x" }, { index: 0 }),
          del(
            "terraform_data.new_name",
            { id: "b", input: "y" },
            { previous_address: "terraform_data.old_name" },
          ),
          del("aws_sqs_queue.jobs", { name: "jobs" }),
          del("aws_db_instance.orders", { identifier: "orders" }),
        ],
      ),
      workspace: createFsWorkspace(repo, ""),
      diffText: diff,
      agent: null,
      maxFindings: 7,
    });
    expect(review.notices?.[0]).toMatch(/^This is a destroy plan/);
    const all = [...review.findings.flatMap((f) => f.signals), ...review.others.flatMap((o) => o.signals)];
    expect(all.map((s) => s.ruleId)).not.toContain("moved-but-destroyed");
    expect(all.map((s) => s.ruleId)).not.toContain("not-explained-by-diff");
    const queue = [
      ...review.findings,
      ...review.others.map((o) => ({ ...o, address: o.change.address })),
    ].find((x) => x.address === "aws_sqs_queue.jobs");
    expect(queue?.signals[0]?.reason).toContain("because this is a destroy plan");
    expect(review.findings.map((f) => f.address)).toContain("aws_db_instance.orders");
    for (const f of review.findings) expect(f.cause).toMatch(/^This is a destroy plan/);
    expect(review.summary).not.toMatch(/main\.tf/);
  });

  it("never takes a normal plan's deletes for a destroy plan", () => {
    const normal = loadPlan(
      minimalPlan({ configuration: { root_module: { resources: [configured("terraform_data.gone")] } } }, [
        del("terraform_data.gone[1]", { id: "a" }, { index: 1, action_reason: "delete_because_count_index" }),
      ]),
    );
    expect(planNotices(normal)).toEqual([]);
    // Removed from the configuration, no reason given: not a destroy plan either.
    const removed = loadPlan(
      minimalPlan({ configuration: { root_module: {} } }, [del("terraform_data.x", { id: "a" })]),
    );
    expect(planNotices(removed)).toEqual([]);
  });

  it("does not call an object that only moved to a new address 'changed outside Terraform'", async () => {
    const moved = {
      address: "terraform_data.new_name",
      previous_address: "terraform_data.old_name",
      mode: "managed",
      type: "terraform_data",
      name: "new_name",
      provider_name: "terraform.io/builtin/terraform",
      change: { actions: ["no-op"], before: { id: "a" }, after: { id: "a" }, after_unknown: {} },
    };
    const drifted = {
      ...moved,
      address: "terraform_data.other",
      previous_address: undefined,
      name: "other",
      change: {
        actions: ["update"],
        before: { id: "b", input: "1" },
        after: { id: "b", input: "2" },
        after_unknown: {},
      },
    };
    const review = (drift: unknown[]) =>
      reviewPlan({
        planJson: minimalPlan({ resource_drift: drift }),
        workspace: createFsWorkspace(tempRepo({}), ""),
        diffText: "",
        agent: null,
        maxFindings: 7,
      });
    expect((await review([moved])).summary).toBe("No changes: the infrastructure matches the configuration.");
    expect((await review([moved, drifted])).summary).toMatch(/detected 1 object changed outside Terraform/);
  });
});

// ───────────────────────────── PLAN-13 ─────────────────────────────

describe("prevent_destroy removed in the PR (PLAN-13)", () => {
  it("makes the destroy of a resource whose guard the PR removed critical", async () => {
    const repo = tempRepo({
      "main.tf": 'resource "aws_sqs_queue" "jobs" {\n  name = "jobs-v2"\n}\n',
    });
    const diff = [
      "diff --git a/main.tf b/main.tf",
      "--- a/main.tf",
      "+++ b/main.tf",
      "@@ -1,6 +1,3 @@",
      ' resource "aws_sqs_queue" "jobs" {',
      '-  name = "jobs"',
      "-  lifecycle {",
      "-    prevent_destroy = true",
      "-  }",
      '+  name = "jobs-v2"',
      " }",
      "",
    ].join("\n");
    const review = await reviewPlan({
      planJson: minimalPlan({}, [
        {
          address: "aws_sqs_queue.jobs",
          mode: "managed",
          type: "aws_sqs_queue",
          name: "jobs",
          provider_name: AWS,
          action_reason: "replace_because_cannot_update",
          change: {
            actions: ["delete", "create"],
            before: { name: "jobs" },
            after: { name: "jobs-v2" },
            after_unknown: {},
            before_sensitive: {},
            after_sensitive: {},
            replace_paths: [["name"]],
          },
        },
      ]),
      workspace: createFsWorkspace(repo, ""),
      diffText: diff,
      agent: null,
      maxFindings: 7,
    });
    const f = review.findings[0];
    expect(f?.severity).toBe("critical");
    expect(f?.signals.some((s) => s.ruleId === "prevent-destroy-removed")).toBe(true);
  });
});

// ───────────────────────────── attribute choice ─────────────────────────────

describe("traceAttributes", () => {
  const change = (over: Record<string, unknown>) =>
    ({
      change: {
        address: "a.b",
        action: "update",
        replacePaths: [],
        changedPaths: [],
        unknownPaths: [],
        sensitiveChangedPaths: [],
        ...over,
      },
      severity: "high",
      score: 100,
      signals: [],
    }) as unknown as ScoredChange;

  it("prefers signal paths, expands block-level ones to leaves, and puts tags last", () => {
    expect(
      traceAttributes({
        ...change({ changedPaths: [["alias", 0, "name"]] }),
        signals: [{ ruleId: "x", severity: "high", reason: "", path: ["alias"] }],
      }),
    ).toEqual([["alias", 0, "name"]]);
    expect(
      traceAttributes(
        change({
          changedPaths: [
            ["tags_all", "Team"],
            ["ingress", 0, "cidr_blocks"],
          ],
        }),
      ),
    ).toEqual([
      ["ingress", 0, "cidr_blocks"],
      ["tags_all", "Team"],
    ]);
    expect(
      traceAttributes(change({ action: "replace", replacePaths: [["name"], ["protocol_version"]] })),
    ).toEqual([["name"], ["protocol_version"]]);
    expect(traceAttributes(change({ action: "delete" }))).toEqual([undefined]);
  });
});

// ───────────────────────────── scale ─────────────────────────────

describe("a 5,000-change plan", () => {
  it("is reviewed in seconds, tracing at most MAX_TRACED candidates", async () => {
    const changes: unknown[] = [];
    const resources: unknown[] = [];
    for (let i = 0; i < 5000; i++) {
      const replace = i % 50 === 0;
      changes.push({
        address: `aws_sqs_queue.q${i}`,
        mode: "managed",
        type: "aws_sqs_queue",
        name: `q${i}`,
        provider_name: AWS,
        ...(replace && { action_reason: "replace_because_cannot_update" }),
        change: {
          actions: replace ? ["delete", "create"] : ["update"],
          before: { name: `q-${i}`, tags: { Team: "a" }, tags_all: { Team: "a" } },
          after: replace
            ? { name: `q-${i}-v2`, tags: { Team: "a" }, tags_all: { Team: "a" } }
            : { name: `q-${i}`, tags: { Team: "b" }, tags_all: { Team: "b" } },
          after_unknown: {},
          before_sensitive: {},
          after_sensitive: {},
          ...(replace && { replace_paths: [["name"]] }),
        },
      });
      resources.push({
        address: `aws_sqs_queue.q${i}`,
        mode: "managed",
        type: "aws_sqs_queue",
        name: `q${i}`,
        expressions: { name: { constant_value: `q-${i}` } },
      });
    }
    const repo = tempRepo({
      "main.tf": Array.from(
        { length: 5000 },
        (_, i) => `resource "aws_sqs_queue" "q${i}" {\n  name = "q-${i}"\n}\n`,
      ).join(""),
    });
    const started = performance.now();
    const review = await reviewPlan({
      planJson: minimalPlan({ configuration: { root_module: { resources } } }, changes),
      workspace: createFsWorkspace(repo, ""),
      diffText: "",
      agent: null,
      maxFindings: 7,
    });
    const seconds = (performance.now() - started) / 1000;
    expect(review.stats.totalChanges).toBe(5000);
    expect(review.findings.length).toBeLessThanOrEqual(7);
    expect(
      review.findings.length +
        review.others.length +
        review.findings.reduce((n, f) => n + (f.relatedAddresses?.length ?? 0), 0),
    ).toBe(5000);
    expect(review.warnings.some((w) => w.includes(`Traced the ${MAX_TRACED} highest-ranked`))).toBe(true);
    expect(seconds).toBeLessThan(20);
  }, 60_000);
});

describe("replace_triggered_by", () => {
  it("follows lifecycle.replace_triggered_by to the watched resource and the line that changed it", async () => {
    const repo = tempRepo({
      "main.tf": [
        'resource "terraform_data" "schema_version" {',
        '  input = "v2"',
        "}",
        "",
        'resource "aws_instance" "worker" {',
        '  ami           = "ami-123"',
        '  instance_type = "t3.small"',
        "  lifecycle {",
        "    replace_triggered_by = [terraform_data.schema_version]",
        "  }",
        "}",
        "",
      ].join("\n"),
    });
    const diff = [
      "diff --git a/main.tf b/main.tf",
      "--- a/main.tf",
      "+++ b/main.tf",
      "@@ -1,3 +1,3 @@",
      ' resource "terraform_data" "schema_version" {',
      '-  input = "v1"',
      '+  input = "v2"',
      " }",
      "",
    ].join("\n");
    const review = await reviewPlan({
      planJson: minimalPlan(
        {
          configuration: {
            root_module: {
              resources: [
                {
                  address: "terraform_data.schema_version",
                  mode: "managed",
                  type: "terraform_data",
                  name: "schema_version",
                  expressions: { input: { constant_value: "v2" } },
                },
                {
                  address: "aws_instance.worker",
                  mode: "managed",
                  type: "aws_instance",
                  name: "worker",
                  expressions: { ami: { constant_value: "ami-123" } },
                },
              ],
            },
          },
        },
        [
          {
            address: "terraform_data.schema_version",
            mode: "managed",
            type: "terraform_data",
            name: "schema_version",
            provider_name: "terraform.io/builtin/terraform",
            action_reason: "replace_because_cannot_update",
            change: {
              actions: ["delete", "create"],
              before: { input: "v1", output: "v1" },
              after: { input: "v2" },
              after_unknown: { output: true },
              before_sensitive: {},
              after_sensitive: {},
              replace_paths: [["input"]],
            },
          },
          {
            address: "aws_instance.worker",
            mode: "managed",
            type: "aws_instance",
            name: "worker",
            provider_name: AWS,
            action_reason: "replace_by_triggers",
            change: {
              actions: ["delete", "create"],
              before: { ami: "ami-123", id: "i-1" },
              after: { ami: "ami-123" },
              after_unknown: { id: true },
              before_sensitive: {},
              after_sensitive: {},
            },
          },
        ],
      ),
      workspace: createFsWorkspace(repo, ""),
      diffText: diff,
      agent: null,
      maxFindings: 7,
    });
    const worker = review.findings.find((f) => f.address === "aws_instance.worker");
    expect(worker?.lineage?.explanation).toBe("diff");
    expect(worker?.cause).toMatch(/^lifecycle\.replace_triggered_by replaces it/);
    expect(worker?.cause).toContain("terraform_data.schema_version input (main.tf:2, changed in this PR)");
    expect(worker?.causeLinks.some((l) => l.location.startLine === 2 && l.changedInDiff)).toBe(true);
  });
});
