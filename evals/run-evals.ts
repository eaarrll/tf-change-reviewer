/**
 * Offline eval harness: reviews every labeled fixture under evals/fixtures with reviewPlan (rules only,
 * or rules + agent), grades the findings against labels.json and writes a report. See evals/README.md.
 *
 *   npm run eval -- --rules-only
 *   npm run eval -- --model claude-opus-5-5 --effort high --repeat 3 --budget-usd 5
 */
import { constants, existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Effort, Logger, Review, ReviewInput, Workspace } from "../src/types.js";
import { DEFAULT_EFFORT, DEFAULT_MODEL as AGENT_DEFAULT_MODEL } from "../src/agent/agent.js";
import { aggregate, fixtureSet, gradeFixture, parseLabels, setOfName } from "./grade.js";
import type { FixtureGrade, FixtureSet, Labels, LinkPrecision, Summary } from "./grade.js";

const EVALS_DIR = fileURLToPath(new URL(".", import.meta.url));
export const FIXTURES_DIR = join(EVALS_DIR, "fixtures");
export const DEFAULT_OUT_DIR = join(EVALS_DIR, "results");
/** The same defaults as the CLI and the Action, so eval results describe production runs. */
export const DEFAULT_MODEL = AGENT_DEFAULT_MODEL;
const MAX_FINDINGS = 7;
const MAX_TURNS = 12;
const CASE_TIMEOUT_MS = 300_000;

// ───────────────────────────── command line ─────────────────────────────

export interface EvalOptions {
  mode: "model" | "rules";
  /** null in rules mode. */
  model: string | null;
  effort: Effort;
  /** Fixture names to run; null = all. */
  fixtures: string[] | null;
  /** Which labeled set to run: dev, holdout, or both ("all"). */
  set: FixtureSet | "all";
  /** Print FP/FN addresses of holdout fixtures (off: the holdout set stays blind). */
  showHoldout: boolean;
  /** Agent budget per review. */
  maxCostUsd: number;
  /** Stop the run once the running total exceeds this; null = no limit. */
  budgetUsd: number | null;
  repeat: number;
  /** Absolute output directory. */
  outDir: string;
  /** File-name-safe: "rules" or the model id. */
  label: string;
}

export type CliCommand = { kind: "help" } | { kind: "run"; options: EvalOptions };

/** Bad command-line input: printed with the usage text, exit code 1. */
export class UsageError extends Error {
  override name = "UsageError";
}

export const USAGE = `Usage: npm run eval -- [options]

  --model <id>          Review with rules + the agent on this model (default ${DEFAULT_MODEL})
  --rules-only          Deterministic rules + lineage only: no API key, no cost
  --fixtures <names>    Comma-separated fixture names (default: all)
  --set <set>           dev | holdout | all (default all); results are reported per set
  --show-holdout        Name the FP/FN addresses of holdout fixtures (default: counts only)
  --effort <level>      low | medium | high | xhigh | max (default ${DEFAULT_EFFORT})
  --max-cost <usd>      Agent budget per review (default 0.5)
  --budget-usd <usd>    Stop the run once its total cost exceeds this
  --repeat <n>          Reviews per fixture, to measure variance (default 1)
  --out <dir>           Output directory (default evals/results)
  -h, --help            Show this help

The model mode needs ANTHROPIC_API_KEY.`;

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

export function parseCliArgs(argv: readonly string[], cwd: string = process.cwd()): CliCommand {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        model: { type: "string" },
        "rules-only": { type: "boolean", default: false },
        fixtures: { type: "string", multiple: true },
        set: { type: "string", default: "all" },
        "show-holdout": { type: "boolean", default: false },
        effort: { type: "string", default: DEFAULT_EFFORT },
        "max-cost": { type: "string", default: "0.5" },
        "budget-usd": { type: "string" },
        repeat: { type: "string", default: "1" },
        out: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (err) {
    throw new UsageError(errorMessage(err));
  }
  if (values.help) return { kind: "help" };

  const rulesOnly = values["rules-only"];
  if (rulesOnly && values.model !== undefined) throw new UsageError("--model and --rules-only conflict");
  const model = rulesOnly ? null : (values.model ?? DEFAULT_MODEL).trim();
  if (model === "") throw new UsageError("--model must not be empty");

  return {
    kind: "run",
    options: {
      mode: rulesOnly ? "rules" : "model",
      model,
      effort: parseEffort(values.effort),
      fixtures: values.fixtures === undefined ? null : parseNameList(values.fixtures),
      set: parseSet(values.set),
      showHoldout: values["show-holdout"],
      maxCostUsd: parsePositiveNumber("--max-cost", values["max-cost"]),
      budgetUsd:
        values["budget-usd"] === undefined ? null : parsePositiveNumber("--budget-usd", values["budget-usd"]),
      repeat: parsePositiveInt("--repeat", values.repeat),
      outDir: values.out === undefined ? DEFAULT_OUT_DIR : resolve(cwd, values.out),
      label: model === null ? "rules" : sanitizeLabel(model),
    },
  };
}

function parseSet(value: string): FixtureSet | "all" {
  if (value === "dev" || value === "holdout" || value === "all") return value;
  throw new UsageError(`--set must be one of dev, holdout, all; got "${value}"`);
}

function parseEffort(value: string): Effort {
  const effort = EFFORTS.find((e) => e === value);
  if (effort === undefined)
    throw new UsageError(`--effort must be one of ${EFFORTS.join(", ")}; got "${value}"`);
  return effort;
}

function parseNameList(values: string[]): string[] {
  const names = [...new Set(values.flatMap((v) => v.split(",")).map((n) => n.trim()))].filter(
    (n) => n !== "",
  );
  if (names.length === 0) throw new UsageError("--fixtures needs at least one fixture name");
  return names;
}

function parsePositiveInt(flag: string, value: string): number {
  const n = /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < 1)
    throw new UsageError(`${flag} must be a positive integer; got "${value}"`);
  return n;
}

function parsePositiveNumber(flag: string, value: string): number {
  const n = value.trim() === "" ? NaN : Number(value);
  if (!Number.isFinite(n) || n <= 0)
    throw new UsageError(`${flag} must be a positive number; got "${value}"`);
  return n;
}

/** Labels become file names, so anything outside [A-Za-z0-9._-] is replaced. */
export function sanitizeLabel(label: string): string {
  const safe = label
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/^[.-]+/, "");
  if (safe === "") throw new UsageError(`"${label}" has no characters usable in a file name`);
  return safe;
}

// ───────────────────────────── fixtures ─────────────────────────────

export interface LoadedFixture {
  name: string;
  dir: string;
  /** From the name (ho-* = holdout); labels.json "set" must agree when present. */
  set: FixtureSet;
  planJson: unknown;
  /** null when the fixture has no pr.diff. */
  diffText: string | null;
  labels: Labels;
  /** Lines of the human plan output (plan.txt); null when absent. */
  planLines: number | null;
  /** Non-no-op resource changes in plan.json. */
  changes: number;
}

/** Fixture directory names (those holding labels.json), sorted. */
export function listFixtures(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => !name.startsWith(".") && statSync(join(root, name)).isDirectory())
    .filter((name) => existsSync(join(root, name, "labels.json")))
    .sort();
}

export function loadFixture(root: string, name: string): LoadedFixture {
  const dir = join(root, name);
  const read = (file: string): string | null => {
    const path = join(dir, file);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  };
  const planText = read("plan.json");
  if (planText === null) throw new Error(`${name}: plan.json is missing`);
  if (!existsSync(join(dir, "repo"))) throw new Error(`${name}: repo/ is missing`);
  let planJson: unknown;
  let labelsJson: unknown;
  try {
    planJson = JSON.parse(planText);
  } catch (err) {
    throw new Error(`${name}: plan.json is not JSON: ${errorMessage(err)}`);
  }
  try {
    labelsJson = JSON.parse(read("labels.json") ?? "");
  } catch (err) {
    throw new Error(`${name}: labels.json is not JSON: ${errorMessage(err)}`);
  }
  let labels: Labels;
  let set: FixtureSet;
  try {
    labels = parseLabels(labelsJson);
    set = fixtureSet(labels, name);
  } catch (err) {
    throw new Error(`${name}: ${errorMessage(err)}`);
  }
  const human = read("plan.txt");
  return {
    name,
    dir,
    set,
    planJson,
    diffText: read("pr.diff"),
    labels,
    planLines: human === null ? null : human.trimEnd().split("\n").length,
    changes: countChanges(planJson),
  };
}

/**
 * Loads the requested fixtures (all when `only` is null) of the requested set; an unknown name is an
 * error. The set is decided by the name before anything is read, so a dev run never parses a
 * holdout fixture, and a holdout fixture that fails to load does not print its problems (they can
 * name its addresses) unless `showHoldout`.
 */
export function loadFixtures(
  root: string,
  only: readonly string[] | null,
  set: FixtureSet | "all" = "all",
  showHoldout = false,
): LoadedFixture[] {
  const all = listFixtures(root);
  const inSet = (name: string): boolean => set === "all" || setOfName(name) === set;
  const unknown = (only ?? []).filter((n) => !all.includes(n));
  if (unknown.length > 0) {
    const available = all.filter(inSet);
    throw new Error(
      `unknown fixture(s): ${unknown.join(", ")} (available: ${available.join(", ") || "none"})`,
    );
  }
  return (only ?? all).filter(inSet).map((name) => {
    try {
      return loadFixture(root, name);
    } catch (err) {
      if (showHoldout || setOfName(name) !== "holdout") throw err;
      throw new Error(`${name}: failed to load (holdout: details hidden; --show-holdout prints them)`);
    }
  });
}

/** Resource changes whose actions are anything but ["no-op"]. */
export function countChanges(planJson: unknown): number {
  const changes = (planJson as { resource_changes?: unknown } | null)?.resource_changes;
  if (!Array.isArray(changes)) return 0;
  return changes.filter((rc: unknown) => {
    const actions = (rc as { change?: { actions?: unknown } } | null)?.change?.actions;
    return Array.isArray(actions) && !(actions.length === 1 && actions[0] === "no-op");
  }).length;
}

// ───────────────────────────── cases ─────────────────────────────

/** What the harness calls; injected in tests, loaded from src/ otherwise. */
export interface EvalDeps {
  reviewPlan(input: ReviewInput): Promise<Review>;
  createFsWorkspace(root: string, rootModuleDir: string): Workspace;
}

// Loaded lazily so --help and the pure helpers work without the review pipeline (and the SDK).
async function loadDeps(): Promise<EvalDeps> {
  const [{ reviewPlan }, { createFsWorkspace }] = await Promise.all([
    import("../src/review.js"),
    import("../src/workspace.js"),
  ]);
  return { reviewPlan, createFsWorkspace };
}

export interface CaseRecord {
  fixture: string;
  set: FixtureSet;
  /** 1-based */
  repeat: number;
  planLines: number | null;
  changes: number;
  status: "ok" | "error";
  error: string | null;
  grade: FixtureGrade;
  flagged: { address: string; severity: string; origin: string; confidence: string }[];
  /** 0 in rules mode; null when the agent's cost is unknown. */
  costUsd: number | null;
  latencyMs: number;
  /** AgentRunInfo.status, or null when no agent ran. */
  agentStatus: string | null;
  warnings: string[];
  /** Set on holdout records when the report must not name their addresses (see blindRecords). */
  blind?: boolean;
}

const EMPTY_REVIEW: Review = {
  rootModuleDir: "",
  findings: [],
  others: [],
  stats: { totalChanges: 0, counts: {}, bySeverity: {} },
  summary: "",
  warnings: [],
};

export async function runCase(
  fixture: LoadedFixture,
  repeat: number,
  options: EvalOptions,
  deps: EvalDeps,
  apiKey: string | undefined,
): Promise<CaseRecord> {
  const started = performance.now();
  const logger = caseLogger(`${fixture.name} #${repeat}`, fixture.set === "holdout" && !options.showHoldout);
  const base = {
    fixture: fixture.name,
    set: fixture.set,
    repeat,
    planLines: fixture.planLines,
    changes: fixture.changes,
  };
  try {
    const review = await deps.reviewPlan({
      planJson: fixture.planJson,
      workspace: deps.createFsWorkspace(join(fixture.dir, "repo"), ""),
      diffText: fixture.diffText,
      agent:
        options.mode === "rules"
          ? null
          : {
              model: options.model ?? DEFAULT_MODEL,
              apiKey: apiKey ?? "",
              effort: options.effort,
              maxTurns: MAX_TURNS,
              maxCostUsd: options.maxCostUsd,
              timeoutMs: CASE_TIMEOUT_MS,
              logger,
            },
      maxFindings: MAX_FINDINGS,
      logger,
    });
    return {
      ...base,
      status: "ok",
      error: null,
      grade: gradeFixture(review, fixture.labels),
      flagged: review.findings.map((f) => ({
        address: f.address,
        severity: f.severity,
        origin: f.origin,
        confidence: f.confidence,
      })),
      costUsd: options.mode === "rules" ? (review.agent?.costUsd ?? 0) : (review.agent?.costUsd ?? null),
      latencyMs: Math.round(performance.now() - started),
      agentStatus: review.agent?.status ?? null,
      warnings: review.warnings,
    };
  } catch (err) {
    // A crash in the code under test is a graded case (everything missed), not a harness error.
    return {
      ...base,
      status: "error",
      error: errorMessage(err),
      grade: gradeFixture(EMPTY_REVIEW, fixture.labels),
      flagged: [],
      costUsd: null,
      latencyMs: Math.round(performance.now() - started),
      agentStatus: null,
      warnings: [],
    };
  }
}

/**
 * Warnings stay visible (prefixed with the case); info and debug would drown the progress lines. A
 * blind (holdout) case's warnings can name its addresses, so only their existence is printed.
 */
export function caseLogger(prefix: string, blind = false): Logger {
  return {
    info: () => {},
    debug: () => {},
    warn: (message) => console.warn(`  [${prefix}] warning: ${blind ? "(holdout: text hidden)" : message}`),
  };
}

// ───────────────────────────── summary ─────────────────────────────

export interface RunSummary extends Summary {
  cases: number;
  errors: number;
  /** Cases not run because --budget-usd was exceeded. */
  skipped: number;
  cost: { total: number; meanPerCase: number | null; unpricedCases: number };
  latencyMs: { p50: number; max: number };
}

export function summarize(records: readonly CaseRecord[], skipped = 0): RunSummary {
  const costs = records.flatMap((r) => (r.costUsd === null ? [] : [r.costUsd]));
  const latencies = records.map((r) => r.latencyMs);
  const total = costs.reduce((t, c) => t + c, 0);
  return {
    ...aggregate(records.map((r) => r.grade)),
    // A crashed review flagged nothing, which on a fixture with no material change is no FP and no
    // FN: it is an error, not a perfect case.
    perfect: records.filter((r) => r.status === "ok" && r.grade.fp.length === 0 && r.grade.fn.length === 0)
      .length,
    cases: records.length,
    errors: records.filter((r) => r.status === "error").length,
    skipped,
    cost: {
      total,
      meanPerCase: costs.length === 0 ? null : total / costs.length,
      unpricedCases: records.length - costs.length,
    },
    latencyMs: { p50: percentile(latencies, 50), max: latencies.length === 0 ? 0 : Math.max(...latencies) },
  };
}

export interface SetSummaries {
  dev: RunSummary | null;
  holdout: RunSummary | null;
  combined: RunSummary;
}

/** Summaries per labeled set (null when the run had no case of that set) and over everything. */
export function summarizeSets(records: readonly CaseRecord[], skipped = 0): SetSummaries {
  const of = (set: FixtureSet): RunSummary | null => {
    const rs = records.filter((r) => r.set === set);
    return rs.length ? summarize(rs) : null;
  };
  return { dev: of("dev"), holdout: of("holdout"), combined: summarize(records, skipped) };
}

/**
 * The holdout set is a blind test: unless asked, reports give its counts but never its addresses,
 * so nobody tunes the rules to it by reading the misses.
 */
export function blindRecords(records: readonly CaseRecord[], showHoldout: boolean): CaseRecord[] {
  if (showHoldout) return [...records];
  return records.map((r) => {
    if (r.set !== "holdout") return r;
    const hide = (list: readonly string[]): string[] => list.map(() => "(holdout)");
    return {
      ...r,
      blind: true,
      // Error text can quote the plan or the labels (addresses, attribute values).
      error: r.error === null ? null : "(holdout: error text hidden)",
      grade: {
        ...r.grade,
        tp: r.grade.tp.map((t) => ({ ...t, address: "(holdout)" })),
        fp: hide(r.grade.fp),
        fn: hide(r.grade.fn),
        acceptableFlagged: hide(r.grade.acceptableFlagged),
        fnInOthers: {},
        duplicateFindings: hide(r.grade.duplicateFindings),
      },
      flagged: r.flagged.map((f) => ({ ...f, address: "(holdout)" })),
      warnings: [],
    };
  });
}

/** Nearest-rank percentile (always an observed value); 0 for an empty list. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] ?? 0;
}

// ───────────────────────────── rendering ─────────────────────────────

export interface ReportHeader {
  label: string;
  mode: EvalOptions["mode"];
  model: string | null;
  effort: Effort | null;
  /** ISO timestamp of the run. */
  startedAt: string;
  fixtures: number;
  repeat: number;
  maxCostUsd: number | null;
  budgetUsd: number | null;
  stoppedByBudget: boolean;
}

export function reportHeader(
  options: EvalOptions,
  fixtures: number,
  startedAt: Date,
  stoppedByBudget: boolean,
): ReportHeader {
  const model = options.mode === "model";
  return {
    label: options.label,
    mode: options.mode,
    model: model ? options.model : null,
    effort: model ? options.effort : null,
    startedAt: startedAt.toISOString(),
    fixtures,
    repeat: options.repeat,
    maxCostUsd: model ? options.maxCostUsd : null,
    budgetUsd: options.budgetUsd,
    stoppedByBudget,
  };
}

function caseName(r: CaseRecord, showRepeat: boolean): string {
  return showRepeat ? `${r.fixture} #${r.repeat}` : r.fixture;
}

function tracedCell(g: FixtureGrade): string {
  return g.traceJudged === 0 ? "-" : `${g.traced}/${g.traceJudged}`;
}

export function renderConsoleTable(records: readonly CaseRecord[]): string {
  const showRepeat = records.some((r) => r.repeat > 1);
  const rows = [
    ["fixture", "plan lines", "changes", "TP/FP/FN", "traced", "cost", "seconds", "notes"],
    ...records.map((r) => [
      caseName(r, showRepeat),
      r.planLines === null ? "?" : String(r.planLines),
      String(r.changes),
      `${r.grade.tp.length}/${r.grade.fp.length}/${r.grade.fn.length}`,
      tracedCell(r.grade),
      formatUsd(r.costUsd),
      (r.latencyMs / 1000).toFixed(1),
      caseNotes(r).join("; "),
    ]),
  ];
  const widths = rows[0]?.map((_, col) => Math.max(...rows.map((row) => (row[col] ?? "").length))) ?? [];
  return rows
    .map((row) =>
      row
        .map((cell, col) => (col === row.length - 1 ? cell : cell.padEnd(widths[col] ?? 0)))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/** What went wrong in a case, in reading order; empty for a perfect one. */
export function caseNotes(r: CaseRecord): string[] {
  const notes: string[] = [];
  if (r.status === "error") notes.push(`error: ${r.error ?? "unknown"}`);
  if (r.blind) {
    const untraced = r.grade.tp.filter((t) => t.trace === "missed").length;
    for (const [n, what] of [
      [r.grade.fp.length, "FP"],
      [r.grade.fn.length, "FN"],
      [untraced, "untraced"],
    ] as const)
      if (n > 0) notes.push(`${n} ${what} (holdout: addresses hidden)`);
    return notes;
  }
  if (r.grade.fp.length > 0) notes.push(`FP ${r.grade.fp.join(", ")}`);
  for (const address of r.grade.fn) {
    const other = r.grade.fnInOthers[address];
    notes.push(`FN ${address}${other === undefined ? "" : ` (listed as ${other})`}`);
  }
  const untraced = r.grade.tp.filter((t) => t.trace === "missed").map((t) => t.address);
  if (untraced.length > 0) notes.push(`untraced ${untraced.join(", ")}`);
  if (r.grade.duplicateFindings.length > 0) notes.push(`duplicates ${r.grade.duplicateFindings.join(", ")}`);
  if (r.agentStatus !== null && r.agentStatus !== "complete" && r.agentStatus !== "skipped")
    notes.push(`agent ${r.agentStatus}`);
  return notes;
}

export function renderSummaryLine(summary: RunSummary): string {
  const agent = summary.agentTrace;
  return [
    `precision ${formatPercent(summary.precision)}`,
    `recall ${formatPercent(summary.recall)}`,
    `F1 ${formatPercent(summary.f1)}`,
    ...(summary.errors > 0 ? [`${plural(summary.errors, "crashed case")}`] : []),
    `trace ${formatPercent(summary.trace.accuracy)} (${summary.trace.traced}/${summary.trace.judged})`,
    `cause lines ${formatPercent(summary.causeLineRecall.recall)} (${summary.causeLineRecall.covered}/${summary.causeLineRecall.labeled})`,
    `links ${formatLinkPrecision(summary.linkPrecision)}`,
    ...(agent.judged > 0
      ? [`agent cites ${formatPercent(agent.accuracy)} (${agent.traced}/${agent.judged})`]
      : []),
    `cost ${formatUsd(summary.cost.total)} total, ${formatUsd(summary.cost.meanPerCase)} avg`,
    `latency p50 ${formatSeconds(summary.latencyMs.p50)}, max ${formatSeconds(summary.latencyMs.max)}`,
  ].join(" · ");
}

function formatLinkPrecision(p: LinkPrecision): string {
  return `${formatPercent(p.precision)} (${p.changed - p.stray}/${p.changed})`;
}

/** One summary line per set present, then the combined one. */
export function renderSetLines(sets: SetSummaries): string {
  const lines: string[] = [];
  if (sets.dev) lines.push(`dev       ${renderSummaryLine(sets.dev)}`);
  if (sets.holdout) lines.push(`holdout   ${renderSummaryLine(sets.holdout)}`);
  lines.push(`combined  ${renderSummaryLine(sets.combined)}`);
  return lines.join("\n");
}

function setRow(name: string, s: RunSummary): string {
  return `| ${name} | ${s.cases} | ${formatPercent(s.precision)} | ${formatPercent(s.recall)} | ${formatPercent(s.f1)} | ${formatPercent(s.trace.accuracy)} (${s.trace.traced}/${s.trace.judged}) | ${formatPercent(s.causeLineRecall.recall)} (${s.causeLineRecall.covered}/${s.causeLineRecall.labeled}) | ${s.tp}/${s.fp}/${s.fn} |`;
}

export function renderMarkdownReport(
  header: ReportHeader,
  summary: RunSummary,
  records: readonly CaseRecord[],
  sets?: SetSummaries,
): string {
  const setup =
    header.mode === "rules"
      ? "mode **rules only** (deterministic rules + lineage, no LLM)"
      : `model \`${header.model}\` · effort \`${header.effort}\` · agent budget ${formatUsd(header.maxCostUsd, 2)} per review`;
  const unpriced = summary.cost.unpricedCases > 0 ? ` (${summary.cost.unpricedCases} unpriced)` : "";
  const sev = summary.severity;
  const showRepeat = records.some((r) => r.repeat > 1);
  const lines = [
    `# Eval results: ${header.label}`,
    "",
    `Run ${header.startedAt} · ${setup} · ${plural(header.fixtures, "fixture")} × ${plural(header.repeat, "repeat")}`,
    "",
    ...(header.stoppedByBudget
      ? [
          `**Stopped early:** total cost passed the ${formatUsd(header.budgetUsd, 2)} budget; ${plural(summary.skipped, "case")} not run.`,
          "",
        ]
      : []),
    "| Metric | Value |",
    "| --- | --- |",
    `| Precision | ${formatPercent(summary.precision)} (${summary.tp} TP, ${summary.fp} FP)${summary.errors > 0 ? `; ${plural(summary.errors, "crashed case")} graded as flagging nothing` : ""} |`,
    `| Recall | ${formatPercent(summary.recall)} (${summary.tp} of ${summary.tp + summary.fn} material) |`,
    `| F1 | ${formatPercent(summary.f1)} |`,
    `| Trace accuracy | ${formatPercent(summary.trace.accuracy)} (${summary.trace.traced}/${summary.trace.judged} TP) |`,
    `| Cause-line recall | ${formatPercent(summary.causeLineRecall.recall)} (${summary.causeLineRecall.covered}/${summary.causeLineRecall.labeled} labeled lines) |`,
    `| Link precision | ${formatLinkPrecision(summary.linkPrecision)} changed-line cause links hit a labeled cause |`,
    `| Agent citations | ${summary.agentTrace.judged === 0 ? "n/a" : `${formatPercent(summary.agentTrace.accuracy)} traced (${summary.agentTrace.traced}/${summary.agentTrace.judged} TP), links ${formatLinkPrecision(summary.agentTrace.links)}`} |`,
    `| Severity agreement | ${sev.compared === 0 ? "n/a" : `${sev.exact}/${sev.compared} exact, ${sev.offByOne} off by one, ${sev.worse} further`} |`,
    `| Acceptable flagged | ${summary.acceptableFlagged} |`,
    `| Perfect cases | ${summary.perfect}/${summary.cases} |`,
    `| Errors | ${summary.errors} |`,
    `| Cost | ${formatUsd(summary.cost.total)} total, ${formatUsd(summary.cost.meanPerCase)} per case${unpriced} |`,
    `| Latency | p50 ${formatSeconds(summary.latencyMs.p50)}, max ${formatSeconds(summary.latencyMs.max)} |`,
    "",
    ...(sets
      ? [
          "## By set",
          "",
          "| Set | Cases | Precision | Recall | F1 | Trace accuracy | Cause-line recall | TP/FP/FN |",
          "| --- | --- | --- | --- | --- | --- | --- | --- |",
          ...(sets.dev ? [setRow("dev", sets.dev)] : []),
          ...(sets.holdout ? [setRow("holdout (blind)", sets.holdout)] : []),
          setRow("combined", sets.combined),
          "",
        ]
      : []),
    "## Cases",
    "",
    "| Fixture | Plan lines | Changes | TP/FP/FN | Traced | Cost | Seconds | Notes |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...records.map((r) => {
      const cells = [
        caseName(r, showRepeat),
        r.planLines === null ? "?" : String(r.planLines),
        String(r.changes),
        `${r.grade.tp.length}/${r.grade.fp.length}/${r.grade.fn.length}`,
        tracedCell(r.grade),
        formatUsd(r.costUsd),
        (r.latencyMs / 1000).toFixed(1),
        caseNotes(r).join("; "),
      ];
      return `| ${cells.map(markdownCell).join(" | ")} |`;
    }),
    "",
  ];
  return lines.join("\n");
}

export function formatProgressLine(done: number, total: number, r: CaseRecord, runningCost: number): string {
  const width = String(total).length;
  const parts = [
    `[${String(done).padStart(width)}/${total}]`,
    `${r.fixture} #${r.repeat}`,
    `TP/FP/FN ${r.grade.tp.length}/${r.grade.fp.length}/${r.grade.fn.length}`,
    `traced ${tracedCell(r.grade)}`,
    formatUsd(r.costUsd),
    formatSeconds(r.latencyMs),
    `running ${formatUsd(runningCost)}`,
  ];
  const notes = caseNotes(r);
  return parts.join("  ") + (notes.length > 0 ? `  -- ${notes.join("; ")}` : "");
}

function formatUsd(value: number | null, digits = 4): string {
  return value === null ? "n/a" : `$${value.toFixed(digits)}`;
}

function formatPercent(ratio: number | null): string {
  return ratio === null ? "n/a" : `${Math.round(ratio * 100)}%`;
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function markdownCell(text: string): string {
  return text.replace(/\r\n?|\n/g, " ").replace(/\|/g, "\\|");
}

/** File-name-safe ISO timestamp: 2026-11-24T10-11-12-345Z. */
export function fileStamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

// ───────────────────────────── main ─────────────────────────────

export interface MainOptions {
  env?: NodeJS.ProcessEnv;
  fixturesDir?: string;
  cwd?: string;
  /** Clock for the run's timestamp (tests). */
  now?: () => Date;
  /** Injected pipeline (tests); loaded from src/ otherwise. */
  deps?: EvalDeps;
}

export async function main(argv: readonly string[], opts: MainOptions = {}): Promise<number> {
  const env = opts.env ?? process.env;
  let command: CliCommand;
  try {
    command = parseCliArgs(argv, opts.cwd);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`${err.message}\n\n${USAGE}`);
    return 1;
  }
  if (command.kind === "help") {
    console.log(USAGE);
    return 0;
  }
  const { options } = command;

  const apiKey = env.ANTHROPIC_API_KEY?.trim() || undefined;
  if (options.mode === "model" && apiKey === undefined) {
    console.error("ANTHROPIC_API_KEY is not set. Export it, or pass --rules-only for the no-LLM baseline.");
    return 1;
  }

  const fixturesDir = opts.fixturesDir ?? FIXTURES_DIR;
  let fixtures: LoadedFixture[];
  try {
    fixtures = loadFixtures(fixturesDir, options.fixtures, options.set, options.showHoldout);
  } catch (err) {
    console.error(`Could not load fixtures: ${errorMessage(err)}`);
    return 1;
  }
  if (fixtures.length === 0) {
    console.error(`No fixtures found in ${fixturesDir}`);
    return 1;
  }

  // Checked before any case runs: finding out afterwards would throw away a run that was paid for.
  try {
    await mkdir(options.outDir, { recursive: true });
    await access(options.outDir, constants.W_OK);
  } catch (err) {
    console.error(`Cannot write results to ${options.outDir}: ${errorMessage(err)}`);
    return 1;
  }

  let deps: EvalDeps;
  try {
    deps = opts.deps ?? (await loadDeps());
  } catch (err) {
    console.error(`Could not load the review pipeline: ${errorMessage(err)}`);
    return 1;
  }

  const startedAt = (opts.now ?? (() => new Date()))();
  const specs = fixtures.flatMap((fixture) =>
    Array.from({ length: options.repeat }, (_, i) => ({ fixture, repeat: i + 1 })),
  );
  const what = options.mode === "rules" ? "rules only" : `${options.model} (effort ${options.effort})`;
  const budget = options.budgetUsd === null ? "" : `, budget ${formatUsd(options.budgetUsd, 2)}`;
  console.log(`Running ${specs.length} review(s) sequentially with ${what}${budget}\n`);

  // Sequential on purpose: the running total is what --budget-usd checks.
  const records: CaseRecord[] = [];
  let runningCost = 0;
  let stoppedByBudget = false;
  for (const spec of specs) {
    const record = await runCase(spec.fixture, spec.repeat, options, deps, apiKey);
    records.push(record);
    runningCost += record.costUsd ?? 0;
    const [shown] = blindRecords([record], options.showHoldout);
    console.log(formatProgressLine(records.length, specs.length, shown ?? record, runningCost));
    if (options.budgetUsd !== null && runningCost > options.budgetUsd && records.length < specs.length) {
      stoppedByBudget = true;
      console.warn(
        `\nStopping: total cost ${formatUsd(runningCost)} passed the ${formatUsd(options.budgetUsd, 2)} budget; ` +
          `${specs.length - records.length} review(s) not run.`,
      );
      break;
    }
  }

  const sets = summarizeSets(records, specs.length - records.length);
  const summary = sets.combined;
  const header = reportHeader(options, fixtures.length, startedAt, stoppedByBudget);
  const shown = blindRecords(records, options.showHoldout);
  // Printed before the files are written, so the results survive a failed write.
  console.log(`\n${renderConsoleTable(shown)}\n\n${renderSetLines(sets)}`);

  const jsonPath = join(options.outDir, `${options.label}-${fileStamp(startedAt)}.json`);
  const mdPath = join(options.outDir, `latest-${options.label}.md`);
  await writeFile(jsonPath, `${JSON.stringify({ header, summary, sets, records: shown }, null, 2)}\n`);
  await writeFile(mdPath, renderMarkdownReport(header, summary, shown, sets));
  console.log(`Wrote ${mdPath}\n      ${jsonPath}`);
  return 0;
}

/** Error text for the console and the results file; anything shaped like an Anthropic key is cut. */
export function errorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/sk-ant-[\w-]+/g, "(redacted)").slice(0, 500);
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(errorMessage(err));
      process.exitCode = 1;
    },
  );
}
