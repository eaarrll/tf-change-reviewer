import type {
  Action,
  AgentRunInfo,
  Finding,
  Lineage,
  LineageStep,
  ReportMeta,
  ResourceChange,
  Review,
  RiskSignal,
  ScoredChange,
  Severity,
} from "../../src/types.js";

export const HEAD = "0123456789abcdef0123456789abcdef01234567";
export const BASE = "fedcba9876543210fedcba9876543210fedcba98";
export const BLOB = `https://github.com/example-org/infra/blob/${HEAD}`;
export const BASE_BLOB = `https://github.com/example-org/infra/blob/${BASE}`;

export function makeMeta(overrides: Partial<ReportMeta> = {}): ReportMeta {
  return {
    repo: { owner: "example-org", name: "infra", serverUrl: "https://github.com" },
    headSha: HEAD,
    baseSha: BASE,
    prNumber: 42,
    run: { id: 9001, attempt: 1, url: "https://github.com/example-org/infra/actions/runs/9001" },
    version: "v0.1.0",
    ...overrides,
  };
}

export function makeChange(
  address: string,
  action: Action,
  overrides: Partial<ResourceChange> = {},
): ResourceChange {
  const parts = address.replace(/\[[^\]]*\]$/, "").split(".");
  const name = parts.at(-1) ?? "this";
  const type = parts.at(-2) ?? "null_resource";
  return {
    address,
    moduleAddress: null,
    configModulePath: [],
    mode: "managed",
    type,
    name,
    providerName: "registry.terraform.io/hashicorp/aws",
    actions: action === "replace" ? ["delete", "create"] : [action],
    action,
    replacePaths: [],
    before: {},
    after: {},
    afterUnknown: {},
    changedPaths: [],
    unknownPaths: [],
    sensitiveChangedPaths: [],
    ...overrides,
  };
}

export function scored(
  change: ResourceChange,
  severity: Severity,
  signals: RiskSignal[] = [],
  score = 10,
): ScoredChange {
  return { change, severity, score, signals };
}

/** The real db-encryption-replace story: a module input flips storage_encrypted and forces a replacement. */
export function dbLineage(): Lineage {
  const steps: LineageStep[] = [
    {
      id: "s0",
      kind: "resource_attribute",
      modulePath: ["orders_db"],
      label: "aws_db_instance.this storage_encrypted",
      snippet: "storage_encrypted = var.encrypted",
      references: ["var.encrypted"],
      location: { file: "modules/db/main.tf", startLine: 24, endLine: 24 },
      changedInDiff: false,
    },
    {
      id: "s1",
      kind: "module_input",
      modulePath: [],
      label: 'module "orders_db" argument encrypted',
      snippet: "encrypted = false",
      references: [],
      location: { file: "main.tf", startLine: 12, endLine: 12 },
      changedInDiff: true,
    },
  ];
  return {
    address: "module.orders_db.aws_db_instance.this",
    attribute: ["storage_encrypted"],
    steps,
    rootCauseIds: ["s1"],
    explanation: "diff",
    notes: [],
  };
}

export function dbFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "f-3a9c1e07",
    address: "module.orders_db.aws_db_instance.this",
    action: "replace",
    severity: "critical",
    title: "Production database orders-prod will be destroyed and re-created",
    impact: "All data in orders-prod is lost unless restored from a snapshot; the app is down meanwhile.",
    cause: "`storage_encrypted` cannot change in place; the PR sets the module input `encrypted = false`.",
    causeLinks: [
      {
        location: { file: "main.tf", startLine: 12, endLine: 12 },
        label: "main.tf:12 encrypted = false",
        changedInDiff: true,
      },
    ],
    lineage: dbLineage(),
    signals: [
      {
        ruleId: "stateful-replace",
        severity: "critical",
        reason: "aws_db_instance is replaced: its data is destroyed.",
        path: ["storage_encrypted"],
      },
      { ruleId: "force-new-attribute", severity: "high", reason: "storage_encrypted forces replacement." },
    ],
    confidence: "high",
    origin: "both",
    ...overrides,
  };
}

export function sgFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "f-77b2d410",
    address: 'aws_security_group_rule.ingress["ssh"]',
    action: "create",
    severity: "high",
    title: "SSH open to the internet",
    impact: "Port 22 becomes reachable from 0.0.0.0/0.",
    cause: "A new rule allows 0.0.0.0/0 on port 22.",
    causeLinks: [
      {
        location: { file: "network.tf", startLine: 40, endLine: 47 },
        label: "network.tf:40-47",
        changedInDiff: true,
      },
    ],
    signals: [{ ruleId: "sg-open-world", severity: "high", reason: "Ingress from 0.0.0.0/0 on port 22." }],
    confidence: "medium",
    origin: "rules",
    ...overrides,
  };
}

export function agentInfo(overrides: Partial<AgentRunInfo> = {}): AgentRunInfo {
  return {
    model: "claude-opus-5-5",
    turns: 6,
    toolCalls: 9,
    costUsd: 0.4213,
    inputTokens: 52_000,
    outputTokens: 3_100,
    durationMs: 48_200,
    status: "complete",
    ...overrides,
  };
}

/** Noise-heavy "others": tag-only updates, log retention changes, a few ordinary updates. */
export function typicalOthers(): ScoredChange[] {
  const others: ScoredChange[] = [];
  others.push(
    scored(
      makeChange("aws_iam_role_policy.app", "update", { changedPaths: [["policy"]] }),
      "medium",
      [{ ruleId: "iam-policy-change", severity: "medium", reason: "IAM policy document changes." }],
      40,
    ),
  );
  others.push(
    scored(makeChange("aws_s3_bucket.assets", "create"), "low", [], 5),
    scored(
      makeChange("aws_lambda_function.api", "update", { changedPaths: [["memory_size"]] }),
      "low",
      [],
      4,
    ),
  );
  for (let i = 0; i < 20; i++) {
    others.push(
      scored(
        makeChange(`aws_s3_bucket.data[${i}]`, "update", {
          changedPaths: [
            ["tags", "team"],
            ["tags_all", "team"],
          ],
        }),
        "noise",
      ),
    );
  }
  for (let i = 0; i < 4; i++) {
    others.push(
      scored(makeChange(`aws_sqs_queue.q${i}`, "update", { changedPaths: [["tags_all", "env"]] }), "noise"),
    );
  }
  for (let i = 0; i < 8; i++) {
    others.push(
      scored(
        makeChange(`aws_cloudwatch_log_group.svc${i}`, "update", { changedPaths: [["retention_in_days"]] }),
        "noise",
      ),
    );
  }
  return others;
}

export function makeReview(overrides: Partial<Review> = {}): Review {
  const findings = overrides.findings ?? [dbFinding(), sgFinding()];
  const others = overrides.others ?? typicalOthers();
  return {
    rootModuleDir: "",
    findings,
    others,
    stats: {
      totalChanges: findings.length + others.length,
      counts: { create: 2, update: 34, replace: 1 },
      bySeverity: { critical: 1, high: 1, medium: 1, low: 2, noise: 32 },
    },
    summary: "One database replacement destroys data; the rest is tag and retention churn.",
    agent: agentInfo(),
    warnings: [],
    ...overrides,
  };
}
