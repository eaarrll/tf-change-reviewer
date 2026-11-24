/*
 * Orchestration and merge policy (DESIGN.md "Merge policy"): load and mask the plan, parse the PR
 * diff, score every change, trace the candidates back to the code, optionally let the agent confirm,
 * demote, add and explain, then merge everything into one Review.
 *
 *   loadPlan → parseUnifiedDiff → scorePlan → traceChange (≤ 60 candidates, memoized)
 *   → escalateForLineage + diff-only rules (prevent_destroy removed, provider-induced replacement)
 *   → runAgentReview (optional, fails open) → merge → group by root cause → cap → Review
 *
 * Nothing that leaves this function carries a sensitive value: the plan is masked on load, and
 * every piece of text from outside the plan (source snippets, the diff the agent reads, model
 * output) is scrubbed of the values the plan marks sensitive (value equality, see scrub.ts).
 */
import { posix } from "node:path";
import { runAgentReview } from "./agent/agent.js";
import { isDeniedPath } from "./agent/tools.js";
import {
  causedByVersionBump,
  deterministicCause,
  deterministicConfidence,
  deterministicImpact,
  deterministicTitle,
  findingId,
  groupByRootCause,
  lineageCauseLinks,
  lowerConfidence,
  notExplained,
  PLAN_WIDE_RULES,
  primaryRule,
} from "./findings.js";
import { emptyDiff, normalizePath, parseUnifiedDiff } from "./git/diff.js";
import { causePaths } from "./lineage/chain.js";
import { parseHcl } from "./lineage/hcl.js";
import { makeSnippet, SourceIndex } from "./lineage/source.js";
import { parsePatches, reconstructBase, traceChange, type TraceContext } from "./lineage/trace.js";
import { loadPlan, planSecrets } from "./plan/load.js";
import { isPrefix, pathKey } from "./plan/paths.js";
import { locationLabel } from "./report/links.js";
import { isTagPath, raiseSeverity, severityRank } from "./risk/rules.js";
import { escalateForLineage, isDestroyPlan, scorePlan, withSignals } from "./risk/score.js";
import { stillReferencedSignals } from "./references.js";
import { createScrubber, type Scrubber } from "./scrub.js";
import { isPlanOrStateText, normalizeRepoPath } from "./workspace.js";
import { SEVERITY_ORDER } from "./types.js";
import type {
  AgentInput,
  AgentOutcome,
  AgentToolContext,
  AttrPath,
  CauseLink,
  Confidence,
  Finding,
  Lineage,
  PlanModel,
  ResourceChange,
  Review,
  SourceLocation,
  ReviewInput,
  RiskSignal,
  ScoredChange,
  Severity,
  Workspace,
} from "./types.js";

/** Candidates traced per review (memoized per address + attribute; the agent may trace more). */
export const MAX_TRACED = 60;
/** Candidates handed to the agent in the digest. */
const MAX_AGENT_CANDIDATES = 40;
export const DEFAULT_MAX_FINDINGS = 7;

const FINDING_SEVERITIES = new Set<Severity>(["critical", "high"]);
const CANDIDATE_SEVERITIES = new Set<Severity>(["critical", "high", "medium"]);
const TRACED_ACTIONS = new Set(["replace", "delete", "forget"]);

type FindingSeverity = Finding["severity"];

/** One change on its way to becoming a finding. */
interface Draft {
  scored: ScoredChange;
  severity: FindingSeverity;
  origin: Finding["origin"];
  confidence: Confidence;
  lineage: Lineage | null;
  agent?: { title: string; impact: string; cause: string; links: CauseLink[] };
  /** The agent dismissed this critical finding; it stays, with the reason. */
  dismissal?: string;
}

/** Review one plan (one root module). Throws PlanError for input that is not a usable plan. */
export async function reviewPlan(input: ReviewInput): Promise<Review> {
  const logger = input.logger;
  const plan = loadPlan(input.planJson);
  const scrub = createScrubber(planSecrets(plan));
  const warnings: string[] = [];
  const notices = planNotices(plan);
  const maxFindings =
    Number.isFinite(input.maxFindings) && input.maxFindings >= 0
      ? Math.floor(input.maxFindings)
      : DEFAULT_MAX_FINDINGS;

  const diffText = input.diffText;
  const diff = diffText === null ? emptyDiff() : parseUnifiedDiff(diffText);
  if (diffText === null)
    notices.push(
      "No PR diff was available, so the changed lines are unknown: the findings below are not traced to a line of this PR, and none is claimed to come from outside it.",
    );

  let scored = scorePlan(plan);
  const total = scored.length;
  logger?.info(`Plan: ${total} change(s) to review, ${changedOutside(plan)} drifted resource(s).`);

  // ── lineage ──
  const changesByAddress = new Map<string, ResourceChange>();
  for (const c of plan.changes) {
    if (!changesByAddress.has(c.address) || c.deposed === undefined) changesByAddress.set(c.address, c);
  }
  const source = new SourceIndex(input.workspace, plan);
  const traceCtx: TraceContext = { plan, source, diff, diffText, changesByAddress };
  const memo = new Map<string, Promise<Lineage>>();
  const trace = (change: ResourceChange, attribute?: AttrPath | AttrPath[]): Promise<Lineage> => {
    const attrKey =
      attribute === undefined
        ? "*"
        : isPathList(attribute)
          ? attribute.map(pathKey).join("|")
          : pathKey(attribute);
    const key = `${change.address}\u0000${change.deposed ?? ""}\u0000${attrKey}`;
    let p = memo.get(key);
    if (!p) {
      p = traceChange(change, traceCtx, attribute).then((l) => scrubLineage(l, scrub));
      memo.set(key, p);
    }
    return p;
  };

  // A destroy plan destroys everything because of -destroy, not because of a line of code: its
  // deletes have no cause chain to trace (and none is "not explained by this PR").
  const destroyPlan = isDestroyPlan(plan);
  const candidates = destroyPlan
    ? []
    : scored.filter((s) => CANDIDATE_SEVERITIES.has(s.severity) || TRACED_ACTIONS.has(s.change.action));
  if (candidates.length > MAX_TRACED) {
    warnings.push(
      `Traced the ${MAX_TRACED} highest-ranked of ${candidates.length} candidate changes; the rest are listed without a cause chain.`,
    );
  }
  const lineageOf = new Map<ScoredChange["change"], Lineage>();
  for (const sc of candidates.slice(0, MAX_TRACED)) {
    lineageOf.set(sc.change, await bestLineage(sc, trace));
  }

  // ── rules that need the lineage or the diff ──
  const protectionRemoved =
    diffText === null ? new Set<string>() : await preventDestroyRemoved(diffText, input.workspace);
  // Without a diff nothing can be called "not explained by this PR": the changed lines are unknown.
  const diffKnown = diffText !== null;
  const references = stillReferencedSignals(plan);
  scored = scored.map((sc) => {
    const lineage = lineageOf.get(sc.change) ?? null;
    const escalated = lineage && diffKnown ? escalateForLineage(sc, lineage) : sc;
    const extra = [...lineageSignals(escalated, lineage, diffKnown), ...(references.get(sc.change) ?? [])];
    return withSignals(escalated, extra);
  });
  scored = await preventDestroySignals(scored, protectionRemoved, source);
  const massDestroy = scored.flatMap((sc) => sc.signals).find((s) => PLAN_WIDE_RULES.has(s.ruleId));
  if (massDestroy) notices.push(massDestroy.reason);
  scored.sort(compareScored);

  // ── agent (optional, fails open) ──
  let outcome: AgentOutcome | null = null;
  // What the agent (and its cited lines) may see: file text scrubbed of the plan's sensitive values.
  const agentWorkspace = scrubbedWorkspace(input.workspace, scrub);
  if (input.agent) {
    const ctx: AgentToolContext = {
      plan,
      scored,
      getLineage: async (address, attribute) => {
        const change = changesByAddress.get(address);
        return change && change.action !== "no-op" ? trace(change, attribute) : null;
      },
      workspace: agentWorkspace,
      diffText: diffText === null ? null : scrub.text(diffText),
    };
    const agentInput: AgentInput = {
      ctx,
      candidates: scored
        .filter((s) => CANDIDATE_SEVERITIES.has(s.severity))
        .slice(0, MAX_AGENT_CANDIDATES)
        .map((s) => ({ scored: s, lineage: lineageOf.get(s.change) ?? null })),
    };
    outcome = await runAgentReview(agentInput, {
      ...input.agent,
      ...(input.agent.logger === undefined && logger !== undefined && { logger }),
    });
    if (!outcome.verdict && outcome.info.status !== "skipped") {
      warnings.push(
        `The AI review did not finish (${outcome.info.status}); the findings come from the deterministic rules only.`,
      );
    }
  }

  // ── merge ──
  const drafts = new Map<ScoredChange, Draft>();
  const drafted = new Set<string>();
  for (const sc of scored) {
    // One finding per address: a deposed leftover of the same address stays under other changes.
    if (!FINDING_SEVERITIES.has(sc.severity) || drafted.has(sc.change.address)) continue;
    drafted.add(sc.change.address);
    const lineage = lineageOf.get(sc.change) ?? null;
    drafts.set(sc, {
      scored: sc,
      severity: sc.severity as FindingSeverity,
      origin: "rules",
      confidence: deterministicConfidence(lineage),
      lineage,
    });
  }
  const others = new Map<ScoredChange, ScoredChange>(); // original → shown in "other changes"
  if (outcome?.verdict) {
    await mergeVerdict(outcome.verdict, {
      scored,
      drafts,
      others,
      warnings,
      lineageOf,
      trace,
      workspace: agentWorkspace,
      diff,
    });
  }

  // ── findings ──
  const ranked = [...drafts.values()].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || compareScored(a.scored, b.scored),
  );
  const byAddress = new Map(ranked.map((d) => [d.scored.change.address, d]));
  let findings = ranked.map((d) => toFinding(d, plan, diffKnown));
  findings = groupByRootCause(findings).map((f) => {
    if (!f.relatedAddresses?.length) return f;
    const d = byAddress.get(f.address);
    if (!d || f.origin !== "rules") return f;
    const external = diffKnown && d.lineage?.explanation === "external";
    return { ...f, title: deterministicTitle(d.scored, f.relatedAddresses.length, external) };
  });
  const shown = findings.slice(0, maxFindings);
  if (findings.length > shown.length) {
    warnings.push(
      `${plural(findings.length - shown.length, "more finding")} beyond max-findings (${maxFindings}) ${findings.length - shown.length === 1 ? "is" : "are"} listed under other changes.`,
    );
  }
  const represented = new Set<string>();
  for (const f of shown) {
    represented.add(f.address);
    for (const a of f.relatedAddresses ?? []) represented.add(a);
  }
  const shownDrafts = new Set(
    [...drafts.values()].filter((d) => represented.has(d.scored.change.address)).map((d) => d.scored),
  );
  const otherList = scored
    .filter((sc) => !shownDrafts.has(sc))
    .map((sc) => others.get(sc) ?? sc)
    .sort(compareScored);

  const bySeverity: Partial<Record<Severity, number>> = {};
  // The summary's split leaves out data source reads, which it counts apart ("and N data source reads").
  const changeSeverity: Partial<Record<Severity, number>> = {};
  for (const sc of scored) {
    bySeverity[sc.severity] = (bySeverity[sc.severity] ?? 0) + 1;
    if (sc.change.action !== "read") changeSeverity[sc.severity] = (changeSeverity[sc.severity] ?? 0) + 1;
  }

  const review: Review = {
    rootModuleDir: input.workspace.rootModuleDir,
    findings: shown.map((f) => scrubFinding(f, scrub)),
    others: otherList.map((sc) => scrubScored(sc, scrub)),
    stats: { totalChanges: total, counts: { ...plan.counts }, bySeverity },
    summary: scrub.text(
      outcome?.verdict?.summary.trim() || deterministicSummary(plan, shown, total, diffKnown, changeSeverity),
    ),
    ...(outcome && {
      agent: {
        ...outcome.info,
        ...(outcome.info.error !== undefined && { error: scrub.text(outcome.info.error) }),
      },
    }),
    ...(notices.length > 0 && { notices: notices.map((n) => scrub.text(n)) }),
    warnings: warnings.map((w) => scrub.text(w)),
  };
  logger?.info(
    `Review: ${review.findings.length} finding(s), ${review.others.length} other change(s), ${memo.size} trace(s).`,
  );
  return review;
}

// ───────────────────────────── plan status ─────────────────────────────

/** Banners for plans a reviewer cannot take at face value (PLAN-11 plan-health banner). */
export function planNotices(plan: PlanModel): string[] {
  const out: string[] = [];
  if (isDestroyPlan(plan))
    out.push(
      "This is a destroy plan (terraform plan -destroy or terraform destroy): applying it destroys every resource listed below, whatever the configuration says.",
    );
  if (plan.errored)
    out.push(
      "This plan errored: Terraform stopped planning part-way, so it is incomplete and cannot be applied. Fix the error and review the new plan; changes after the error are missing here.",
    );
  // An errored plan is also complete:false; the errored banner already says why, so the -target
  // guess would be wrong.
  if (plan.complete === false && !plan.errored) {
    const deferred = plan.deferredChanges ?? 0;
    out.push(
      deferred > 0
        ? `This plan is partial: ${plural(deferred, "change")} ${deferred === 1 ? "is" : "are"} deferred to a later plan, so resources outside it are not reviewed here.`
        : "This plan is partial (made with -target or similar): resources outside the targets are not planned and not reviewed here.",
    );
  }
  if (plan.configurationMissing)
    out.push(
      "This plan JSON has no configuration section (`terraform show -json` always writes one), so resource blocks and module calls are read from the repository instead; cause tracing may be less accurate.",
    );
  if (plan.applyable === false && !plan.errored)
    out.push("Terraform marks this plan as not applyable: applying it will fail or do nothing.");
  return out;
}

// ───────────────────────────── candidates ─────────────────────────────

/** Attributes traced per candidate, one lineage each; the best explained one is kept. */
const MAX_TRACED_ATTRIBUTES = 4;

/** Paths of a candidate's own risk signals (most severe first), a whole-block signal through its changed leaves. */
function signalPaths(sc: ScoredChange): AttrPath[] {
  const c = sc.change;
  const leaves = [...c.changedPaths, ...c.sensitiveChangedPaths, ...c.unknownPaths];
  const paths = sc.signals
    .filter((s) => s.severity !== "noise" && s.path && s.path.length && !s.path.includes("*"))
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
    .map((s) => s.path as AttrPath);
  return paths.flatMap((p) => {
    const below = leaves.filter((l) => l.length > p.length && isPrefix(p, l));
    return below.length ? below.slice(0, 2) : [p];
  });
}

/**
 * The attributes to trace for a candidate, most relevant first: for a replacement its replace
 * paths (those a risk signal is about first), for an update the paths of its risk signals (most
 * severe first). `undefined` = the tracer's default (the whole resource for creates and deletes, the
 * changed paths for an update without attribute signals).
 */
export function traceAttributes(sc: ScoredChange): (AttrPath | undefined)[] {
  const c = sc.change;
  if (c.action !== "replace" && c.action !== "update" && c.action !== "import") return [undefined];
  const expanded = signalPaths(sc);
  // No attribute-specific signal: the changed attributes, tags last (default_tags churn rides along).
  const changed = [...c.changedPaths, ...c.sensitiveChangedPaths].filter((p) => p.length > 0);
  const fallback = expanded.length
    ? []
    : [...changed.filter((p) => !isTagPath(p)), ...changed.filter((p) => isTagPath(p))];
  const ordered = c.action === "replace" ? [...expanded, ...c.replacePaths] : [...expanded, ...fallback];
  const allowed = c.action === "replace" ? new Set(c.replacePaths.map(pathKey)) : null;
  return dedupePaths(ordered, allowed);
}

function dedupePaths(paths: readonly AttrPath[], allowed: Set<string> | null): (AttrPath | undefined)[] {
  const seen = new Set<string>();
  const out: AttrPath[] = [];
  for (const p of paths) {
    const key = pathKey(p);
    if (seen.has(key) || (allowed && !allowed.has(key))) continue;
    seen.add(key);
    out.push(p);
  }
  return out.length ? out.slice(0, MAX_TRACED_ATTRIBUTES) : [undefined];
}

/** Several risk signals on different attributes of an update: traced together, so each one's cause shows. */
function multiSignalPaths(sc: ScoredChange): AttrPath[] | null {
  const c = sc.change;
  if (c.action !== "update" && c.action !== "import") return null;
  const paths = dedupePaths(signalPaths(sc), null).filter((p): p is AttrPath => p !== undefined);
  return paths.length >= 2 ? paths : null;
}

const EXPLANATION_RANK: Record<Lineage["explanation"], number> = {
  diff: 0,
  upstream: 1,
  external: 2,
  unknown: 3,
};

type TraceFn = (change: ResourceChange, attribute?: AttrPath | AttrPath[]) => Promise<Lineage>;

/** Traces each attribute (in order) and keeps the best explained lineage; stops at the first PR cause. */
async function bestLineage(sc: ScoredChange, trace: TraceFn): Promise<Lineage> {
  const multi = multiSignalPaths(sc);
  if (multi) {
    const lineage = await trace(sc.change, multi);
    if (lineage.explanation === "diff") return lineage;
  }
  let best: Lineage | null = null;
  for (const attribute of traceAttributes(sc)) {
    const lineage = await trace(sc.change, attribute);
    if (!best || EXPLANATION_RANK[lineage.explanation] < EXPLANATION_RANK[best.explanation]) best = lineage;
    if (best.explanation === "diff") break;
  }
  return best as Lineage;
}

function isPathList(a: AttrPath | AttrPath[]): a is AttrPath[] {
  return a.length > 0 && a.every((p) => Array.isArray(p));
}

function compareScored(a: ScoredChange, b: ScoredChange): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.change.address !== b.change.address) return a.change.address < b.change.address ? -1 : 1;
  return (a.change.deposed ?? "") < (b.change.deposed ?? "") ? -1 : 1;
}

// ───────────────────────────── diff- and lineage-based rules ─────────────────────────────

const PREVENT_DESTROY = /\bprevent_destroy\s*=\s*true\b/;

/**
 * PLAN-13: resources whose `prevent_destroy = true` line the PR removes (or flips), as
 * "<dir>|<type>.<name>" in the base version. Lifecycle is not in the plan JSON, so this reads the diff.
 */
async function preventDestroyRemoved(diffText: string, workspace: Workspace): Promise<Set<string>> {
  const out = new Set<string>();
  if (!diffText.includes("prevent_destroy")) return out;
  for (const patch of parsePatches(diffText)) {
    const old = patch.oldPath;
    if (!old || !old.endsWith(".tf")) continue;
    const removed = patch.hunks.some((h) =>
      h.lines.some((l) => l.type === "-" && PREVENT_DESTROY.test(l.text)),
    );
    if (!removed) continue;
    const head = patch.newPath ? await workspace.readFile(patch.newPath).catch(() => null) : null;
    const base = reconstructBase(patch, head);
    const lines = base.split(/\r?\n/);
    const body = parseHcl(base);
    for (const line of patch.removed) {
      if (!PREVENT_DESTROY.test(lines[line - 1] ?? "")) continue;
      const block = body.blocks.find(
        (b) => b.type === "resource" && b.startLine <= line && line <= b.endLine,
      );
      if (block?.labels[0] && block.labels[1]) {
        const dir = normalizePath(posix.dirname(old)).replace(/^\.$/, "");
        out.add(`${dir}|${block.labels[0]}.${block.labels[1]}`);
      }
    }
  }
  return out;
}

/** Signals that need the lineage: provider-induced replacement, unexplained material updates. */
function lineageSignals(sc: ScoredChange, lineage: Lineage | null, diffKnown: boolean): RiskSignal[] {
  const c = sc.change;
  const out: RiskSignal[] = [];
  const destroy = c.action === "replace" || c.action === "delete";
  // PLAN-12: a replacement whose only cause in the PR is a module or provider version change.
  if (destroy && causedByVersionBump(lineage)) {
    out.push({
      ruleId: "version-bump-replace",
      severity: severityRank(sc.severity) <= severityRank("high") ? sc.severity : "high",
      reason:
        "A provider or module version change in this PR, not a configuration edit, causes this replacement; check the upgrade notes before applying.",
    });
  }
  // A material in-place update that no line of the PR explains (drift revert, injected value).
  if (
    diffKnown &&
    (c.action === "update" || c.action === "import") &&
    lineage?.explanation === "external" &&
    severityRank(sc.severity) <= severityRank("medium") &&
    !sc.signals.some((s) => s.ruleId === "not-explained-by-diff")
  ) {
    out.push({
      ruleId: "not-explained-by-diff",
      // medium → high; never raised to critical on this ground alone.
      severity: sc.severity === "medium" ? raiseSeverity(sc.severity) : sc.severity,
      reason: "No line in this PR causes this change.",
    });
  }
  return out;
}

/** Adds the PLAN-13 signal to destroyed resources whose prevent_destroy the PR removed. */
async function preventDestroySignals(
  scored: ScoredChange[],
  protection: Set<string>,
  source: SourceIndex,
): Promise<ScoredChange[]> {
  if (!protection.size) return scored;
  const out: ScoredChange[] = [];
  for (const sc of scored) {
    const c = sc.change;
    if (c.action !== "replace" && c.action !== "delete") {
      out.push(sc);
      continue;
    }
    const dir = await source.moduleDir(c.configModulePath);
    const key = `${dir ?? "?"}|${c.type}.${c.name}`;
    out.push(
      protection.has(key)
        ? withSignals(sc, [
            {
              ruleId: "prevent-destroy-removed",
              severity: "critical",
              reason:
                "This PR removes prevent_destroy from the resource in the same change that destroys it: the guard was disarmed on purpose, so confirm the data is no longer needed.",
            },
          ])
        : sc,
    );
  }
  return out;
}

// ───────────────────────────── agent merge ─────────────────────────────

interface MergeState {
  scored: ScoredChange[];
  drafts: Map<ScoredChange, Draft>;
  others: Map<ScoredChange, ScoredChange>;
  warnings: string[];
  lineageOf: Map<ResourceChange, Lineage>;
  trace: TraceFn;
  /** The scrubbed workspace the agent saw. */
  workspace: Workspace;
  diff: ReturnType<typeof emptyDiff>;
}

async function mergeVerdict(verdict: NonNullable<AgentOutcome["verdict"]>, st: MergeState): Promise<void> {
  const byAddress = new Map<string, ScoredChange>();
  for (const sc of st.scored) {
    if (!byAddress.has(sc.change.address) || sc.change.deposed === undefined)
      byAddress.set(sc.change.address, sc);
  }
  const lines = new Map<string, Promise<string[] | null>>();
  const fileLines = (file: string): Promise<string[] | null> => {
    let p = lines.get(file);
    if (!p) {
      p = st.workspace
        .readFile(file)
        .then((t) => (t === null ? null : t.split(/\r?\n/)))
        .catch(() => null);
      lines.set(file, p);
    }
    return p;
  };

  let badAddresses = 0;
  let badRefs = 0;
  let refusedRefs = 0;
  // Files a traced file()/templatefile() step reads: a cause may live there (policy JSON, user data).
  const lineageFiles = new Set<string>();
  const noteFiles = (l: Lineage | null | undefined): void => {
    for (const s of l?.steps ?? [])
      if (s.kind === "file_content" && s.location) lineageFiles.add(s.location.file);
  };
  for (const l of st.lineageOf.values()) noteFiles(l);
  const flagged = new Set<string>();
  for (const af of verdict.findings) {
    const sc = byAddress.get(af.address);
    if (!sc) {
      badAddresses++;
      continue;
    }
    flagged.add(af.address);
    const existing = st.drafts.get(sc);
    const lineage = existing
      ? existing.lineage
      : (st.lineageOf.get(sc.change) ?? (await st.trace(sc.change)));
    noteFiles(lineage);
    const links: CauseLink[] = [];
    for (const ref of af.causeRefs) {
      const file = normalizeRepoPath(ref.file);
      if (file && !citable(file, lineageFiles)) {
        refusedRefs++;
        continue;
      }
      const text = file ? await fileLines(file) : null;
      if (!file || !text || !Number.isSafeInteger(ref.line) || ref.line < 1 || ref.line > text.length) {
        badRefs++;
        continue;
      }
      if (isPlanOrStateText(text.join("\n"))) {
        refusedRefs++;
        continue;
      }
      const location = { file, startLine: ref.line, endLine: ref.line };
      const snippet = makeSnippet(text.join("\n"), ref.line, ref.line).split("\n")[0] ?? "";
      links.push({
        location,
        label: `${locationLabel(location)} ${snippet}`.trim(),
        changedInDiff: st.diff.touches(file, ref.line, ref.line),
      });
    }
    const agentText = { title: af.title, impact: af.impact, cause: af.cause, links };
    if (existing) {
      existing.origin = "both";
      existing.agent = agentText;
      existing.confidence = af.confidence;
      // The agent may demote, but a deterministic critical stays critical.
      if (existing.severity !== "critical") existing.severity = af.severity;
    } else {
      st.drafts.set(sc, {
        scored: sc,
        severity: af.severity,
        origin: "agent",
        confidence: af.confidence,
        lineage,
        agent: agentText,
      });
    }
  }

  for (const d of verdict.dismissed) {
    if (flagged.has(d.address)) continue; // it also raised a finding there: the finding wins
    const sc = byAddress.get(d.address);
    const draft = sc ? st.drafts.get(sc) : undefined;
    if (!sc || !draft) continue;
    const reason = d.reason.trim() || "no reason given";
    if (draft.severity === "critical") {
      draft.dismissal = reason;
      draft.confidence = lowerConfidence(draft.confidence);
    } else {
      st.drafts.delete(sc);
      st.others.set(
        sc,
        withSignals(
          sc,
          [
            {
              ruleId: "agent-dismissed",
              severity: sc.severity,
              reason: `Dismissed by the AI review: ${reason}`,
            },
          ],
          "first",
        ),
      );
    }
  }

  if (badAddresses > 0)
    st.warnings.push(
      `The AI review named ${badAddresses} address(es) that do not change in this plan; those findings were dropped.`,
    );
  if (badRefs > 0)
    st.warnings.push(
      `The AI review cited ${plural(badRefs, "line")} that do not exist in the repository; those references were dropped.`,
    );
  if (refusedRefs > 0)
    st.warnings.push(
      `The AI review cited ${plural(refusedRefs, "line")} outside the Terraform sources (state, plan, credential or other files); those references were dropped.`,
    );
}

/** Terraform and OpenTofu sources: the only files a cause link from the AI review may point into. */
const CITABLE_SUFFIXES = [".tf", ".tf.json", ".tfvars", ".tfvars.json", ".hcl", ".tofu"];

/**
 * Whether the AI review may cite `file`: a Terraform source, or a file a traced file() step reads,
 * and never a state, plan, key or credential file (DENIED_FILES, as for the read_file tool).
 */
function citable(file: string, lineageFiles: ReadonlySet<string>): boolean {
  if (isDeniedPath(file)) return false;
  const lower = file.toLowerCase();
  return CITABLE_SUFFIXES.some((s) => lower.endsWith(s)) || lineageFiles.has(file);
}

// ───────────────────────────── findings ─────────────────────────────

function toFinding(d: Draft, plan: PlanModel, diffKnown: boolean): Finding {
  const c = d.scored.change;
  // The title says so only when tracing positively found no PR cause ("external").
  const unexplained = diffKnown && d.lineage?.explanation === "external";
  const ruleLinks = lineageCauseLinks(d.lineage);
  const links = d.agent ? mergeLinks(d.agent.links, ruleLinks) : ruleLinks;
  let cause = d.agent?.cause.trim() || deterministicCause(c, d.lineage, plan);
  if (d.dismissal) {
    cause += ` The AI review dismissed this finding ("${d.dismissal}"); it stays because the rules rate it critical.`;
  }
  return {
    id: findingId(c.address, primaryRule(d.scored)),
    address: c.address,
    action: c.action,
    severity: d.severity,
    title: d.agent?.title.trim() || deterministicTitle(d.scored, 0, unexplained),
    impact: d.agent?.impact.trim() || deterministicImpact(d.scored),
    cause,
    causeLinks: links,
    ...(d.agent && { agentCauseLinks: d.agent.links }),
    ...(d.lineage && { lineage: d.lineage }),
    signals: d.scored.signals,
    confidence: d.confidence,
    origin: d.origin,
  };
}

function mergeLinks(first: CauseLink[], second: CauseLink[]): CauseLink[] {
  const seen = new Set<string>();
  const out: CauseLink[] = [];
  for (const l of [...first, ...second]) {
    const key = `${l.location.side ?? "head"}|${l.location.file}|${l.location.startLine}|${l.location.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

/**
 * One paragraph that adds to the headline rather than repeating it: how the changes split by
 * severity, which changed lines the findings trace back to, and how many no line of the PR explains.
 */
function deterministicSummary(
  plan: PlanModel,
  findings: Finding[],
  total: number,
  diffKnown: boolean,
  bySeverity: Partial<Record<Severity, number>>,
): string {
  // Data source reads are counted apart, as in the headline's "of M in the plan".
  const reads = Math.min(total, plan.counts.read ?? 0);
  const changes = total - reads;
  const readNote = reads > 0 ? ` (and ${plural(reads, "data source read")})` : "";
  if (changes === 0) {
    // An errored or partial plan does not show that everything matches the configuration.
    if (plan.errored)
      return `No changes were planned before the plan errored${readNote}, so this does not show that the infrastructure matches the configuration.`;
    if (plan.complete === false)
      return `No changes among the resources this partial plan covers${readNote}; resources outside it were not planned.`;
    if (findings.length === 0 && reads > 0)
      return `No changes to apply; the plan only reads ${plural(reads, "data source")}.`;
    if (findings.length === 0) {
      const drifted = changedOutside(plan);
      return drifted > 0
        ? `No changes to apply. Terraform detected ${plural(drifted, "object")} changed outside Terraform that the configuration already matches.`
        : "No changes: the infrastructure matches the configuration.";
    }
  }
  const split = SEVERITY_ORDER.filter((s) => (bySeverity[s] ?? 0) > 0)
    .map((s) => `${bySeverity[s]} ${s}`)
    .join(", ");
  if (findings.length === 0)
    return `None of the ${plural(changes, "change")}${readNote} needs your attention (${split}).`;
  const parts: string[] = [];
  const affected = findings.reduce((n, f) => n + 1 + (f.relatedAddresses?.length ?? 0), 0);
  const kinds = SEVERITY_ORDER.map((s) => [s, findings.filter((f) => f.severity === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`)
    .join(", ");
  parts.push(
    `${findings.length === 1 ? "1 finding" : `${findings.length} findings`} (${kinds})${affected > findings.length ? ` covering ${plural(affected, "change")}` : ""}; all changes by severity: ${split}.`,
  );
  const byRoot = new Map<string, number>();
  for (const f of findings) {
    const roots = rootLines(f);
    if (!roots.length) continue;
    const key = joinLines(roots);
    byRoot.set(key, (byRoot.get(key) ?? 0) + 1 + (f.relatedAddresses?.length ?? 0));
  }
  if (byRoot.size > 0) {
    const listed = [...byRoot.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([where, n]) => `${where} (${plural(n, "change")})`);
    const more = byRoot.size > 4 ? `, and ${byRoot.size - 4} more` : "";
    parts.push(`Lines this PR changed that cause them: ${listed.join(", ")}${more}.`);
  }
  if (diffKnown) {
    const unexplained = findings.filter((f) => f.lineage && notExplained(f.lineage)).length;
    if (unexplained > 0)
      parts.push(
        unexplained === 1
          ? "1 finding is not explained by this PR's diff."
          : `${unexplained} findings are not explained by this PR's diff.`,
      );
  }
  return parts.join(" ");
}

/**
 * Drift entries that changed the object outside Terraform. A refresh also reports objects that only
 * moved to a new address (a moved block: no-op with previous_address); nothing changed those.
 */
function changedOutside(plan: PlanModel): number {
  return plan.drift.filter(
    (d) =>
      (d.action !== "no-op" && d.action !== "move") ||
      d.changedPaths.length > 0 ||
      d.sensitiveChangedPaths.length > 0,
  ).length;
}

/** Where a finding's explaining branches end: the changed lines that cause it. */
function rootLines(f: Finding): SourceLocation[] {
  const l = f.lineage;
  if (!l || !l.rootCauseIds.length) return [];
  return causePaths(l, Number.POSITIVE_INFINITY)
    .map((p) => p[p.length - 1]!)
    .filter((s) => l.rootCauseIds.includes(s.id) && s.location)
    .map((s) => s.location!);
}

/** "terraform.tfvars:12, 13 and 14", "main.tf:4 and vars.tf:2". */
function joinLines(locs: readonly SourceLocation[]): string {
  const byFile = new Map<string, string[]>();
  for (const loc of locs) {
    const label = locationLabel(loc);
    const file = label.slice(0, label.lastIndexOf(":"));
    const rest = label.slice(label.lastIndexOf(":") + 1);
    const list = byFile.get(file) ?? [];
    if (!list.includes(rest)) list.push(rest);
    byFile.set(file, list);
  }
  const parts = [...byFile.entries()].map(([file, lines]) => `${file}:${listWords(lines, ", ")}`);
  return listWords(parts, "; ");
}

function listWords(items: readonly string[], sep: string): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(sep)} and ${items[items.length - 1]}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// ───────────────────────────── scrubbing ─────────────────────────────

/** The agent's view of the repository: file text scrubbed of the plan's sensitive values. */
function scrubbedWorkspace(ws: Workspace, scrub: Scrubber): Workspace {
  if (scrub.size === 0) return ws;
  return {
    root: ws.root,
    rootModuleDir: ws.rootModuleDir,
    readFile: async (path) => {
      const text = await ws.readFile(path);
      return text === null ? null : scrub.text(text);
    },
    listFiles: (dir, suffixes) => ws.listFiles(dir, suffixes),
  };
}

function scrubLineage(l: Lineage, scrub: Scrubber): Lineage {
  if (scrub.size === 0) return l;
  return {
    ...l,
    steps: l.steps.map((s) => ({
      ...s,
      label: scrub.text(s.label),
      ...(s.snippet !== undefined && { snippet: scrub.text(s.snippet) }),
    })),
    notes: l.notes.map((n) => scrub.text(n)),
  };
}

function scrubSignals(signals: RiskSignal[], scrub: Scrubber): RiskSignal[] {
  return signals.map((s) => ({ ...s, reason: scrub.text(s.reason) }));
}

function scrubFinding(f: Finding, scrub: Scrubber): Finding {
  if (scrub.size === 0) return f;
  return {
    ...f,
    title: scrub.text(f.title),
    impact: scrub.text(f.impact),
    cause: scrub.text(f.cause),
    causeLinks: f.causeLinks.map((l) => ({ ...l, label: scrub.text(l.label) })),
    ...(f.agentCauseLinks && {
      agentCauseLinks: f.agentCauseLinks.map((l) => ({ ...l, label: scrub.text(l.label) })),
    }),
    ...(f.lineage && { lineage: scrubLineage(f.lineage, scrub) }),
    signals: scrubSignals(f.signals, scrub),
  };
}

function scrubScored(sc: ScoredChange, scrub: Scrubber): ScoredChange {
  if (scrub.size === 0) return sc;
  return { ...sc, signals: scrubSignals(sc.signals, scrub) };
}
