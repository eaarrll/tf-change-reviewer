#!/usr/bin/env node
/*
 * Command line:
 *   tf-change-reviewer review --plan <file|-> [--root-dir <dir>] [--repo <dir>] [--base <ref> | --diff <file|->]
 *                             [--rules-only] [--model <id>] [--effort <e>] [--max-findings N]
 *                             [--format text|markdown|json] [--fail-on none|critical|high|medium]
 *   tf-change-reviewer metrics --repo owner/name [--since YYYY-MM-DD] [--max-prs N]
 *
 * The AI review runs when ANTHROPIC_API_KEY is set, unless --rules-only. Exit codes: 0 done,
 * 3 findings at or above --fail-on (or, with --fail-on, an errored plan), 1 runtime error (unreadable plan, git failure), 2 usage error.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { DEFAULT_EFFORT, DEFAULT_MODEL } from "./agent/agent.js";
import { EFFORTS, FAIL_ON, meetsThreshold, type FailOn } from "./config.js";
import { gitDiff } from "./git/diff.js";
import { computeMetrics } from "./metrics/feedback.js";
import { collectFeedback, renderMetrics, type MetricsOctokit } from "./metrics/github.js";
import { PlanError, decodePlanBytes, parsePlanText } from "./plan/load.js";
import {
  isErroredPlan,
  isIncompletePlan,
  renderCliReport,
  renderJson,
  renderReviewComment,
} from "./report/markdown.js";
import { DEFAULT_MAX_FINDINGS, reviewPlan } from "./review.js";
import type { Effort, Logger, Review } from "./types.js";
import { VERSION } from "./version.js";
import { createFsWorkspace, normalizeRepoPath } from "./workspace.js";

export const USAGE = `tf-change-reviewer ${VERSION}: which change in this Terraform plan needs your attention, and which line caused it?

Usage:
  tf-change-reviewer review --plan <file|-> [options]
  tf-change-reviewer metrics --repo <owner/name> [--since YYYY-MM-DD] [--max-prs N]

review options:
  --plan <file|->        Output of \`terraform show -json plan.out\` ("-" = stdin)
  --repo <dir>           Repository checkout (default: current directory)
  --root-dir <dir>       Root module dir, relative to --repo (default: the plan file's directory)
  --base <ref>           Diff the PR as \`git diff <ref>...HEAD\` in --repo
  --diff <file|->        Or read a unified diff ("-" = stdin)
  --rules-only           No AI review even when ANTHROPIC_API_KEY is set
  --model <id>           Claude model (default ${DEFAULT_MODEL})
  --effort <level>       ${EFFORTS.join(" | ")} (default ${DEFAULT_EFFORT})
  --max-findings <n>     Findings under "Needs your attention" (default ${DEFAULT_MAX_FINDINGS})
  --max-cost-usd <usd>   AI budget (default 1.00)
  --timeout-minutes <n>  AI time budget (default 5)
  --format <f>           text | markdown | json (default text)
  --fail-on <level>      ${FAIL_ON.join(" | ")}: exit 3 when a finding is at least this severe,
                         or when the plan errored

metrics options (needs GITHUB_TOKEN):
  --repo <owner/name>    Repository whose PR comments to read
  --since <YYYY-MM-DD>   Only PRs updated since this date
  --max-prs <n>          Most recently updated PRs to read (default 100)

Environment: ANTHROPIC_API_KEY (AI review), GITHUB_TOKEN (metrics), GITHUB_API_URL (GitHub Enterprise).`;

export class UsageError extends Error {
  override name = "UsageError";
}

/** What main needs from the outside world; tests replace these. */
export interface CliDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdin: () => Promise<string>;
  /** `git diff base...HEAD` in a directory. */
  gitDiff: (repo: string, base: string) => Promise<string>;
  /** Octokit for the metrics command. */
  octokit: (token: string, baseUrl: string | undefined) => Promise<MetricsOctokit>;
  /** Injected Anthropic client (tests). */
  anthropicClient?: unknown;
  isTTY: boolean;
}

function defaultDeps(): CliDeps {
  return {
    env: process.env,
    cwd: process.cwd(),
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      return Buffer.concat(chunks).toString("utf8");
    },
    gitDiff: (repo, base) => gitDiff(repo, base, "HEAD"),
    octokit: async (token, baseUrl) => {
      const { getOctokit } = await import("@actions/github");
      return getOctokit(token, baseUrl ? { baseUrl } : {}) as unknown as MetricsOctokit;
    },
    isTTY: process.stdout.isTTY === true,
  };
}

export async function main(argv: readonly string[], partial: Partial<CliDeps> = {}): Promise<number> {
  const deps = { ...defaultDeps(), ...partial };
  const [command, ...rest] = argv;
  try {
    if (command === undefined || command === "-h" || command === "--help" || command === "help") {
      deps.stdout(`${USAGE}\n`);
      return command === undefined ? 2 : 0;
    }
    if (command === "--version" || command === "-v") {
      deps.stdout(`${VERSION}\n`);
      return 0;
    }
    if (command === "review") return await reviewCommand(rest, deps);
    if (command === "metrics") return await metricsCommand(rest, deps);
    throw new UsageError(`unknown command "${command}"`);
  } catch (err) {
    if (err instanceof UsageError) {
      deps.stderr(`error: ${err.message}\n\n${USAGE}\n`);
      return 2;
    }
    deps.stderr(`error: ${errorMessage(err)}\n`);
    return 1;
  }
}

// ───────────────────────────── review ─────────────────────────────

const FORMATS = ["text", "markdown", "json"] as const;
type Format = (typeof FORMATS)[number];

function parse(argv: readonly string[], options: NonNullable<ParseArgsConfig["options"]>) {
  try {
    return parseArgs({ args: [...argv], options, strict: true, allowPositionals: false }).values;
  } catch (err) {
    throw new UsageError(errorMessage(err));
  }
}

async function reviewCommand(argv: readonly string[], deps: CliDeps): Promise<number> {
  const v = parse(argv, {
    plan: { type: "string" },
    repo: { type: "string" },
    "root-dir": { type: "string" },
    base: { type: "string" },
    diff: { type: "string" },
    "rules-only": { type: "boolean" },
    model: { type: "string" },
    effort: { type: "string" },
    "max-findings": { type: "string" },
    "max-cost-usd": { type: "string" },
    "timeout-minutes": { type: "string" },
    format: { type: "string" },
    "fail-on": { type: "string" },
    help: { type: "boolean", short: "h" },
  });
  if (v.help) {
    deps.stdout(`${USAGE}\n`);
    return 0;
  }
  const planArg = str(v.plan);
  if (!planArg) throw new UsageError("--plan is required");
  const baseRef = str(v.base);
  const diffArg = str(v.diff);
  if (baseRef && diffArg) throw new UsageError("--base and --diff conflict: pass one");
  if (planArg === "-" && diffArg === "-") throw new UsageError("--plan and --diff cannot both read stdin");
  const format = oneOf("--format", str(v.format) ?? "text", FORMATS) as Format;
  const failOn = oneOf("--fail-on", str(v["fail-on"]) ?? "none", FAIL_ON) as FailOn;
  const effort = oneOf("--effort", str(v.effort) ?? DEFAULT_EFFORT, EFFORTS) as Effort;
  const maxFindings = integer("--max-findings", str(v["max-findings"]), DEFAULT_MAX_FINDINGS, 1, 50);
  const maxCostUsd = positive("--max-cost-usd", str(v["max-cost-usd"]), 1);
  const timeoutMinutes = integer("--timeout-minutes", str(v["timeout-minutes"]), 5, 1, 60);
  const model = str(v.model) ?? DEFAULT_MODEL;

  const repo = resolve(deps.cwd, str(v.repo) ?? ".");
  const planPath = planArg === "-" ? null : resolve(deps.cwd, planArg);
  const rootDir = resolveRootDir(repo, str(v["root-dir"]), planPath);

  const planText = planPath === null ? await deps.readStdin() : await readPlanText(planPath);
  let planJson: unknown;
  try {
    planJson = parsePlanText(planText);
  } catch (err) {
    if (err instanceof PlanError) throw new Error(`${planArg}: ${err.message}`);
    throw err;
  }

  let diffText: string | null = null;
  if (diffArg === "-") diffText = await deps.readStdin();
  else if (diffArg) diffText = await readText(resolve(deps.cwd, diffArg), "diff");
  else if (baseRef) diffText = await deps.gitDiff(repo, baseRef);

  const apiKey = deps.env.ANTHROPIC_API_KEY?.trim();
  const useAgent = !v["rules-only"] && (Boolean(apiKey) || deps.anthropicClient !== undefined);
  const logger: Logger = {
    info: () => {},
    warn: (m) => deps.stderr(`warning: ${m}\n`),
  };
  if (!useAgent && !v["rules-only"])
    deps.stderr("note: ANTHROPIC_API_KEY is not set: rules-only review (no AI).\n");
  const review: Review = await reviewPlan({
    planJson,
    workspace: createFsWorkspace(repo, rootDir),
    diffText,
    agent: useAgent
      ? {
          model,
          apiKey: apiKey ?? "",
          effort,
          maxTurns: 16,
          maxCostUsd,
          timeoutMs: timeoutMinutes * 60_000,
          logger,
          ...(deps.anthropicClient !== undefined && { client: deps.anthropicClient }),
        }
      : null,
    maxFindings,
    logger,
  });
  if (isIncompletePlan(planJson)) review.planIncomplete = true;
  if (diffText === null)
    deps.stderr("note: no diff (--base or --diff): causes cannot be tied to changed lines.\n");

  const out =
    format === "json"
      ? renderJson([review])
      : format === "markdown"
        ? renderReviewComment([review], { version: VERSION })
        : renderCliReport([review], { color: deps.isTTY && !deps.env.NO_COLOR });
  deps.stdout(out);
  if (review.findings.some((f) => meetsThreshold(f.severity, failOn))) return 3;
  // A gate must not pass a plan Terraform could not finish: what it left out was never reviewed.
  if (failOn !== "none" && isErroredPlan(planJson)) {
    deps.stderr("error: the plan errored, so it could not be fully reviewed (--fail-on).\n");
    return 3;
  }
  return 0;
}

/** Root module dir relative to the repo: --root-dir, else the plan file's directory, else the repo root. */
function resolveRootDir(repo: string, rootDir: string | undefined, planPath: string | null): string {
  if (rootDir !== undefined) {
    const rel = normalizeRepoPath(rootDir);
    if (rel === null) throw new UsageError("--root-dir must be a path inside --repo");
    return rel;
  }
  if (planPath === null) return "";
  const rel = relative(repo, resolve(planPath, ".."));
  if (rel.startsWith("..") || isAbsolute(rel)) return "";
  return normalizeRepoPath(rel.split(sep).join(posix.sep)) ?? "";
}

/** Plan files are read as bytes so a UTF-16 file (Windows PowerShell 5.1 `>`) decodes instead of failing. */
async function readPlanText(path: string): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new Error(`cannot read the plan file ${path}`);
  }
  return decodePlanBytes(bytes);
}

async function readText(path: string, what: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new Error(`cannot read the ${what} file ${path}`);
  }
}

// ───────────────────────────── metrics ─────────────────────────────

async function metricsCommand(argv: readonly string[], deps: CliDeps): Promise<number> {
  const v = parse(argv, {
    repo: { type: "string" },
    since: { type: "string" },
    "max-prs": { type: "string" },
    help: { type: "boolean", short: "h" },
  });
  if (v.help) {
    deps.stdout(`${USAGE}\n`);
    return 0;
  }
  const repo = str(v.repo);
  const m = repo ? /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repo) : null;
  if (!m) throw new UsageError("--repo must be owner/name");
  const sinceText = str(v.since);
  let since: Date | undefined;
  if (sinceText !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sinceText) || Number.isNaN(Date.parse(`${sinceText}T00:00:00Z`)))
      throw new UsageError("--since must be a date, YYYY-MM-DD");
    since = new Date(`${sinceText}T00:00:00Z`);
  }
  const maxPrs = integer("--max-prs", str(v["max-prs"]), 100, 1, 1000);
  const token = deps.env.GITHUB_TOKEN?.trim() || deps.env.GH_TOKEN?.trim();
  if (!token)
    throw new Error("GITHUB_TOKEN is not set: the metrics command reads PR comments through the GitHub API.");
  const octokit = await deps.octokit(token, deps.env.GITHUB_API_URL?.trim() || undefined);
  const prs = await collectFeedback(octokit, {
    owner: m[1]!,
    repo: m[2]!,
    ...(since && { since }),
    maxPrs,
  });
  deps.stdout(`${renderMetrics(computeMetrics(prs))}\n`);
  return 0;
}

// ───────────────────────────── helpers ─────────────────────────────

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function oneOf<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  const match = allowed.find((a) => a === value.toLowerCase());
  if (match === undefined) throw new UsageError(`${flag} must be one of ${allowed.join(", ")}`);
  return match;
}

function integer(
  flag: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  const n = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new UsageError(`${flag} must be an integer from ${min} to ${max}`);
  return n;
}

function positive(flag: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) ? Number(value) : Number.NaN;
  if (!(n > 0) || n > 50) throw new UsageError(`${flag} must be a number greater than 0 and at most 50`);
  return n;
}

/** Error text without anything shaped like an API key. */
function errorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/sk-ant-[\w-]+/g, "(redacted)").slice(0, 1000);
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
      process.stderr.write(`error: ${errorMessage(err)}\n`);
      process.exitCode = 1;
    },
  );
}
