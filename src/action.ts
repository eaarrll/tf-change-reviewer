/*
 * GitHub Action entry: read the inputs, review every plan, write the job summary, the report JSON
 * and the outputs, upsert one sticky PR comment (newer runs win), then apply fail-on.
 *
 * Plan values are never logged: logs carry counts, addresses and file names only.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { glob, lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { ConfigError, meetsThreshold, readConfig, type ActionConfig } from "./config.js";
import {
  createGitHubPort,
  type CommentOwner,
  type GitHubPort,
  type PullInfo,
  type ReviewOctokit,
} from "./github.js";
import { parseConfirmedIds, parseEarlierFindings } from "./metrics/feedback.js";
import { PlanError, decodePlanBytes, parsePlanText } from "./plan/load.js";
import { GIT_SOURCES, checkoutHeadWarning, resolvePrDiff } from "./pr-diff.js";
import {
  isErroredPlan,
  isIncompletePlan,
  isWrittenByNewerRun,
  renderJobSummary,
  renderJson,
  renderReviewComment,
  checkboxId,
} from "./report/markdown.js";
import { reviewPlan } from "./review.js";
import { SEVERITY_ORDER } from "./types.js";
import type { Logger, ReportMeta, Review, Severity } from "./types.js";
import { VERSION } from "./version.js";
import { createFsWorkspace, normalizeRepoPath } from "./workspace.js";

/** Agent turns per plan; the shared cost and time budgets are the real limits. */
const MAX_TURNS = 16;
/** Plan files per run (a glob can match many). */
const MAX_PLANS = 20;
const WRAPPER_HINT =
  "it looks like hashicorp/setup-terraform wrapper output: set `terraform_wrapper: false` on setup-terraform, or run `terraform show -json plan.out > plan.json` without the wrapper";

const logger: Logger = {
  info: (m) => core.info(m),
  warn: (m) => core.warning(m),
  debug: (m) => core.debug(m),
};

interface PullContext {
  number: number | null;
  baseSha: string | null;
  headSha: string | null;
  /** The event's token cannot write to this pull request (pull_request from a fork). */
  readOnly: boolean;
}

interface PlanFile {
  /** Absolute path of the plan file. */
  file: string;
  /** How logs and errors name it: repo-relative inside the checkout, else the absolute path. */
  path: string;
  /** Repo-relative root module dir ("" = repository root). */
  rootDir: string;
}

export async function run(): Promise<void> {
  let config: ActionConfig;
  try {
    config = readConfig({ getInput: (name) => core.getInput(name) });
  } catch (err) {
    core.setFailed(`tf-change-reviewer: ${errorMessage(err)}`);
    return;
  }
  if (config.apiKey) core.setSecret(config.apiKey);
  core.setSecret(config.githubToken);

  try {
    await review(config);
  } catch (err) {
    // Plan and input problems are the workflow author's to fix: always fail loudly on those.
    if (err instanceof PlanError || err instanceof ConfigError)
      core.setFailed(`tf-change-reviewer: ${err.message}`);
    else if (config.failOn !== "none")
      core.setFailed(`tf-change-reviewer could not complete: ${errorMessage(err)}`);
    else core.warning(`tf-change-reviewer could not complete: ${errorMessage(err)}`);
  }
}

async function review(config: ActionConfig): Promise<void> {
  const root = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
  const ctx = github.context;
  const repo = ctx.repo;
  const port = createGitHubPort(
    github.getOctokit(config.githubToken) as unknown as ReviewOctokit,
    repo.owner,
    repo.repo,
  );
  const pull = await pullContext(config, port);
  const runnerTemp = process.env.RUNNER_TEMP ? resolve(process.env.RUNNER_TEMP) : null;
  const plans = await findPlans(root, runnerTemp, config);
  core.info(`Reviewing ${plans.length} plan(s)${pull.number ? ` for PR #${pull.number}` : ""}.`);
  if (!config.apiKey)
    core.info("No anthropic-api-key: rules-only review (deterministic rules + lineage, no AI).");

  const diff = await resolvePrDiff(root, pull.baseSha, pull.headSha, {
    ...GIT_SOURCES,
    listPullFiles: pull.number ? () => port.listPullFiles(pull.number as number) : null,
  });
  // Run-level warnings: shown once in the comment, not copied into every root module's review.
  const runWarnings = [...diff.warnings];
  const headWarning = pull.headSha ? await checkoutHeadWarning(root, pull.headSha) : null;
  if (headWarning) runWarnings.unshift(headWarning);
  for (const w of runWarnings) core.warning(w);
  if (diff.text === null) core.warning(noDiffWarning(pull));
  else core.info(`PR diff: ${diff.source}, ${diff.text.length} bytes.`);

  const reviews: Review[] = [];
  const started = Date.now();
  const deadline = started + config.timeoutMinutes * 60_000;
  let spent = 0;
  const erroredRoots: string[] = [];
  for (const plan of plans) {
    const planJson = await readPlan(plan, [root, runnerTemp]);
    const remainingCost = config.maxCostUsd - spent;
    const remainingMs = deadline - Date.now();
    const result = await reviewPlan({
      planJson,
      workspace: createFsWorkspace(root, plan.rootDir),
      diffText: diff.text,
      agent:
        config.apiKey === null
          ? null
          : {
              model: config.model,
              apiKey: config.apiKey,
              effort: config.effort,
              maxTurns: MAX_TURNS,
              maxCostUsd: Math.max(0, remainingCost),
              timeoutMs: Math.max(0, remainingMs),
              ...(config.extraInstructions !== null && { extraInstructions: config.extraInstructions }),
              logger,
            },
      maxFindings: config.maxFindings,
      logger,
    });
    if (isIncompletePlan(planJson)) result.planIncomplete = true;
    if (isErroredPlan(planJson)) erroredRoots.push(displayDir(plan.rootDir));
    spent += result.agent?.costUsd ?? 0;
    for (const n of result.notices ?? []) core.warning(`${displayDir(plan.rootDir)}: ${n}`);
    core.info(
      `${displayDir(plan.rootDir)}: ${result.findings.length} finding(s), ${result.stats.totalChanges} change(s)${result.agent ? `, AI review ${result.agent.status}` : ""}.`,
    );
    reviews.push(result);
  }

  const meta: ReportMeta = {
    repo: { owner: repo.owner, name: repo.repo, serverUrl: ctx.serverUrl || "https://github.com" },
    ...(pull.headSha && { headSha: pull.headSha }),
    ...(pull.baseSha && { baseSha: pull.baseSha }),
    ...(pull.number !== null && { prNumber: pull.number }),
    run: {
      id: ctx.runId,
      attempt: ctx.runAttempt || Number(process.env.GITHUB_RUN_ATTEMPT) || 1,
      url: `${ctx.serverUrl || "https://github.com"}/${repo.owner}/${repo.repo}/actions/runs/${ctx.runId}`,
    },
    version: VERSION,
    ...(runWarnings.length > 0 && { warnings: runWarnings }),
  };

  // Outputs, the report file and the summary first: they must survive a comment that cannot be posted.
  const findings = reviews.flatMap((r) => r.findings);
  core.setOutput("findings-count", String(findings.length));
  core.setOutput("max-severity", maxSeverity(findings.map((f) => f.severity)));
  // Never into the checkout: in the fork pattern it is the fork's tree, where a symlink could redirect the write.
  const reportPath = join(runnerTemp ?? tmpdir(), "tf-change-reviewer", "report.json");
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, renderJson(reviews, runWarnings));
  core.setOutput("report-json", reportPath);
  core.setOutput("comment-url", "");
  await core.summary.addRaw(renderJobSummary(reviews, meta), true).write();

  if (config.comment) {
    if (pull.number === null) {
      core.info("Not a pull request run: the review is in the job summary.");
    } else if (pull.readOnly) {
      core.notice(
        "Skipped the PR comment: this pull_request run comes from a fork, so its token cannot write to the pull request. The review is in the job summary; see the README for the workflow_run pattern that comments on fork PRs.",
      );
    } else {
      try {
        const url = await upsertComment(
          port,
          pull.number,
          reviews,
          meta,
          commentKey(config, root, runnerTemp),
          commentScope(process.env),
          commentPlans(config, root, runnerTemp),
        );
        if (url) core.setOutput("comment-url", url);
      } catch (err) {
        core.notice(
          `Could not post the PR comment (a read-only token, or missing pull-requests: write permission); the review is in the job summary. ${errorMessage(err)}`,
        );
      }
    }
  }

  const failing = findings.filter((f) => meetsThreshold(f.severity, config.failOn));
  if (failing.length > 0) {
    core.setFailed(
      `tf-change-reviewer: ${failing.length} finding${failing.length === 1 ? "" : "s"} at or above "${config.failOn}" severity (fail-on).`,
    );
  } else if (config.failOn !== "none" && erroredRoots.length > 0) {
    // A gate must not pass a plan Terraform could not finish: what it left out was never reviewed.
    core.setFailed(
      `tf-change-reviewer: the plan for ${erroredRoots.join(", ")} errored, so it could not be fully reviewed (fail-on).`,
    );
  }
}

// ───────────────────────────── pull request ─────────────────────────────

function record(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

async function pullContext(config: ActionConfig, port: GitHubPort): Promise<PullContext> {
  const ctx = github.context;
  const payload = record(ctx.payload);
  const pr = record(payload.pull_request);
  const eventPr = typeof pr.number === "number" ? pr.number : null;
  const fromWorkflowRun =
    ctx.eventName === "workflow_run"
      ? record((record(payload.workflow_run).pull_requests as unknown[] | undefined)?.[0]).number
      : undefined;
  const number = config.prNumber ?? eventPr ?? (typeof fromWorkflowRun === "number" ? fromWorkflowRun : null);
  if (number === null) return { number: null, baseSha: null, headSha: null, readOnly: false };

  if (number === eventPr) {
    const headRepo = str(record(record(pr.head).repo).full_name);
    const baseRepo = str(record(record(pr.base).repo).full_name);
    const fork = headRepo !== null && baseRepo !== null && headRepo.toLowerCase() !== baseRepo.toLowerCase();
    return {
      number,
      baseSha: str(record(pr.base).sha),
      headSha: str(record(pr.head).sha),
      readOnly: fork && ctx.eventName === "pull_request",
    };
  }
  // pr-number input or workflow_run: ask the API (workflow_run runs with the base repo's token).
  let info: PullInfo;
  try {
    info = await port.getPull(number);
  } catch (err) {
    // Fail closed: the number may come from an artifact a fork wrote, and an unreadable "pull
    // request" (an issue number, or an API error) cannot be checked against the run that made the plan.
    core.warning(
      `Not commenting on pull request #${number}: could not read it (${errorMessage(err)}). The review is in the job summary only.`,
    );
    return { number: null, baseSha: null, headSha: null, readOnly: false };
  }
  if (ctx.eventName === "workflow_run") {
    // The PR number may come from an artifact the fork's own run wrote: trust it only when that PR's
    // head is exactly the commit the triggering run built, from the same repository.
    const mismatch = workflowRunMismatch(record(payload.workflow_run), info);
    if (mismatch) {
      core.warning(
        `Not commenting on pull request #${number}: ${mismatch}. The PR number does not belong to the run that made this plan (or the PR has new commits since); the review is in the job summary only.`,
      );
      return { number: null, baseSha: null, headSha: null, readOnly: false };
    }
  }
  return { number, baseSha: info.baseSha, headSha: info.headSha, readOnly: false };
}

/** Why a pull request is not the one a workflow_run event's run built, or null when it is. */
export function workflowRunMismatch(run: Record<string, unknown>, pull: PullInfo): string | null {
  const sha = str(run.head_sha);
  if (sha === null) return "the workflow_run event has no head_sha to check it against";
  if (pull.headSha.toLowerCase() !== sha.toLowerCase())
    return `its head commit ${pull.headSha.slice(0, 12)} is not the commit the triggering run built (${sha.slice(0, 12)})`;
  const repo = str(record(run.head_repository).full_name);
  if (repo !== null && (pull.headRepo === null || pull.headRepo.toLowerCase() !== repo.toLowerCase()))
    return `its head repository ${pull.headRepo ?? "(unknown)"} is not the triggering run's (${repo})`;
  return null;
}

function noDiffWarning(pull: PullContext): string {
  return pull.number === null
    ? "Not a pull request run and no diff available: lineage cannot say which line of a PR causes a change."
    : "No PR diff could be obtained (git and the API both failed): lineage cannot say which line of the PR causes a change.";
}

// ───────────────────────────── plans ─────────────────────────────

const GLOB_CHARS = /[*?[\]{}]/;

async function findPlans(root: string, runnerTemp: string | null, config: ActionConfig): Promise<PlanFile[]> {
  const out = new Map<string, PlanFile>();
  for (const entry of config.plans) {
    const absolute = isAbsolute(entry.pattern);
    const matches: string[] = [];
    if (GLOB_CHARS.test(entry.pattern)) {
      for await (const m of glob(entry.pattern, { cwd: root })) matches.push(String(m));
      matches.sort();
    } else matches.push(entry.pattern);
    if (matches.length === 0) {
      throw new ConfigError(
        `plan-json: "${entry.pattern}" matches no file${absolute ? "" : " in the checkout"}.`,
      );
    }
    for (const m of matches) {
      let file: string;
      let path: string;
      if (absolute) {
        // A plan kept outside the checkout (e.g. a downloaded artifact): only under RUNNER_TEMP or the checkout.
        file = resolve(m);
        if (!isInside(file, root) && (runnerTemp === null || !isInside(file, runnerTemp)))
          throw new ConfigError(
            `plan-json: "${m}" is outside the checkout and RUNNER_TEMP; absolute plan paths must be under one of them.`,
          );
        path = file;
      } else {
        const rel = normalizeRepoPath(m);
        if (rel === null || rel === "")
          throw new ConfigError(`plan-json: "${m}" is not a path inside the repository.`);
        file = join(root, rel);
        path = rel;
      }
      const rootDir = normalizeRepoPath(entry.rootDir ?? posix.dirname(path));
      if (rootDir === null)
        throw new ConfigError(`plan-json: the root module dir of "${m}" is outside the repository.`);
      if (!out.has(file)) out.set(file, { file, path, rootDir });
    }
  }
  if (out.size > MAX_PLANS)
    throw new ConfigError(`plan-json matches ${out.size} files; at most ${MAX_PLANS}.`);
  return [...out.values()];
}

function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * The plan file's text, read only as a regular file that really lives in the checkout or RUNNER_TEMP.
 * In the fork pattern the checkout is the fork's tree: a symlinked plan path (or a symlinked
 * directory above it) could point anywhere on the runner, so it is refused rather than followed.
 */
async function readPlanFile(plan: PlanFile, allowed: readonly (string | null)[]): Promise<string> {
  const missing = (): PlanError =>
    new PlanError(
      `${plan.path}: cannot read the plan file. Write it with \`terraform show -json plan.out > ${plan.path}\` before this step.`,
    );
  let info;
  try {
    info = await lstat(plan.file);
  } catch {
    throw missing();
  }
  if (info.isSymbolicLink())
    throw new PlanError(
      `${plan.path}: the plan file is a symbolic link; plan files are read only as regular files (write the plan itself, or point plan-json at the real file).`,
    );
  if (!info.isFile()) throw new PlanError(`${plan.path}: not a regular file.`);
  const real = await realpath(plan.file).catch(() => null);
  const roots = await Promise.all(
    allowed.filter((d): d is string => d !== null).map((d) => realpath(d).catch(() => d)),
  );
  if (real === null || !roots.some((r) => isInside(real, r)))
    throw new PlanError(
      `${plan.path}: the plan file resolves outside the checkout and RUNNER_TEMP (through a symbolic link in its directory); refusing to read it.`,
    );
  // O_NOFOLLOW: the last component cannot have been swapped for a link since the checks above.
  const handle = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => {
    throw missing();
  });
  try {
    if (!(await handle.stat()).isFile()) throw new PlanError(`${plan.path}: not a regular file.`);
    // Bytes, not utf8: a UTF-16 plan (Windows PowerShell 5.1 `>`) decodes here.
    return decodePlanBytes(await handle.readFile());
  } finally {
    await handle.close();
  }
}

async function readPlan(plan: PlanFile, allowed: readonly (string | null)[]): Promise<unknown> {
  const path = plan.path;
  const text = await readPlanFile(plan, allowed);
  const wrapper = /^\[command\]|^::debug::|terraform-bin/m.test(text);
  try {
    const parsed = parsePlanText(text);
    if (wrapper || !text.trimStart().startsWith("{"))
      core.warning(`${path}: extra output around the plan JSON (${WRAPPER_HINT}).`);
    return parsed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PlanError(
      `${path}: ${message}${wrapper && !/terraform_wrapper/.test(message) ? ` (${WRAPPER_HINT})` : ""}`,
    );
  }
}

// ───────────────────────────── comment ─────────────────────────────

/** Create or update the sticky comment, unless a later run already wrote it; keeps reviewers' ticks. */
export async function upsertComment(
  port: GitHubPort,
  pr: number,
  reviews: readonly Review[],
  meta: ReportMeta,
  key?: string,
  scope?: string | null,
  plans?: readonly string[] | null,
): Promise<string | null> {
  const owner: CommentOwner | undefined =
    key !== undefined && scope && plans && plans.length > 0 && meta.run
      ? { scope, runId: meta.run.id, plans }
      : undefined;
  const existing = await port.findComment(pr, key, owner);
  if (existing && meta.run && isWrittenByNewerRun(existing.body, meta.run)) {
    core.info(`A newer run already updated the review comment (${existing.htmlUrl}); leaving it as is.`);
    return null;
  }
  // Findings the previous version showed stay in the data marker (with their ticks) when this plan
  // no longer has them: a confirmed finding the author then fixed must still count in the metrics.
  const recorded = existing ? parseEarlierFindings(existing.body) : [];
  const earlier = recorded.map((f) => ({ ...f, id: currentKey(f) }));
  // A tick on a finding the marker recorded travels under that finding's current key (in `earlier`):
  // a legacy bare key may now belong to another root's finding. Unrecorded ticks keep their key.
  const recordedIds = new Set(recorded.map((f) => f.id));
  const body = renderReviewComment(reviews, meta, {
    confirmedIds: existing
      ? [
          ...[...parseConfirmedIds(existing.body)].filter((id) => !recordedIds.has(id)),
          ...earlier.filter((f) => f.confirmed).map((f) => f.id),
        ]
      : [],
    earlier,
    ...(key !== undefined && { key }),
    ...(scope && { scope }),
    ...(plans && plans.length > 0 && { plans }),
  });
  if (existing && existing.body === body) return existing.htmlUrl;
  const posted = existing ? await port.updateComment(existing.id, body) : await port.createComment(pr, body);
  core.info(`${existing ? "Updated" : "Posted"} the review comment: ${posted.htmlUrl}`);
  return posted.htmlUrl;
}

/**
 * A checkbox key as this version writes it. Comments from before root-qualified keys used the bare
 * finding id (plus `~n` for a repeat): re-key those by their recorded root, so ticks carry over.
 */
function currentKey(f: { id: string; root: string }): string {
  if (f.root === "" || /:[0-9a-f]{8}(?:~\d+)?$/.test(f.id)) return f.id;
  return checkboxId(f.id.replace(/~\d+$/, ""), f.root);
}

/**
 * Which sticky comment this run owns: the comment-key input, or else the plan-json entries. Matrix
 * jobs of one run (one job per environment) then keep one comment each instead of overwriting each
 * other's. Hashed, so the hidden stamp is short and holds no paths.
 */
export function commentKey(config: ActionConfig, root: string, runnerTemp: string | null): string {
  const scope = config.commentKey ?? planEntries(config, root, runnerTemp).join("\n");
  return createHash("sha256").update(scope).digest("hex").slice(0, 12);
}

/** At most this many plan-json entries are recorded in the stamp; a longer list records none. */
const MAX_STAMPED_PLANS = 64;

/**
 * One short hash per plan-json entry, recorded with the key so a later run of the same job can tell
 * whether a comment under another key reviews the same plans (an entry added, removed or respelled)
 * or other ones (a matrix sibling). Null with an explicit comment-key: the user names the comment,
 * so it is never taken over and never takes another over.
 */
export function commentPlans(config: ActionConfig, root: string, runnerTemp: string | null): string[] | null {
  if (config.commentKey !== null) return null;
  const entries = planEntries(config, root, runnerTemp);
  if (entries.length === 0 || entries.length > MAX_STAMPED_PLANS) return null;
  return entries.map((e) => createHash("sha256").update(e).digest("hex").slice(0, 8));
}

/** The plan-json entries, normalized (`plan.json`, `./plan.json` and `a//plan.json` are one), deduplicated and sorted. */
function planEntries(config: ActionConfig, root: string, runnerTemp: string | null): string[] {
  return [
    ...new Set(
      config.plans.map((e) => {
        let pattern = e.pattern.replace(/\\/g, "/");
        if (isAbsolute(pattern)) {
          const abs = resolve(pattern);
          // Runner paths differ between machines: key absolute plans by where they sit, not by the runner's layout.
          if (runnerTemp !== null && isInside(abs, runnerTemp))
            pattern = `$RUNNER_TEMP/${relative(runnerTemp, abs).replace(/\\/g, "/")}`;
          else if (isInside(abs, root)) pattern = relative(root, abs).replace(/\\/g, "/");
        }
        const rootDir = e.rootDir === null ? "" : (normalizeRepoPath(e.rootDir) ?? e.rootDir);
        return `${normalizeRepoPath(pattern) ?? pattern}=${e.rootDir === null ? "" : rootDir || "."}`;
      }),
    ),
  ].sort();
}

/**
 * Which workflow job writes the comment: a hash of the workflow file and the job id (null when the
 * runner does not say). Lets a job take over the comment it wrote before its plan-json changed.
 */
export function commentScope(env: NodeJS.ProcessEnv): string | null {
  const workflow = (env.GITHUB_WORKFLOW_REF ?? "").replace(/@.*$/, "") || env.GITHUB_WORKFLOW || "";
  const job = env.GITHUB_JOB ?? "";
  if (workflow === "" || job === "") return null;
  return createHash("sha256").update(`${workflow}\n${job}`).digest("hex").slice(0, 12);
}

// ───────────────────────────── helpers ─────────────────────────────

function maxSeverity(severities: readonly Severity[]): string {
  for (const s of SEVERITY_ORDER) if (severities.includes(s)) return s;
  return "none";
}

function displayDir(dir: string): string {
  return dir === "" ? "." : dir;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
