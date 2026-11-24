/*
 * Shared contract between the modules. Every module codes against these types; change them only
 * together with every user.
 *
 * Pipeline: plan JSON ──load+mask──▶ PlanModel ──score──▶ ScoredChange[] ──trace──▶ Lineage
 *           PR diff ──parse──▶ DiffIndex ─────────────────────────────────────────┘
 *           ──(optional) agent──▶ AgentVerdict ──merge──▶ Review ──render──▶ markdown / JSON
 */

// ───────────────────────────── plan ─────────────────────────────

/** One step of an attribute path, as in replace_paths: an attribute/map key, or a list/set index. */
export type PathStep = string | number;
export type AttrPath = PathStep[];

/** Normalized action of one resource instance change. */
export type Action =
  | "create"
  | "update"
  | "delete"
  | "replace" // destroy-then-create or create-then-destroy
  | "read" // data source read during apply
  | "no-op"
  | "forget" // removed from state without destroying (removed block, lifecycle { destroy = false })
  | "import" // no-op/update with `importing`
  | "move"; // no-op with previous_address

export interface ResourceChange {
  /** Full instance address, e.g. `module.db.aws_db_instance.this` or `aws_s3_bucket.logs["a"]`. */
  address: string;
  /** Instance address of the containing module, e.g. `module.a["x"].module.b`; null for the root module. */
  moduleAddress: string | null;
  /** Module call names from the root with instance keys stripped, e.g. ["a", "b"]; [] for root. */
  configModulePath: string[];
  mode: "managed" | "data";
  type: string;
  name: string;
  /** count index or for_each key, when present. */
  index?: string | number;
  providerName: string;
  /** Set when a `moved` block (or refactoring) changed the address. */
  previousAddress?: string;
  /** Deposed object key, for create_before_destroy leftovers. */
  deposed?: string;
  /** Raw change.actions, e.g. ["delete","create"]. */
  actions: string[];
  action: Action;
  /** For replace: which side happens first. */
  replaceOrder?: "destroy-before-create" | "create-before-destroy";
  /** Raw action_reason, e.g. replace_because_cannot_update, delete_because_no_module. */
  actionReason?: string;
  /** Attribute paths that forced replacement (from replace_paths). */
  replacePaths: AttrPath[];
  /** Present when the plan imports this resource. */
  importing?: { id?: string };
  /** Values with every sensitive value replaced by SENSITIVE_PLACEHOLDER (see plan/mask.ts). */
  before: unknown;
  after: unknown;
  /** after_unknown marks: true at a path = known only after apply. */
  afterUnknown: unknown;
  /** Leaf attribute paths whose known value changes (before ≠ after), sorted. See plan/paths.ts diffPaths. */
  changedPaths: AttrPath[];
  /** Paths that become unknown after apply (every computed attribute of a replaced resource lands here). */
  unknownPaths: AttrPath[];
  /** Attribute paths whose sensitivity changed or whose value is sensitive and changed (value hidden). */
  sensitiveChangedPaths: AttrPath[];
}

export interface OutputChange {
  name: string;
  actions: string[];
  sensitive: boolean;
}

/** Index over plan.configuration, one node per module (root = path []). */
export interface ConfigModule {
  /** Module call names from root, e.g. ["orders_db"]. */
  path: string[];
  /** `source` of the module call that created it (undefined for root). */
  source?: string;
  /** `version` constraint of the module call (registry modules). */
  version?: string;
  /** Raw configuration objects from the plan, keyed by relative address `type.name` (managed) or `data.type.name`. */
  resources: Record<string, ConfigResource>;
  /** Module calls made by this module, keyed by call name. */
  moduleCalls: Record<string, ConfigModuleCall>;
  /** Declared input variables: name → { default?, sensitive?, description? } (masked). */
  variables: Record<string, { default?: unknown; sensitive?: boolean; description?: string }>;
  /** Declared outputs: name → expression. */
  outputs: Record<string, { expression?: Expression; sensitive?: boolean }>;
}

export interface ConfigResource {
  address: string;
  mode: "managed" | "data";
  type: string;
  name: string;
  /** Attribute name → Expression, or → Expression-map[] for nested blocks (as in the plan JSON). */
  expressions: Record<string, unknown>;
  countExpression?: Expression;
  forEachExpression?: Expression;
}

export interface ConfigModuleCall {
  name: string;
  source: string;
  version?: string;
  expressions: Record<string, unknown>;
  countExpression?: Expression;
  forEachExpression?: Expression;
}

/** A plan-JSON expression: a constant, a list of references, or both absent (computed/complex). */
export interface Expression {
  constant_value?: unknown;
  references?: string[];
}

export interface PlanModel {
  formatVersion: string;
  terraformVersion: string;
  /** Every resource instance change, no-ops included (filter with `action`). */
  changes: ResourceChange[];
  /** resource_drift: changes detected outside Terraform since the last apply. */
  drift: ResourceChange[];
  outputChanges: OutputChange[];
  /** Root input variable values, masked when sensitive. */
  variables: Record<string, { value: unknown; sensitive: boolean }>;
  /** Configuration index keyed by module path joined with "." ("" for root). */
  modules: Record<string, ConfigModule>;
  /** Provider version constraints keyed by provider config key, e.g. "aws" → "~> 6.0". */
  providerConstraints: Record<string, string>;
  errored: boolean;
  /**
   * False when the plan is partial: `-target`, or changes deferred to a later plan
   * (`deferred_changes`). Undefined when the plan does not say (OpenTofu, Terraform < 1.8).
   */
  complete?: boolean;
  /** False when the plan cannot be applied. Undefined when the plan does not say. */
  applyable?: boolean;
  /** Number of `deferred_changes` entries (0 when absent). */
  deferredChanges?: number;
  /**
   * True when the plan JSON has no `configuration` section (a trimmed or hand-built plan), so
   * resource blocks and module calls are known only from the repository's HCL.
   */
  configurationMissing?: boolean;
  /**
   * Counts of non-no-op changes by normalized action. As in Terraform's "Plan:" line, a
   * forget+create also counts as a create and an import+update as an update, so the counts can
   * sum to more than the number of changes.
   */
  counts: Partial<Record<Action, number>>;
}

// ───────────────────────────── risk ─────────────────────────────

export type Severity = "critical" | "high" | "medium" | "low" | "noise";

export const SEVERITY_ORDER: readonly Severity[] = ["critical", "high", "medium", "low", "noise"];

export interface RiskSignal {
  /** Stable rule id, e.g. "stateful-replace", "sg-open-world", "deletion-protection-off". */
  ruleId: string;
  severity: Severity;
  /** One sentence a reviewer would understand: what changes and why it matters. */
  reason: string;
  /** The attribute this signal is about, when it is attribute-specific. */
  path?: AttrPath;
}

export interface ScoredChange {
  change: ResourceChange;
  /** Highest severity among the signals ("low" when there are none, "noise" for known noise). */
  severity: Severity;
  /** Sortable score: higher = more attention. Severity dominates; ties broken by signal count etc. */
  score: number;
  signals: RiskSignal[];
}

// ───────────────────────────── source + diff ─────────────────────────────

/** Repo-relative file + 1-based inclusive line range in the HEAD (new) version of the file. */
export interface SourceLocation {
  file: string;
  startLine: number;
  endLine: number;
  /** "base" = line numbers in the PR's BASE version (code the PR deleted). Default: head. */
  side?: "base";
}

export interface FileDiff {
  /** New path (repo-relative); for deletions, the old path. */
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  /** New-file line numbers of added lines. */
  addedLines: Set<number>;
  /** Old-file line numbers of removed lines. */
  removedLines: Set<number>;
  /**
   * For each removal, the new-file line it sits before (deleted lines leave no new line; this lets a
   * block whose attribute was deleted count as changed).
   */
  removalAnchors: Set<number>;
}

export interface DiffIndex {
  files: Map<string, FileDiff>;
  /**
   * True when the PR changes lines [start, end] of `file`: an added line inside the span, a removal
   * strictly between two of its lines, or a new file. (The line just before a deletion is not.)
   */
  touches(file: string, startLine: number, endLine: number): boolean;
}

/** Read-only access to the repository checkout at the PR head. */
export interface Workspace {
  /** Absolute path of the repository root. */
  root: string;
  /** Repo-relative directory of the root module the plan was made from ("" or "." = repo root). */
  rootModuleDir: string;
  /** File text, or null when missing/unreadable/outside the repo/too large. */
  readFile(repoPath: string): Promise<string | null>;
  /** Repo-relative paths of files in a directory (non-recursive) matching the suffixes. */
  listFiles(repoDir: string, suffixes: readonly string[]): Promise<string[]>;
}

// ───────────────────────────── lineage ─────────────────────────────

export type LineageStepKind =
  | "resource_attribute" // the attribute expression inside the resource block
  | "resource_block" // the whole resource block (creates, deletes)
  | "module_input" // an argument of a module call
  | "module_output" // an output of a child module
  | "module_source" // a module call's source/version
  | "variable_default" // default of a variable declaration
  | "variable_value" // root variable value set in a .tfvars file
  | "local" // a locals entry
  | "count_for_each" // count / for_each expression
  | "upstream_resource" // another resource whose change flows into this one
  | "provider_config" // provider block (e.g. default_tags) or provider version
  | "removed_code" // code deleted by the PR (deletes)
  | "file_content" // a file read by file()/templatefile()/… (policy JSON, user data, templates)
  | "unresolved"; // could not follow further (data source, function result, remote module…)

export interface LineageStep {
  /** Stable id within one Lineage: "s0", "s1", … in trace order. */
  id: string;
  kind: LineageStepKind;
  /** Config module path where this step's code lives. */
  modulePath: string[];
  /** Human label, e.g. `module "orders_db" argument encrypted`. */
  label: string;
  /** Source text of the expression/assignment, trimmed and masked (≤ 300 chars). */
  snippet?: string;
  /** References this step's expression makes (plan-JSON style, e.g. "var.encrypted"). */
  references: string[];
  location?: SourceLocation;
  /** True when the PR diff touches `location`. */
  changedInDiff: boolean;
  /** For upstream_resource: the address of the other resource change. */
  upstreamAddress?: string;
  /**
   * The step whose expression references this one (the next step toward the changed resource);
   * absent for the traced attributes themselves. Steps form a tree: an attribute can read several
   * inputs, and only the branches that reach a root cause explain the change.
   */
  parentId?: string;
  /**
   * Other steps that also reference this one (a variable or local read by several traced
   * attributes is traced once; each reader's branch continues through it).
   */
  alsoParentIds?: string[];
  /** For resource_attribute steps: the attribute path traced (index into the plan's values). */
  path?: AttrPath;
}

export interface Lineage {
  address: string;
  /** The attribute traced; [] = the whole resource (create/delete). */
  attribute: AttrPath;
  /** Ordered from the resource outward (s0 = the resource's own attribute/block). */
  steps: LineageStep[];
  /** Ids of the steps the PR changed that best explain the change, most upstream first. */
  rootCauseIds: string[];
  /**
   * How the change is explained:
   * - "diff": a PR change explains it (rootCauseIds non-empty)
   * - "upstream": another resource's change explains it
   * - "external": no code in the PR explains it (drift, provider/module upgrade, tfvars outside the repo, -var)
   * - "unknown": tracing stopped before an explanation
   */
  explanation: "diff" | "upstream" | "external" | "unknown";
  /** Short notes on where tracing stopped or what was assumed. */
  notes: string[];
  /** The deposed object's key when the traced change destroys a deposed object. */
  deposed?: string;
}

// ───────────────────────────── findings + review ─────────────────────────────

export type Confidence = "high" | "medium" | "low";

export interface CauseLink {
  location: SourceLocation;
  /** Short label, e.g. `main.tf:12 encrypted = var.orders_db_encrypted`. */
  label: string;
  /** True when this line is part of the PR diff. */
  changedInDiff: boolean;
}

export interface Finding {
  /** Stable id: hash of address + primary rule, so reviewer feedback maps across re-runs. */
  id: string;
  address: string;
  action: Action;
  severity: Exclude<Severity, "noise" | "low">;
  /** ≤ 100 chars: what happens, e.g. "Production database orders-prod will be destroyed and re-created". */
  title: string;
  /** Why it matters (impact). */
  impact: string;
  /** Why it happens, in words: attribute → input → changed line. */
  cause: string;
  causeLinks: CauseLink[];
  /**
   * The lines the AI review itself cited, after validation (causeLinks merges them with the
   * lineage's): undefined for a rules-only finding, [] when the agent cited none. For grading the
   * agent's citations apart from the deterministic trace.
   */
  agentCauseLinks?: CauseLink[];
  lineage?: Lineage;
  signals: RiskSignal[];
  confidence: Confidence;
  /** Who raised it: deterministic rules, the agent, or both agreeing. */
  origin: "rules" | "agent" | "both";
  /**
   * Other changes of the same type, action and severity that the same root cause explains (one
   * module input fanning out to many resources). This finding stands for all of them.
   */
  relatedAddresses?: string[];
  /** The same addresses with their own action and severity, for display (same order). */
  relatedChanges?: RelatedChange[];
}

export interface RelatedChange {
  address: string;
  action: Action;
  severity: Severity;
}

export interface ReviewStats {
  totalChanges: number;
  counts: Partial<Record<Action, number>>;
  bySeverity: Partial<Record<Severity, number>>;
}

export interface AgentRunInfo {
  model: string;
  turns: number;
  toolCalls: number;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  /** "complete" | "budget" | "timeout" | "max_turns" | "refusal" | "error" | "skipped" */
  status: string;
  error?: string;
}

export interface Review {
  /** Repo-relative root module dir the plan belongs to. */
  rootModuleDir: string;
  findings: Finding[];
  /** Every other non-no-op change, highest score first, for the collapsed section. */
  others: ScoredChange[];
  stats: ReviewStats;
  /** One-paragraph overview (agent summary, or a deterministic one). */
  summary: string;
  agent?: AgentRunInfo;
  /**
   * Plan-level problems a reviewer must see before anything else (partial plan, errored plan, plan
   * that cannot be applied). Rendered as a banner above the findings.
   */
  notices?: string[];
  /**
   * The plan errored or is partial (`errored`, or `complete: false`): no changes in it does not mean
   * the infrastructure matches the configuration. Set by the action and the CLI from the plan JSON.
   */
  planIncomplete?: boolean;
  warnings: string[];
}

/** Value used in place of every sensitive or secret-looking value. */
export const SENSITIVE_PLACEHOLDER = "(sensitive)";

// ───────────────────────────── agent ─────────────────────────────

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  debug?(message: string): void;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentOptions {
  /** Default "claude-opus-5-5". */
  model: string;
  apiKey: string;
  effort: Effort;
  maxTurns: number;
  maxCostUsd: number;
  timeoutMs: number;
  extraInstructions?: string;
  logger?: Logger;
  /** Injected Anthropic client (tests). Typed loosely here to keep types.ts SDK-free. */
  client?: unknown;
}

/** What the agent's read-only tools can see. Built by review.ts. */
export interface AgentToolContext {
  plan: PlanModel;
  /** Every non-no-op change, score descending. */
  scored: ScoredChange[];
  /** Lineage for a change (optionally one attribute); null when the address is not a change. */
  getLineage(address: string, attribute?: AttrPath): Promise<Lineage | null>;
  workspace: Workspace;
  /** The PR diff text (masked by the tool before it is returned), or null when unavailable. */
  diffText: string | null;
}

export interface AgentInput {
  ctx: AgentToolContext;
  /** Deterministic candidates (critical/high/medium), each with its primary lineage. */
  candidates: { scored: ScoredChange; lineage: Lineage | null }[];
}

export interface AgentFinding {
  address: string;
  severity: "critical" | "high" | "medium";
  title: string;
  impact: string;
  cause: string;
  causeRefs: { file: string; line: number }[];
  confidence: Confidence;
}

export interface AgentVerdict {
  summary: string;
  findings: AgentFinding[];
  dismissed: { address: string; reason: string }[];
}

export interface AgentOutcome {
  verdict: AgentVerdict | null;
  info: AgentRunInfo;
}

// ───────────────────────────── review + report ─────────────────────────────

export interface ReviewInput {
  /** Parsed `terraform show -json` output (see plan/load.ts parsePlanText for raw text). */
  planJson: unknown;
  workspace: Workspace;
  /** Unified diff of the PR (base...head), or null when unavailable. */
  diffText: string | null;
  /** null = deterministic only (no API key, or disabled). */
  agent: AgentOptions | null;
  /** Max findings in "Needs your attention" (default 7). */
  maxFindings: number;
  logger?: Logger;
}

export interface ReportMeta {
  /** For permalinks; absent in local CLI runs (links become `file:line`). */
  repo?: { owner: string; name: string; serverUrl: string };
  headSha?: string;
  /** For links to code the PR deleted (base-side locations). */
  baseSha?: string;
  prNumber?: number;
  run?: { id: number; attempt: number; url?: string };
  version: string;
  /** Run-level warnings (e.g. about the PR diff), shown once rather than per root module. */
  warnings?: string[];
}
