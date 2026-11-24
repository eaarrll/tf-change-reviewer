/*
 * Action inputs → validated configuration. Error messages name the input and what it accepts but
 * never echo the value: a secret pasted into the wrong input must not end up in the logs.
 */
import { DEFAULT_EFFORT, DEFAULT_MODEL } from "./agent/agent.js";
import { DEFAULT_MAX_FINDINGS } from "./review.js";
import type { Effort, Severity } from "./types.js";

export interface InputSource {
  /** Like core.getInput: returns "" when unset. */
  getInput(name: string): string;
}

/**
 * One `plan-json` entry: a path or glob of plan files, and the root module dir they belong to. The
 * pattern is repo-relative, or absolute (a plan kept outside the checkout, e.g. under RUNNER_TEMP);
 * an absolute pattern always names its root module dir.
 */
export interface PlanEntry {
  pattern: string;
  /** Repo-relative root module dir; null = the plan file's own directory. */
  rootDir: string | null;
}

export type FailOn = "none" | Exclude<Severity, "low" | "noise">;

export interface ActionConfig {
  plans: PlanEntry[];
  githubToken: string;
  /** null = rules-only review (no AI). */
  apiKey: string | null;
  model: string;
  effort: Effort;
  maxFindings: number;
  /** Total AI budget for the run, shared by every plan. */
  maxCostUsd: number;
  /** Total time budget for the AI review, shared by every plan. */
  timeoutMinutes: number;
  failOn: FailOn;
  comment: boolean;
  extraInstructions: string | null;
  /** Pull request to review and comment on; null = the event's own pull request (if any). */
  prNumber: number | null;
  /** Which sticky comment this run owns; null = derived from plan-json. */
  commentKey: string | null;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

const MODEL_ID = /^[A-Za-z0-9._:@/-]+$/;
export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
export const FAIL_ON: readonly FailOn[] = ["none", "critical", "high", "medium"];
const MAX_EXTRA_INSTRUCTIONS = 4000;
const MAX_PLAN_ENTRIES = 50;
const MAX_COMMENT_KEY = 200;

const BOOLEAN_WORDS = new Map<string, boolean>([
  ["true", true],
  ["yes", true],
  ["on", true],
  ["1", true],
  ["false", false],
  ["no", false],
  ["off", false],
  ["0", false],
]);

export function readConfig(inputs: InputSource): ActionConfig {
  const read = (name: string): string => inputs.getInput(name).trim();
  return {
    plans: parsePlanEntries(inputs.getInput("plan-json")),
    githubToken: requireToken(read("github-token")),
    apiKey: read("anthropic-api-key") || null,
    model: parseModel(read("model")),
    effort: parseEffort(read("effort")),
    maxFindings: parseInteger("max-findings", read("max-findings"), {
      fallback: DEFAULT_MAX_FINDINGS,
      min: 1,
      max: 50,
    }),
    maxCostUsd: parseMaxCost(read("max-cost-usd")),
    timeoutMinutes: parseInteger("timeout-minutes", read("timeout-minutes"), {
      fallback: 5,
      min: 1,
      max: 60,
    }),
    failOn: parseFailOn(read("fail-on")),
    comment: parseBoolean("comment", read("comment"), true),
    extraInstructions: parseExtraInstructions(read("extra-instructions")),
    prNumber: parsePrNumber(read("pr-number")),
    commentKey: parseCommentKey(read("comment-key")),
  };
}

/**
 * Newline-separated entries: `path/to/plan.json` or `path/to/plan.json=root/module/dir`. Globs are
 * allowed in the path. Blank lines and `#` comments are skipped. A plan path may be absolute (a plan
 * kept outside the checkout, such as a downloaded artifact under RUNNER_TEMP) when the entry names
 * its root module dir; the action reads it only inside the checkout or RUNNER_TEMP.
 */
export function parsePlanEntries(text: string): PlanEntry[] {
  const entries: PlanEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const pattern = (eq < 0 ? line : line.slice(0, eq)).trim();
    const rootDir = eq < 0 ? null : line.slice(eq + 1).trim();
    if (pattern === "") throw invalid("plan-json", "entries of the form path/to/plan.json[=root/module/dir]");
    if (isEscaping(pattern) || (rootDir !== null && (isAbsolute(rootDir) || isEscaping(rootDir)))) {
      throw invalid("plan-json", "repository-relative paths (no absolute paths, no ..)");
    }
    if (isAbsolute(pattern) && rootDir === null) {
      throw invalid(
        "plan-json",
        "a root module dir for an absolute plan path, e.g. ${{ runner.temp }}/plan/plan.json=infra",
      );
    }
    entries.push({ pattern, rootDir: rootDir === null ? null : rootDir === "" ? "." : rootDir });
  }
  if (entries.length === 0) {
    throw new ConfigError(
      'Input "plan-json" is required: the path of `terraform show -json plan.out` output, one per line.',
    );
  }
  if (entries.length > MAX_PLAN_ENTRIES) throw invalid("plan-json", `at most ${MAX_PLAN_ENTRIES} entries`);
  return entries;
}

function isAbsolute(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  return p.startsWith("/") || /^[A-Za-z]:/.test(p);
}

function isEscaping(path: string): boolean {
  return path.replace(/\\/g, "/").split("/").includes("..");
}

function invalid(input: string, expected: string): ConfigError {
  return new ConfigError(`Invalid input "${input}": expected ${expected}.`);
}

function requireToken(value: string): string {
  if (value) return value;
  throw new ConfigError(
    'Input "github-token" is required: pass a token with contents: read and pull-requests: write (the default is github.token).',
  );
}

function parseModel(value: string): string {
  const model = value || DEFAULT_MODEL;
  if (MODEL_ID.test(model)) return model;
  throw invalid("model", `a model ID such as "${DEFAULT_MODEL}" (letters, digits and . _ : @ / - only)`);
}

function parseEffort(value: string): Effort {
  const effort = value.toLowerCase() || DEFAULT_EFFORT;
  const match = EFFORTS.find((candidate) => candidate === effort);
  if (match) return match;
  throw invalid("effort", `one of ${EFFORTS.join(", ")}`);
}

function parseFailOn(value: string): FailOn {
  const v = value.toLowerCase() || "none";
  const match = FAIL_ON.find((candidate) => candidate === v);
  if (match) return match;
  throw invalid("fail-on", `one of ${FAIL_ON.join(", ")}`);
}

function parseBoolean(input: string, value: string, fallback: boolean): boolean {
  if (!value) return fallback;
  const parsed = BOOLEAN_WORDS.get(value.toLowerCase());
  if (parsed !== undefined) return parsed;
  throw invalid(input, `one of ${[...BOOLEAN_WORDS.keys()].join(", ")} (case-insensitive)`);
}

function parseInteger(
  input: string,
  value: string,
  range: { fallback: number; min: number; max: number },
): number {
  if (!value) return range.fallback;
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (Number.isSafeInteger(parsed) && parsed >= range.min && parsed <= range.max) return parsed;
  throw invalid(input, `an integer from ${range.min} to ${range.max}`);
}

function parseMaxCost(value: string): number {
  if (!value) return 1;
  // Plain decimals only: Number() would also accept "1e1", "0x10" and "Infinity".
  const parsed = /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) ? Number(value) : Number.NaN;
  if (parsed > 0 && parsed <= 50) return parsed;
  throw invalid("max-cost-usd", "a number of US dollars greater than 0 and at most 50");
}

function parsePrNumber(value: string): number | null {
  if (!value) return null;
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  throw invalid("pr-number", "a positive integer (a pull request number)");
}

function parseCommentKey(value: string): string | null {
  if (!value) return null;
  if (value.length <= MAX_COMMENT_KEY && ![...value].some((ch) => ch.charCodeAt(0) < 0x20)) return value;
  throw invalid("comment-key", `a single line of at most ${MAX_COMMENT_KEY} characters`);
}

function parseExtraInstructions(value: string): string | null {
  if (!value) return null;
  if (value.length <= MAX_EXTRA_INSTRUCTIONS) return value;
  const cut = value.slice(0, MAX_EXTRA_INSTRUCTIONS);
  // Drop a dangling high surrogate rather than send half an emoji.
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** Severity at or above the fail-on threshold. */
export function meetsThreshold(severity: Severity, failOn: FailOn): boolean {
  if (failOn === "none") return false;
  const order: Severity[] = ["critical", "high", "medium", "low", "noise"];
  return order.indexOf(severity) <= order.indexOf(failOn);
}
