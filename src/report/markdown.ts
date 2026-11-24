import { createHash } from "node:crypto";
import { causePaths, collapsePath } from "../lineage/chain.js";
import { formatPath, parseAddress } from "../plan/paths.js";
import { redactSecrets } from "../redact.js";
import type {
  Action,
  AgentRunInfo,
  Finding,
  Lineage,
  LineageStep,
  RelatedChange,
  ReportMeta,
  Review,
  RiskSignal,
  ScoredChange,
  Severity,
  SourceLocation,
} from "../types.js";
import { SEVERITY_ORDER } from "../types.js";
import { locationLabel, locationMarkdown, runUrl } from "./links.js";
import { codeSpan, escapeText, normalize, sanitizeInline, sanitizeModelText, truncate } from "./sanitize.js";

// ───────────────────────────── markers ─────────────────────────────

/** First line of the sticky PR comment; the action finds its comment by it. */
export const COMMENT_MARKER = "<!-- tf-change-reviewer -->";
/** Prefix of the hidden data line that metrics read back (see metrics/feedback.ts). */
export const DATA_MARKER_PREFIX = "<!-- tf-change-reviewer:data ";
export const DATA_MARKER_VERSION = 1;

/** GitHub rejects comment bodies over 65,536 characters; stay well clear of that. */
export const MAX_COMMENT_CHARS = 60_000;
/** Job summaries may be up to 1 MiB per step. */
const MAX_SUMMARY_CHARS = 900_000;

export function commentMarker(): string {
  return COMMENT_MARKER;
}

/** True when a comment body is this tool's sticky comment. */
export function isReviewComment(body: string): boolean {
  return body.replace(/^﻿/, "").trimStart().startsWith(COMMENT_MARKER);
}

export interface RunStamp {
  runId: number;
  attempt: number;
}

/** Hidden second line recording which run attempt last wrote the comment. */
export function runStamp(run: { id: number; attempt: number }): string {
  return `<!-- tf-change-reviewer:run=${run.id}.${run.attempt} -->`;
}

const RUN_STAMP = /^[ \t]*<!-- tf-change-reviewer:run=(\d+)\.(\d+) -->[ \t]*$/m;

/** The run attempt that last wrote a comment, or null for comments without a stamp. */
export function parseRunStamp(body: string): RunStamp | null {
  const match = RUN_STAMP.exec(body);
  return match ? { runId: Number(match[1]), attempt: Number(match[2]) } : null;
}

/**
 * Hidden line naming which sticky comment this is when a PR has several (one per plan set or
 * comment-key), which workflow job writes it (`scope`, a hash), when known, and which plan-json
 * entries it reviews (`plans`, one short hash each; only with a scope).
 */
export function commentKeyStamp(key: string, scope?: string, plans?: readonly string[]): string {
  const withScope = scope !== undefined && SCOPE.test(scope);
  const planList = withScope && plans !== undefined && PLANS.test(plans.join(".")) ? plans.join(".") : "";
  return `<!-- tf-change-reviewer:key=${key}${withScope ? ` scope=${scope}` : ""}${planList ? ` plans=${planList}` : ""} -->`;
}

const SCOPE = /^[0-9a-f]{1,64}$/;
const PLANS = /^[0-9a-f]{1,16}(?:\.[0-9a-f]{1,16}){0,63}$/;
const KEY_STAMP =
  /^[ \t]*<!-- tf-change-reviewer:key=([A-Za-z0-9_.-]{1,64})(?: scope=([0-9a-f]{1,64})(?: plans=([0-9a-f]{1,16}(?:\.[0-9a-f]{1,16}){0,63}))?)? -->[ \t]*$/m;

/** The key a sticky comment was written for, or null for comments without one. */
export function parseCommentKey(body: string): string | null {
  return KEY_STAMP.exec(body)?.[1] ?? null;
}

/** The workflow job scope a keyed sticky comment was written by, or null when it records none. */
export function parseCommentScope(body: string): string | null {
  return KEY_STAMP.exec(body)?.[2] ?? null;
}

/** The plan-json entry hashes a keyed sticky comment reviews, or null when it records none. */
export function parseCommentPlans(body: string): string[] | null {
  return KEY_STAMP.exec(body)?.[3]?.split(".") ?? null;
}

/**
 * True when `existing` was written by a later run than `run`. Run ids grow monotonically per
 * repository, so a slow review of an older push must not overwrite a newer result.
 */
export function isWrittenByNewerRun(
  existing: { body: string } | string,
  run: { id: number; attempt: number },
): boolean {
  const stamp = parseRunStamp(typeof existing === "string" ? existing : existing.body);
  if (stamp === null) return false;
  return stamp.runId > run.id || (stamp.runId === run.id && stamp.attempt > run.attempt);
}

/**
 * One entry of the hidden data marker; `id` is the key used by the finding's checkbox (the finding
 * id, qualified by its root module when that is not the repository root).
 */
export interface DataMarkerFinding {
  id: string;
  address: string;
  severity: string;
  origin: string;
  /** Root module dir the finding belongs to. */
  root: string;
  /** Other addresses the finding stands for (same root cause); absent when none. */
  related?: string[];
}

/** A finding an earlier version of the comment showed with a checkbox, and whether it was ticked. */
export interface EarlierFinding extends DataMarkerFinding {
  confirmed: boolean;
}

/** Earlier findings kept in the data marker, newest first; older ones are dropped beyond this. */
const MAX_EARLIER = 50;

/**
 * The hidden data line. `<` and `>` are JSON-escaped so no value can close the HTML comment.
 * `roots` lists every root module the comment covers (so metrics know when an address is ambiguous);
 * `earlier` keeps findings that earlier runs showed and this one does not (fixed by a later push).
 */
export function renderDataMarker(
  findings: readonly DataMarkerFinding[],
  extra: { roots?: readonly string[]; earlier?: readonly EarlierFinding[] } = {},
): string {
  const data = {
    v: DATA_MARKER_VERSION,
    findings,
    ...(extra.roots && extra.roots.length > 1 && { roots: extra.roots }),
    ...(extra.earlier && extra.earlier.length > 0 && { earlier: extra.earlier }),
  };
  const json = JSON.stringify(data).replace(
    /[<>]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `${DATA_MARKER_PREFIX}${json} -->`;
}

/** The checkbox line metrics read. Ticking it (GitHub task list) records a confirmation. */
export function feedbackCheckbox(key: string, checked = false): string {
  return `- [${checked ? "x" : " "}] Confirmed: this needs attention <!-- finding:${key} -->`;
}

// ───────────────────────────── options + limits ─────────────────────────────

export interface CommentOptions {
  /** Finding keys already confirmed on the comment being replaced, so a re-run keeps reviewers' ticks. */
  confirmedIds?: Iterable<string>;
  /** Findings the replaced comment recorded (shown or earlier): kept in the data marker when no longer shown. */
  earlier?: readonly EarlierFinding[];
  /** Which sticky comment this is (see commentKeyStamp). */
  key?: string;
  /** Which workflow job writes it (see commentKeyStamp); only written with a key. */
  scope?: string;
  /** Hashes of the plan-json entries it reviews (see commentKeyStamp); only written with a scope. */
  plans?: readonly string[];
  /** Override the size cap (tests). */
  maxChars?: number;
}

interface Limits {
  findingsPerModule: number;
  othersPerSeverity: number;
  kindsPerGroup: number;
  lineageDetail: boolean;
  chainItems: number;
  /** Scale for free-text caps. */
  text: number;
  /** Headline + counts only per module. */
  headlineOnly: boolean;
}

const FULL: Limits = {
  findingsPerModule: 50,
  othersPerSeverity: 40,
  kindsPerGroup: 25,
  lineageDetail: true,
  chainItems: 8,
  text: 1,
  headlineOnly: false,
};

/** Shrink order: other changes first, then lineage detail, then text, then findings beyond the cap. */
const COMMENT_STEPS: Limits[] = [
  FULL,
  { ...FULL, othersPerSeverity: 15, kindsPerGroup: 10 },
  { ...FULL, othersPerSeverity: 0, kindsPerGroup: 5 },
  { ...FULL, othersPerSeverity: 0, kindsPerGroup: 0 },
  { ...FULL, othersPerSeverity: 0, kindsPerGroup: 0, lineageDetail: false },
  { ...FULL, othersPerSeverity: 0, kindsPerGroup: 0, lineageDetail: false, chainItems: 4, text: 0.4 },
  {
    ...FULL,
    othersPerSeverity: 0,
    kindsPerGroup: 0,
    lineageDetail: false,
    chainItems: 4,
    text: 0.4,
    findingsPerModule: 10,
  },
  {
    ...FULL,
    othersPerSeverity: 0,
    kindsPerGroup: 0,
    lineageDetail: false,
    chainItems: 3,
    text: 0.2,
    findingsPerModule: 3,
  },
  {
    ...FULL,
    othersPerSeverity: 0,
    kindsPerGroup: 0,
    lineageDetail: false,
    chainItems: 2,
    text: 0.1,
    findingsPerModule: 1,
  },
  {
    ...FULL,
    othersPerSeverity: 0,
    kindsPerGroup: 0,
    lineageDetail: false,
    findingsPerModule: 0,
    headlineOnly: true,
  },
];

const SUMMARY_STEPS: Limits[] = [
  { ...FULL, othersPerSeverity: 500, kindsPerGroup: 100, chainItems: 20 },
  ...COMMENT_STEPS,
];

const TEXT = {
  summary: 2000,
  title: 150,
  impact: 1500,
  cause: 1500,
  reason: 200,
  label: 160,
  snippet: 200,
  note: 300,
  warning: 400,
  error: 300,
  address: 300,
};

const MAX_TRACE_STEPS = 15;
/** Related addresses listed per finding in the comment, and recorded in the data marker. */
const MAX_RELATED_SHOWN = 12;
const MAX_RELATED_GROUPS = 6;
const MAX_RELATED_MARKER = 50;
const MAX_WARNINGS = 10;

type Surface = "comment" | "summary";

interface RenderCtx {
  meta: ReportMeta;
  surface: Surface;
  limits: Limits;
  confirmed: ReadonlySet<string>;
  earlier: readonly EarlierFinding[];
  /** Filled while rendering: what was left out, for the trim note. */
  cuts: Cuts;
  /** Filled while rendering: findings that got a checkbox. */
  marker: DataMarkerFinding[];
  usedKeys: Set<string>;
}

interface Cuts {
  others: number;
  findings: number;
  lineage: boolean;
  modules: number;
  text: boolean;
}

// ───────────────────────────── display tables ─────────────────────────────

const SEVERITY_BADGE: Record<Severity, { emoji: string; label: string }> = {
  critical: { emoji: "🔴", label: "Critical" },
  high: { emoji: "🟠", label: "High" },
  medium: { emoji: "🟡", label: "Medium" },
  low: { emoji: "⚪", label: "Low" },
  noise: { emoji: "🔇", label: "Noise" },
};

/** Markdown-safe action labels (`~` escaped: GitHub renders `~x~` as strikethrough). */
const ACTION_MD: Record<Action, string> = {
  create: "+create",
  update: "\\~update",
  delete: "−destroy",
  replace: "±replace",
  read: "read",
  "no-op": "no-op",
  forget: "forget",
  import: "import",
  move: "move",
};

const ACTION_TEXT: Record<Action, string> = {
  create: "+ create",
  update: "~ update",
  delete: "- destroy",
  replace: "± replace",
  read: "<= read",
  "no-op": "no-op",
  forget: "forget",
  import: "import",
  move: "move",
};

const ACTION_NOUN: Record<Action, [string, string]> = {
  create: ["create", "creates"],
  update: ["update", "updates"],
  delete: ["destroy", "destroys"],
  replace: ["replacement", "replacements"],
  read: ["read", "reads"],
  "no-op": ["no-op", "no-ops"],
  forget: ["forget", "forgets"],
  import: ["import", "imports"],
  move: ["move", "moves"],
};

const ORIGIN_LABEL: Record<Finding["origin"], string> = {
  rules: "rules",
  agent: "AI review",
  both: "rules + AI review",
};

// ───────────────────────────── public renderers ─────────────────────────────

/**
 * The sticky PR comment for one or more root modules. Starts with COMMENT_MARKER and a run stamp
 * (when meta.run is set), ends with the hidden data marker, and stays under 60,000 characters by
 * shortening other changes, then lineage detail, then text, then findings, saying what was cut.
 */
export function renderReviewComment(
  reviews: readonly Review[],
  meta: ReportMeta,
  opts: CommentOptions = {},
): string {
  const header = [
    COMMENT_MARKER,
    ...(meta.run ? [runStamp(meta.run)] : []),
    ...(opts.key !== undefined && /^[A-Za-z0-9_.-]{1,64}$/.test(opts.key)
      ? [commentKeyStamp(opts.key, opts.scope, opts.plans)]
      : []),
  ].join("\n");
  const confirmed = new Set(opts.confirmedIds ?? []);
  const earlier = opts.earlier ?? [];
  const max = (opts.maxChars ?? MAX_COMMENT_CHARS) - header.length - 2;
  return `${header}\n${renderWithin(reviews, meta, "comment", COMMENT_STEPS, max, confirmed, earlier)}\n`;
}

/** Job summary: the review without markers or checkboxes, with room for more detail and an AI usage table. */
export function renderJobSummary(reviews: readonly Review[], meta: ReportMeta): string {
  return `${renderWithin(reviews, meta, "summary", SUMMARY_STEPS, MAX_SUMMARY_CHARS, new Set(), [])}\n`;
}

function renderWithin(
  reviews: readonly Review[],
  meta: ReportMeta,
  surface: Surface,
  steps: readonly Limits[],
  maxChars: number,
  confirmed: ReadonlySet<string>,
  earlier: readonly EarlierFinding[],
): string {
  let body = "";
  for (const limits of steps) {
    body = renderBody(reviews, meta, surface, limits, confirmed, earlier, reviews.length);
    if (body.length <= maxChars) return body;
  }
  // Still too long: so many root modules that even headlines overflow. Drop trailing modules.
  const last = steps.at(-1) ?? FULL;
  let shown = reviews.length;
  while (shown > 1) {
    shown = Math.max(1, Math.floor(shown * 0.7));
    body = renderBody(reviews, meta, surface, last, confirmed, earlier, shown);
    if (body.length <= maxChars) return body;
  }
  return truncate(body, maxChars);
}

function renderBody(
  reviews: readonly Review[],
  meta: ReportMeta,
  surface: Surface,
  limits: Limits,
  confirmed: ReadonlySet<string>,
  earlier: readonly EarlierFinding[],
  modulesShown: number,
): string {
  const ctx: RenderCtx = {
    meta,
    surface,
    limits,
    confirmed,
    earlier,
    cuts: { others: 0, findings: 0, lineage: false, modules: 0, text: false },
    marker: [],
    usedKeys: new Set(),
  };
  const multi = reviews.length > 1;
  const sections: string[] = ["## 🔎 Terraform change review", renderOverallHeadline(reviews)];
  const shown = reviews.slice(0, modulesShown);
  ctx.cuts.modules = reviews.length - shown.length;
  for (const review of shown) sections.push(...renderModule(review, ctx, multi));
  if (ctx.cuts.modules > 0)
    sections.push(`_${ctx.cuts.modules} more root module${ctx.cuts.modules === 1 ? "" : "s"} not shown._`);
  const trim = renderTrimNote(ctx);
  if (trim) sections.push(trim);
  const warnings = renderWarnings(reviews, meta.warnings ?? []);
  if (warnings) sections.push(warnings);
  if (surface === "summary") {
    const usage = renderUsageTable(reviews);
    if (usage) sections.push(usage);
  }
  sections.push(renderFooter(reviews, ctx));
  if (surface === "comment") {
    const shownIds = new Set(ctx.marker.map((f) => f.id));
    const kept = unique(ctx.earlier.filter((f) => !shownIds.has(f.id)).map((f) => f.id));
    const byId = new Map(ctx.earlier.map((f) => [f.id, f] as const));
    const earlierKept = kept.slice(0, MAX_EARLIER).map((id) => byId.get(id)!);
    const roots = unique(reviews.map((r) => rootKey(r.rootModuleDir)));
    sections.push(renderDataMarker(ctx.marker, { roots, earlier: earlierKept }));
  }
  // Blank lines between sections keep model text from merging into our own markup.
  return sections.filter((s) => s !== "").join("\n\n");
}

// ───────────────────────────── headline ─────────────────────────────

function renderOverallHeadline(reviews: readonly Review[]): string {
  const findings = sum(reviews.map((r) => r.findings.length));
  const affected = sum(reviews.map(attentionCount));
  const total = sum(reviews.map(planTotal));
  const counts = mergeCounts(reviews.map((r) => r.stats.counts));
  const plans = reviews.length > 1 ? `across ${reviews.length} root modules ` : "";
  const ofPlan = `(${affectedText(findings, affected)}of ${formatCount(total)} in the plan${reviews.length > 1 ? "s" : ""})`;
  // An errored or partial plan proves nothing about what it left out: no green check.
  const unsure = reviews.some(isIncomplete);
  let headline: string;
  if (reviews.length === 0) headline = "**No plans to review.**";
  else if (findings === 0 && sum(reviews.map((r) => r.stats.totalChanges)) === 0)
    headline = unsure
      ? "⚠️ **No changes in this plan**, but the plan is incomplete (see the warning below), so this does not show that the infrastructure matches the configuration."
      : "✅ **No changes.** Infrastructure matches the configuration.";
  else if (findings === 0)
    headline = `${unsure ? "⚠️" : "✅"} **No changes need your attention** ${plans}${ofPlan}`;
  else headline = `**${needAttention(findings)}** ${plans}${ofPlan}`;
  return sum(reviews.map((r) => r.stats.totalChanges)) > 0
    ? `${headline}\n${renderCounts(counts)}`
    : headline;
}

function isIncomplete(review: Review): boolean {
  return review.planIncomplete === true;
}

/**
 * An incomplete plan without changes has nothing to summarize, and its summary would say the
 * infrastructure matches the configuration, which the plan cannot show: the headline says why.
 */
function showSummary(review: Review): boolean {
  return !(isIncomplete(review) && review.stats.totalChanges === 0);
}

/** True for a plan JSON whose `terraform plan` failed (`errored: true`): nothing in it was fully planned. */
export function isErroredPlan(planJson: unknown): boolean {
  return (
    planJson !== null && typeof planJson === "object" && (planJson as { errored?: unknown }).errored === true
  );
}

/** True for a plan JSON that errored or is partial (`errored: true` or `complete: false`). */
export function isIncompletePlan(planJson: unknown): boolean {
  if (planJson === null || typeof planJson !== "object") return false;
  const plan = planJson as Record<string, unknown>;
  return plan.errored === true || plan.complete === false;
}

/** Changes a review covers: each finding plus the changes grouped into it. */
function attentionCount(review: Review): number {
  return review.findings.reduce((n, f) => n + 1 + (f.relatedAddresses?.length ?? 0), 0);
}

/** Resource changes in the plan; data source reads are listed apart (as Terraform's own summary does). */
function planTotal(review: Review): number {
  return Math.max(0, review.stats.totalChanges - (review.stats.counts.read ?? 0));
}

/** "14 changes, " when findings stand for more changes than there are findings. */
function affectedText(findings: number, affected: number): string {
  return affected > findings ? `${formatCount(affected)} changes, ` : "";
}

function needAttention(n: number): string {
  return n === 1 ? "1 finding needs your attention" : `${formatCount(n)} findings need your attention`;
}

/** `**+3** create · **\~25** update · **−1** destroy · **±2** replace` + moves/imports/forgets/reads when present. */
export function renderCounts(counts: Partial<Record<Action, number>>): string {
  const n = (a: Action): number => counts[a] ?? 0;
  const parts = [
    `**+${n("create")}** create`,
    `**\\~${n("update")}** update`,
    `**−${n("delete")}** destroy`,
    `**±${n("replace")}** replace`,
  ];
  for (const [action, word] of [
    ["move", "move"],
    ["import", "import"],
    ["forget", "forget"],
    ["read", "read"],
  ] as const) {
    if (n(action) > 0) parts.push(`**${n(action)}** ${n(action) === 1 ? word : `${word}s`}`);
  }
  return parts.join(" · ");
}

// ───────────────────────────── per module ─────────────────────────────

function renderModule(review: Review, ctx: RenderCtx, multi: boolean): string[] {
  const out: string[] = [];
  const dir = displayDir(review.rootModuleDir);
  if (multi) {
    const head =
      review.findings.length === 0
        ? `${isIncomplete(review) ? "⚠️" : "✅"} nothing needs your attention`
        : needAttention(review.findings.length);
    const affected = affectedText(review.findings.length, attentionCount(review));
    out.push(`### ${codeSpan(dir, 200)} · ${head} (${affected}of ${formatCount(planTotal(review))})`);
    if (review.stats.totalChanges > 0) out.push(renderCounts(review.stats.counts));
  } else if (dir !== ".") {
    out.push(`Root module: ${codeSpan(dir, 200)}`);
  }
  if (ctx.limits.headlineOnly) {
    ctx.cuts.findings += review.findings.length;
    ctx.cuts.others += review.others.length;
    return out;
  }
  const banner = renderNotices(review.notices);
  if (banner) out.push(banner);
  const summary = showSummary(review) ? clean(review.summary).trim() : "";
  if (summary) out.push(sanitizeModelText(fit(ctx, summary, TEXT.summary)));
  const status = agentStatusNote(review);
  if (status) out.push(status);

  const findings = review.findings.slice(0, ctx.limits.findingsPerModule);
  ctx.cuts.findings += review.findings.length - findings.length;
  for (const finding of findings) out.push(renderFinding(finding, review, ctx));
  if (findings.length < review.findings.length) {
    const n = review.findings.length - findings.length;
    out.push(`_${n} more finding${n === 1 ? "" : "s"} not shown to fit the comment._`);
  }
  const others = renderOthers(review.others, ctx);
  if (others) out.push(others);
  return out;
}

/** Plan-level problems (partial, errored, not applyable plan): shown first, never collapsed. */
function renderNotices(notices: readonly string[] | undefined): string {
  const shown = (notices ?? []).map((n) => escapeText(clean(n), TEXT.warning)).filter((n) => n !== "");
  if (shown.length === 0) return "";
  return shown.map((n) => `> [!WARNING]\n> ${n}`).join("\n\n");
}

function agentStatusNote(review: Review): string {
  const agent = review.agent;
  if (!agent || agent.status === "complete" || agent.status === "skipped") return "";
  const error = agent.error ? `: ${escapeText(clean(agent.error), TEXT.error)}` : "";
  // With a verdict, status is why the agent stopped early; without one, nothing of it is used.
  const partial =
    agent.status === "budget" ||
    agent.status === "max_turns" ||
    (agent.status === "timeout" && review.findings.some((f) => f.origin !== "rules"));
  const used = partial ? " and whatever the AI review finished" : "";
  return `> ⚠️ The AI review stopped early (${escapeText(agent.status, 40)}${error}). Findings below come from the deterministic rules${used}.`;
}

// ───────────────────────────── findings ─────────────────────────────

function renderFinding(finding: Finding, review: Review, ctx: RenderCtx): string {
  const badge = SEVERITY_BADGE[finding.severity] ?? SEVERITY_BADGE.medium;
  const action = ACTION_MD[finding.action] ?? escapeText(finding.action, 20);
  const title =
    sanitizeInline(fit(ctx, clean(finding.title).replace(/\s+/g, " ").trim(), TEXT.title)) || "Needs a look";
  const lines: string[] = [
    `#### ${badge.emoji} ${badge.label} · ${codeSpan(finding.address, TEXT.address)}`,
    `**${title}** · ${action}`,
  ];
  const impact = clean(finding.impact).trim();
  if (impact) lines.push(`**Why it matters:** ${sanitizeModelText(fit(ctx, impact, TEXT.impact))}`);
  const cause = clean(finding.cause).trim();
  if (cause) lines.push(`**Why it happens:** ${sanitizeModelText(fit(ctx, cause, TEXT.cause))}`);
  const chain = renderCauseChain(finding, ctx);
  if (chain) lines.push(chain);
  const explanation = renderExplanation(finding.lineage);
  if (explanation) lines.push(explanation);
  const related = renderRelated(finding);
  if (related) lines.push(related);
  if (finding.lineage && finding.lineage.steps.length > 0) {
    if (ctx.limits.lineageDetail) lines.push(renderTrace(finding.lineage, ctx));
    else ctx.cuts.lineage = true;
  }
  lines.push(renderFindingMeta(finding));
  if (ctx.surface === "comment") {
    const key = uniqueKey(checkboxId(finding.id, review.rootModuleDir), ctx.usedKeys);
    const related = (finding.relatedAddresses ?? []).slice(0, MAX_RELATED_MARKER);
    ctx.marker.push({
      id: key,
      address: finding.address,
      severity: finding.severity,
      origin: finding.origin,
      root: review.rootModuleDir,
      ...(related.length > 0 && { related }),
    });
    lines.push(feedbackCheckbox(key, ctx.confirmed.has(key)));
  }
  return lines.join("\n\n");
}

/** Changes grouped into a finding (same root cause), by type and action. */
function renderRelated(finding: Finding): string {
  const groups = relatedGroups(finding);
  if (groups.length === 0) return "";
  const total = sum(groups.map((g) => g.addresses.length));
  let budget = MAX_RELATED_SHOWN;
  const lines = groups.slice(0, MAX_RELATED_GROUPS).map((g) => {
    const shown = g.addresses.slice(0, Math.max(1, Math.min(budget, 5)));
    budget -= shown.length;
    const more =
      g.addresses.length > shown.length ? ` and ${formatCount(g.addresses.length - shown.length)} more` : "";
    const n = g.addresses.length > 1 ? ` ×${g.addresses.length}` : "";
    const list = shown.map((a) => codeSpan(a, TEXT.address)).join(", ");
    return `- ${codeSpan(g.type, 80)} ${ACTION_MD[g.action] ?? escapeText(g.action, 20)}${n}: ${list}${more}`;
  });
  const hidden = groups.slice(MAX_RELATED_GROUPS);
  if (hidden.length > 0) {
    const n = sum(hidden.map((g) => g.addresses.length));
    lines.push(
      `- …and ${formatCount(n)} more of ${hidden.length} other kind${hidden.length === 1 ? "" : "s"}`,
    );
  }
  return [`**Same cause, also changes (${formatCount(total)}):**`, ...lines].join("\n");
}

interface RelatedGroup {
  type: string;
  action: Action;
  addresses: string[];
}

/** Related changes by resource type and action, in the order they first appear. */
function relatedGroups(finding: Finding): RelatedGroup[] {
  const changes: RelatedChange[] =
    finding.relatedChanges ??
    (finding.relatedAddresses ?? []).map((address) => ({
      address,
      action: finding.action,
      severity: finding.severity,
    }));
  const groups = new Map<string, RelatedGroup>();
  for (const c of changes) {
    const type = resourceType(c.address);
    const key = `${type}|${c.action}`;
    const g = groups.get(key) ?? { type, action: c.action, addresses: [] };
    g.addresses.push(c.address);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** Resource type of an address (`module.a["x"].aws_s3_bucket.b[0]` → aws_s3_bucket). */
function resourceType(address: string): string {
  // parseAddress splits around quoted instance keys, which may contain "]" or ".".
  const { mode, type } = parseAddress(address);
  return mode === "data" ? `data.${type}` : type;
}

function renderFindingMeta(finding: Finding): string {
  const rules = unique(finding.signals.map((s) => s.ruleId).filter((id) => id.trim() !== ""));
  const parts: string[] = [];
  if (rules.length > 0)
    parts.push(
      `rules: ${rules
        .slice(0, 6)
        .map((r) => codeSpan(r, 60))
        .join(" ")}`,
    );
  parts.push(`confidence: ${escapeText(finding.confidence, 20)}`);
  parts.push(`raised by: ${ORIGIN_LABEL[finding.origin] ?? escapeText(finding.origin, 20)}`);
  return `<sub>${parts.join(" · ")}</sub>`;
}

interface ChainItem {
  markdown: string;
  text: string;
  changed: boolean;
  /** The step's label and snippet, for the terminal report. */
  detail: string;
}

/** One branch of the cause chain: from the changed attribute to the line that causes it. */
interface ChainLine {
  /** The traced attribute (`name`, `ingress "Office" cidr_blocks`); "" for whole-resource changes. */
  head: string;
  items: ChainItem[];
  /** The end of the branch; several when branches differ only in their last step. */
  last: ChainItem[];
}

function stepItem(step: LineageStep, meta: ReportMeta | null): ChainItem | null {
  const detail = [step.label, step.snippet ?? ""].filter((x) => x.trim() !== "").join(": ");
  if (step.location)
    return {
      markdown: meta ? locationMarkdown(step.location, meta) : "",
      text: locationLabel(step.location),
      changed: step.changedInDiff,
      detail,
    };
  if (step.kind === "upstream_resource" && step.upstreamAddress)
    return {
      markdown: codeSpan(step.upstreamAddress, TEXT.address),
      text: step.upstreamAddress,
      changed: false,
      detail,
    };
  return null;
}

/** The traced attribute a branch starts at, from its first step's label (`<address> <attribute>`). */
function branchHead(step: LineageStep | undefined): string {
  if (!step) return "";
  if (step.kind === "resource_attribute") {
    const i = step.label.indexOf(" ");
    return i > 0 ? step.label.slice(i + 1) : step.label;
  }
  if (step.kind === "provider_config") return "tags_all";
  return "";
}

/**
 * The cause chain as branches: each runs from the changed attribute through the steps that pass
 * the value on to a line the PR changed (unchanged sibling inputs stay in the trace details).
 * Branches that differ only in their last step share a line.
 */
function chainLines(finding: Finding, meta: ReportMeta | null): ChainLine[] {
  const lineage = finding.lineage;
  const lines: ChainLine[] = [];
  if (lineage && lineage.steps.length > 0) {
    for (const path of causePaths(lineage, MAX_CHAIN_LINES * 2)) {
      const items: ChainItem[] = [];
      const seen = new Set<string>();
      for (const step of collapsePath(path)) {
        const item = stepItem(step, meta);
        if (!item || seen.has(item.text)) continue;
        seen.add(item.text);
        items.push(item);
      }
      if (items.length === 0) continue;
      const head = lineage.attribute.length > 0 ? branchHead(path[0]) : "";
      const prefix = items.slice(0, -1);
      const last = items[items.length - 1]!;
      const same = lines.find(
        (l) =>
          l.head === head &&
          l.items.length === prefix.length &&
          l.items.every((it, i) => it.text === prefix[i]!.text),
      );
      if (same) {
        if (!same.last.some((x) => x.text === last.text)) same.last.push(last);
      } else lines.push({ head, items: prefix, last: [last] });
    }
  }
  // Lines the AI review cited that no traced branch covers.
  const covered = new Set(lines.flatMap((l) => [...l.items, ...l.last].map((i) => i.text)));
  const cited = finding.causeLinks
    .filter((link) => !covered.has(locationLabel(link.location)))
    .map((link) => ({
      markdown: meta ? locationMarkdown(link.location, meta) : "",
      text: locationLabel(link.location),
      changed: link.changedInDiff,
      detail: link.label,
    }));
  if (cited.length > 0 && (finding.origin !== "rules" || lines.length === 0)) {
    lines.push({ head: "", items: cited.slice(0, -1), last: cited.slice(-1) });
  }
  return lines.slice(0, MAX_CHAIN_LINES);
}

const MAX_CHAIN_LINES = 4;

function renderCauseChain(finding: Finding, ctx: RenderCtx): string {
  const lines = chainLines(finding, ctx.meta);
  if (lines.length === 0) return "";
  const fmt = (item: ChainItem | null): string =>
    item === null ? "…" : item.changed ? `**${item.markdown}** ✏️` : item.markdown;
  const rendered = lines.map((line) => {
    const shown = capChain([...line.items, line.last[0]!], ctx.limits.chainItems);
    const parts = shown.slice(0, -1).map(fmt);
    parts.push(line.last.map(fmt).join(", "));
    const head = line.head ? codeSpan(line.head, 120) : "";
    return [head, ...parts].filter((p) => p !== "").join(" ← ");
  });
  const changed = lines.some((l) => [...l.items, ...l.last].some((i) => i.changed));
  if (rendered.length === 1)
    return `**Cause chain:** ${rendered[0]}${changed ? " · ✏️ changed in this PR" : ""}`;
  return [
    `**Cause chain**${changed ? " (✏️ changed in this PR)" : ""}:`,
    ...rendered.map((r) => `- ${r}`),
  ].join("\n");
}

/** Keep the first item and the last ones (root causes sit at the upstream end); null marks the gap. */
function capChain<T>(items: readonly T[], max: number): (T | null)[] {
  if (items.length <= max) return [...items];
  if (max < 2) return items.slice(items.length - 1);
  return [items[0] as T, null, ...items.slice(items.length - (max - 1))];
}

function renderExplanation(lineage: Lineage | undefined): string {
  if (!lineage) return "";
  switch (lineage.explanation) {
    case "external":
      // "Why it happens" names the likely source; a generic banner here would only repeat it.
      return "";
    case "upstream": {
      const upstream = lineage.steps.find((s) => s.kind === "upstream_resource" && s.upstreamAddress);
      return upstream?.upstreamAddress
        ? `↪️ Follows from the change to ${codeSpan(upstream.upstreamAddress, TEXT.address)}.`
        : "↪️ Follows from another resource's change in this plan.";
    }
    case "unknown":
      if (lineage.notes.some((n) => /^No PR diff was available/.test(n))) return "";
      return lineage.rootCauseIds.length === 0 ? "_Tracing stopped before reaching a changed line._" : "";
    default:
      return "";
  }
}

function renderTrace(lineage: Lineage, ctx: RenderCtx): string {
  const steps = lineage.steps.slice(0, MAX_TRACE_STEPS);
  const rootCauses = new Set(lineage.rootCauseIds);
  const items = steps.map((step, i) => {
    const parts = [
      `${i + 1}. ${step.changedInDiff ? "✏️ " : ""}${rootCauses.has(step.id) ? "**" : ""}${escapeText(clean(step.label), cap(ctx, TEXT.label)) || escapeText(step.kind, 40)}${rootCauses.has(step.id) ? "**" : ""}`,
    ];
    if (step.location) parts.push(locationMarkdown(step.location, ctx.meta));
    if (step.snippet) parts.push(codeSpan(clean(step.snippet), cap(ctx, TEXT.snippet)));
    return parts.join(" · ");
  });
  if (lineage.steps.length > steps.length)
    items.push(`_…and ${countOf(lineage.steps.length - steps.length, "more step")}._`);
  const notes = lineage.notes
    .map((n) => escapeText(clean(n), cap(ctx, TEXT.note)))
    .filter((n) => n !== "")
    .slice(0, 5);
  const noteLine = notes.length > 0 ? `\n\n_Notes:_ ${notes.join("; ")}` : "";
  const count = lineage.steps.length;
  return `<details><summary>How this was traced (${count} step${count === 1 ? "" : "s"})</summary>\n\n${items.join("\n")}${noteLine}\n\n</details>`;
}

// ───────────────────────────── other changes ─────────────────────────────

interface Kind {
  key: string;
  action: Action;
  type: string;
  attrs: string[];
  tagOnly: boolean;
  changes: ScoredChange[];
}

const TAG_ATTRS = new Set(["tags", "tags_all"]);

/** Group changes by kind: action + resource type + changed top-level attribute names; tag-only updates merge across types. */
export function groupByKind(changes: readonly ScoredChange[]): Kind[] {
  const kinds = new Map<string, Kind>();
  for (const sc of changes) {
    const c = sc.change;
    const attrs = changedAttributeNames(sc);
    const tagOnly = c.action === "update" && attrs.length > 0 && attrs.every((a) => TAG_ATTRS.has(a));
    const key = tagOnly ? "tag-only" : `${c.action}|${c.type}|${attrs.join(",")}`;
    let kind = kinds.get(key);
    if (!kind) {
      kind = { key, action: c.action, type: c.type, attrs, tagOnly, changes: [] };
      kinds.set(key, kind);
    }
    kind.changes.push(sc);
  }
  return [...kinds.values()].sort(
    (a, b) => b.changes.length - a.changes.length || a.key.localeCompare(b.key),
  );
}

function changedAttributeNames(sc: ScoredChange): string[] {
  const c = sc.change;
  const names = new Set<string>();
  for (const path of [...c.changedPaths, ...c.sensitiveChangedPaths, ...c.replacePaths]) {
    const first = path[0];
    if (typeof first === "string") names.add(first);
  }
  return [...names].sort();
}

function kindLabelMd(kind: Kind): string {
  const n = kind.changes.length;
  if (kind.tagOnly) {
    const types = countBy(kind.changes.map((c) => c.change.type));
    const shown = types.slice(0, 3).map(([t, k]) => `${codeSpan(t, 80)} ×${k}`);
    if (types.length > 3) shown.push(`${types.length - 3} more type${types.length === 4 ? "" : "s"}`);
    return `${n} tag-only update${n === 1 ? "" : "s"} (${shown.join(", ")})`;
  }
  const noun = (ACTION_NOUN[kind.action] ?? ["change", "changes"])[n === 1 ? 0 : 1];
  const attrs = kind.attrs.slice(0, 4).map((a) => codeSpan(a, 60));
  if (kind.attrs.length > 4) attrs.push(`${kind.attrs.length - 4} more`);
  const changing = attrs.length > 0 ? ` changing ${attrs.join(", ")}` : "";
  return `${n} ${codeSpan(kind.type, 80)} ${noun}${changing}`;
}

function kindLabelText(kind: Kind): string {
  const n = kind.changes.length;
  if (kind.tagOnly) {
    const types = countBy(kind.changes.map((c) => c.change.type));
    const shown = types.slice(0, 3).map(([t, k]) => `${t} x${k}`);
    if (types.length > 3) shown.push(`${types.length - 3} more type${types.length === 4 ? "" : "s"}`);
    return `${n} tag-only update${n === 1 ? "" : "s"} (${shown.join(", ")})`;
  }
  const noun = (ACTION_NOUN[kind.action] ?? ["change", "changes"])[n === 1 ? 0 : 1];
  const attrs = kind.attrs.slice(0, 4);
  if (kind.attrs.length > 4) attrs.push(`${kind.attrs.length - 4} more`);
  return `${n} ${kind.type} ${noun}${attrs.length > 0 ? ` changing ${attrs.join(", ")}` : ""}`;
}

function topSignal(sc: ScoredChange): RiskSignal | undefined {
  const rank = (s: Severity): number => {
    const i = SEVERITY_ORDER.indexOf(s);
    return i === -1 ? SEVERITY_ORDER.length : i;
  };
  return [...sc.signals].sort((a, b) => rank(a.severity) - rank(b.severity))[0];
}

function otherLineMd(run: readonly ScoredChange[], ctx: RenderCtx): string {
  const sc = run[0]!;
  const c = sc.change;
  const pattern = addressPattern(run.map((r) => r.change.address));
  const where =
    run.length === 1
      ? codeSpan(c.address, TEXT.address)
      : pattern !== null
        ? `${formatCount(run.length)} × ${codeSpan(pattern, TEXT.address)}`
        : `${formatCount(run.length)} × ${codeSpan(c.address, TEXT.address)} and ${formatCount(run.length - 1)} more`;
  const parts = [where, ACTION_MD[c.action] ?? escapeText(c.action, 20)];
  const signal = topSignal(sc);
  if (signal?.reason.trim()) {
    const reason = run.length > 1 ? wildcardKeys(signal.reason) : signal.reason;
    parts.push(escapeText(clean(reason), cap(ctx, TEXT.reason)));
  } else {
    const attrs = changedAttributeNames(sc);
    if (attrs.length > 0) {
      const shown = attrs.slice(0, 4).map((a) => codeSpan(a, 60));
      parts.push(`changes ${shown.join(", ")}${attrs.length > 4 ? ` and ${attrs.length - 4} more` : ""}`);
    }
  }
  if (run.length === 1 && c.previousAddress)
    parts.push(`moved from ${codeSpan(c.previousAddress, TEXT.address)}`);
  if (c.deposed !== undefined) parts.push(`deposed object ${codeSpan(c.deposed, 40)}`);
  return `- ${parts.join(" · ")}`;
}

/** What a line says about a change: changes with the same text, type and action share one line. */
function otherLineKey(sc: ScoredChange): string {
  // Instance keys in the text (`svc["cart"]` vs `svc["search"]`) do not make two lines different.
  const reason = wildcardKeys(topSignal(sc)?.reason.trim() ?? "") || changedAttributeNames(sc).join(",");
  // A deposed leftover never shares a line with live objects (or another deposed key).
  return `${sc.change.action}|${sc.change.type}|${reason}|${sc.change.previousAddress ?? ""}|${sc.change.deposed ?? ""}`;
}

/** Changes that would read the same, merged into runs (first appearance order). */
function collapseOthers(changes: readonly ScoredChange[]): ScoredChange[][] {
  const runs = new Map<string, ScoredChange[]>();
  for (const sc of changes) {
    const key = otherLineKey(sc);
    const run = runs.get(key) ?? [];
    run.push(sc);
    runs.set(key, run);
  }
  return [...runs.values()];
}

/** Instance keys (`["cart"]`, `[3]`) replaced by `[*]`. */
function wildcardKeys(text: string): string {
  return text.replace(/\[(?:"(?:[^"\\]|\\.)*"|\d+)\]/g, "[*]");
}

/** `module.service[*].aws_cloudwatch_log_group.this` when addresses differ only by instance keys; else null. */
export function addressPattern(addresses: readonly string[]): string | null {
  const patterns = unique(addresses.map(wildcardKeys));
  return patterns.length === 1 ? patterns[0]! : null;
}

function renderOthers(others: readonly ScoredChange[], ctx: RenderCtx): string {
  if (others.length === 0) return "";
  const groups: string[] = [];
  for (const severity of SEVERITY_ORDER) {
    const group = others.filter((o) => o.severity === severity);
    if (group.length === 0) continue;
    const badge = SEVERITY_BADGE[severity];
    const lines = [`**${badge.emoji} ${badge.label} (${formatCount(group.length)})**`, ""];
    // Noise is always summarized by kind; other severities list changes (identical ones on one
    // line), then summarize the rest. Low changes are mostly creates: by address, so a module's
    // resources sit together.
    const ordered =
      severity === "low" ? [...group].sort((a, b) => cmp(a.change.address, b.change.address)) : group;
    const runs = severity === "noise" ? [] : collapseOthers(ordered).slice(0, ctx.limits.othersPerSeverity);
    const listed = runs.flat();
    lines.push(...runs.map((run) => otherLineMd(run, ctx)));
    const listedSet = new Set(listed);
    const rest = ordered.filter((sc) => !listedSet.has(sc));
    if (rest.length > 0) {
      const kinds = groupByKind(rest);
      const shownKinds = kinds.slice(0, ctx.limits.kindsPerGroup);
      const prefix = listed.length > 0 ? "…and " : "";
      if (shownKinds.length === 0) {
        lines.push(
          `- ${prefix}${formatCount(rest.length)} ${listed.length > 0 ? "more " : ""}change${rest.length === 1 ? "" : "s"} (not listed to fit the comment)`,
        );
        ctx.cuts.others += rest.length;
      } else {
        if (listed.length > 0) lines.push(`- …and ${formatCount(rest.length)} more:`);
        const indent = listed.length > 0 ? "  " : "";
        for (const kind of shownKinds) lines.push(`${indent}- ${kindLabelMd(kind)}${kindExamples(kind)}`);
        const hiddenKinds = kinds.slice(shownKinds.length);
        if (hiddenKinds.length > 0) {
          const hidden = sum(hiddenKinds.map((k) => k.changes.length));
          lines.push(
            `${indent}- ${formatCount(hidden)} more change${hidden === 1 ? "" : "s"} of ${hiddenKinds.length} other kind${hiddenKinds.length === 1 ? "" : "s"}`,
          );
          ctx.cuts.others += hidden;
        }
      }
    }
    groups.push(lines.join("\n"));
  }
  return [
    `<details><summary>Other changes (${othersCount(others)})</summary>`,
    "",
    groups.join("\n\n"),
    "",
    "</details>",
  ].join("\n");
}

/**
 * "13", or "13 + 1 read": data source reads are counted apart, as in the headline's "of M in the
 * plan" (which leaves them out), so the two numbers agree.
 */
function othersCount(others: readonly ScoredChange[]): string {
  const reads = others.filter((o) => o.change.action === "read").length;
  const changes = formatCount(others.length - reads);
  return reads === 0 ? changes : `${changes} + ${countOf(reads, "read")}`;
}

/** A few example addresses for small kinds, so a reviewer can find them. */
function kindExamples(kind: Kind): string {
  if (kind.changes.length > 3) return "";
  return `: ${kind.changes.map((c) => codeSpan(c.change.address, TEXT.address)).join(", ")}`;
}

// ───────────────────────────── footer, warnings, usage ─────────────────────────────

function renderTrimNote(ctx: RenderCtx): string {
  const cuts: string[] = [];
  if (ctx.cuts.others > 0) cuts.push(`${countOf(ctx.cuts.others, "other change")} not listed`);
  if (ctx.cuts.lineage) cuts.push("trace details omitted");
  if (ctx.cuts.text) cuts.push("long text shortened");
  if (ctx.cuts.findings > 0) cuts.push(`${countOf(ctx.cuts.findings, "finding")} not shown`);
  if (ctx.cuts.modules > 0) cuts.push(`${countOf(ctx.cuts.modules, "root module")} not shown`);
  if (cuts.length === 0) return "";
  const full =
    ctx.surface === "comment"
      ? " The job summary and `--format json` output have the full list."
      : " The `--format json` output has the full list.";
  return `✂️ _Not shown here: ${cuts.join("; ")}._${full}`;
}

function renderWarnings(reviews: readonly Review[], runWarnings: readonly string[]): string {
  const multi = reviews.length > 1;
  const text = (w: string): string => escapeText(clean(w), TEXT.warning);
  // A warning every root module has (e.g. no PR diff) is shown once, like the run-level ones.
  const perRoot = reviews.map((r) => unique(r.warnings.map(text).filter((w) => w !== "")));
  const shared = multi ? perRoot.reduce((acc, ws) => acc.filter((w) => ws.includes(w))) : [];
  const all = unique([...runWarnings.map(text).filter((w) => w !== ""), ...shared]);
  reviews.forEach((r, i) => {
    for (const w of perRoot[i] ?? []) {
      if (multi && shared.includes(w)) continue;
      all.push(multi ? `${codeSpan(displayDir(r.rootModuleDir), 200)}: ${w}` : w);
    }
  });
  if (all.length === 0) return "";
  const shown = all.slice(0, MAX_WARNINGS).map((w) => `- ${w}`);
  if (all.length > shown.length) shown.push(`- …and ${all.length - shown.length} more`);
  return [`<details><summary>⚠️ Warnings (${all.length})</summary>`, "", ...shown, "", "</details>"].join(
    "\n",
  );
}

function renderFooter(reviews: readonly Review[], ctx: RenderCtx): string {
  const lines: string[] = ["---"];
  if (ctx.surface === "comment") {
    const reply = reviews.length > 1 ? "`missed: <root module dir>:<address>`" : "`missed: <address>`";
    lines.push(
      `💬 Tick **Confirmed** on each finding that really needs attention. Missed something? Reply ${reply} (one per line) in a PR comment or review.`,
    );
  }
  const parts = [`🤖 tf-change-reviewer ${escapeText(ctx.meta.version, 40)}`];
  const agents = reviews
    .map((r) => r.agent)
    .filter((a): a is AgentRunInfo => a !== undefined && a.status !== "skipped");
  if (agents.length === 0) parts.push("rules only (no AI review)");
  else {
    const models = unique(agents.map((a) => a.model).filter((m) => m !== ""));
    if (models.length > 0) parts.push(models.map((m) => escapeText(m, 60)).join(", "));
    const turns = sum(agents.map((a) => a.turns));
    parts.push(`${formatCount(turns)} turn${turns === 1 ? "" : "s"}`);
    const costs = agents.map((a) => a.costUsd);
    if (costs.every((c): c is number => typeof c === "number" && Number.isFinite(c)))
      parts.push(formatUsd(sum(costs)));
    parts.push("AI-assisted, verify before acting");
  }
  const url = runUrl(ctx.meta);
  if (url) parts.push(`[run](${url})`);
  lines.push(`<sub>${parts.join(" · ")}</sub>`);
  return lines.join("\n\n");
}

function renderUsageTable(reviews: readonly Review[]): string {
  const rows = reviews.filter((r) => r.agent !== undefined);
  if (rows.length === 0) return "";
  const out = [
    "#### AI review usage",
    "",
    "| Root module | Model | Status | Turns | Tool calls | Input tokens | Output tokens | Cost | Duration |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const r of rows) {
    const a = r.agent as AgentRunInfo;
    const cells = [
      tableText(displayDir(r.rootModuleDir)),
      tableText(a.model || "—"),
      tableText(a.status),
      formatCount(a.turns),
      formatCount(a.toolCalls),
      formatCount(a.inputTokens),
      formatCount(a.outputTokens),
      a.costUsd === null ? "unknown" : `\\$${a.costUsd.toFixed(4)}`,
      `${(a.durationMs / 1000).toFixed(1)}s`,
    ];
    out.push(`| ${cells.join(" | ")} |`);
  }
  return out.join("\n");
}

// ───────────────────────────── CLI ─────────────────────────────

export interface CliOptions {
  /** ANSI colors (default false). */
  color?: boolean;
  /** Max other changes listed per severity before summarizing by kind (default 50). */
  maxOthers?: number;
}

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  magenta: "\u001b[35m",
  cyan: "\u001b[36m",
};

const SEVERITY_COLOR: Record<Severity, string> = {
  critical: ANSI.bold + ANSI.red,
  high: ANSI.red,
  medium: ANSI.yellow,
  low: ANSI.dim,
  noise: ANSI.dim,
};

/** Terminal report: plain text, no markdown or HTML; every value stripped of control characters (no escape injection). */
export function renderCliReport(reviews: readonly Review[], opts: CliOptions = {}): string {
  const color = opts.color === true;
  const maxOthers = opts.maxOthers ?? 50;
  const paint = (code: string, text: string): string =>
    color && text ? `${code}${text}${ANSI.reset}` : text;
  const t = (text: string): string => normalize(clean(text)).replace(/\s+/g, " ").trim();
  const multiline = (text: string, indent: string): string =>
    normalize(clean(text))
      .trim()
      .split("\n")
      .map((l, i) => (i === 0 ? l : indent + l))
      .join("\n");

  const out: string[] = [];
  const findings = sum(reviews.map((r) => r.findings.length));
  const affected = affectedText(findings, sum(reviews.map(attentionCount)));
  const total = sum(reviews.map(planTotal));
  const scope = reviews.length > 1 ? ` across ${reviews.length} root modules` : "";
  const ofPlan = `of ${total} in the plan${reviews.length > 1 ? "s" : ""}`;
  const headline =
    findings === 0
      ? sum(reviews.map((r) => r.stats.totalChanges)) === 0
        ? reviews.some(isIncomplete)
          ? "No changes in this plan, but the plan is incomplete (see the warning below)."
          : "No changes."
        : `No changes need your attention${scope} (${ofPlan})`
      : `${needAttention(findings)}${scope} (${affected}${ofPlan})`;
  out.push(paint(ANSI.bold, `Terraform change review: ${headline}`));
  if (total > 0) out.push(`Plan: ${countsText(mergeCounts(reviews.map((r) => r.stats.counts)))}`);

  for (const review of reviews) {
    out.push("");
    if (reviews.length > 1) {
      out.push(paint(ANSI.bold + ANSI.cyan, `== ${t(displayDir(review.rootModuleDir))} ==`));
      out.push(
        `${needAttention(review.findings.length)} (${affectedText(review.findings.length, attentionCount(review))}of ${planTotal(review)}) · ${countsText(review.stats.counts)}`,
      );
      out.push("");
    }
    for (const n of review.notices ?? []) out.push(paint(ANSI.bold + ANSI.yellow, `WARNING: ${t(n)}`), "");
    const summary = showSummary(review) ? multiline(review.summary, "") : "";
    if (summary) out.push(summary, "");
    if (review.agent && review.agent.status !== "complete" && review.agent.status !== "skipped") {
      const err = review.agent.error ? `: ${t(review.agent.error)}` : "";
      out.push(
        paint(
          ANSI.yellow,
          `AI review stopped early (${t(review.agent.status)}${err}); findings come from the rules.`,
        ),
        "",
      );
    }
    for (const finding of review.findings) {
      out.push(...cliFinding(finding, paint, t, multiline), "");
    }
    if (review.others.length > 0) out.push(...cliOthers(review.others, maxOthers, paint, t), "");
    for (const w of review.warnings) out.push(paint(ANSI.yellow, `warning: ${t(w)}`));
  }

  const agents = reviews
    .map((r) => r.agent)
    .filter((a): a is AgentRunInfo => a !== undefined && a.status !== "skipped");
  if (agents.length === 0) out.push(paint(ANSI.dim, "Rules only (no AI review)."));
  else {
    const costs = agents.map((a) => a.costUsd);
    const cost = costs.every((c): c is number => typeof c === "number") ? ` · $${sum(costs).toFixed(2)}` : "";
    const models = unique(agents.map((a) => t(a.model)).filter((m) => m !== "")).join(", ");
    out.push(
      paint(
        ANSI.dim,
        `AI review: ${models || "model unknown"} · ${sum(agents.map((a) => a.turns))} turns${cost} · ${unique(agents.map((a) => t(a.status))).join(", ")}`,
      ),
    );
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

type Paint = (code: string, text: string) => string;
type Plain = (text: string) => string;

function cliFinding(
  finding: Finding,
  paint: Paint,
  t: Plain,
  multiline: (s: string, i: string) => string,
): string[] {
  const out: string[] = [];
  const label = finding.severity.toUpperCase();
  out.push(
    `${paint(SEVERITY_COLOR[finding.severity] ?? "", `[${label}]`)} ${paint(ANSI.bold, t(finding.address))}  (${ACTION_TEXT[finding.action] ?? t(finding.action)})`,
  );
  if (finding.title.trim()) out.push(`  ${t(finding.title)}`);
  const groups = relatedGroups(finding);
  if (groups.length > 0) {
    out.push("  Same cause, also changes:");
    for (const g of groups.slice(0, 10)) {
      const shown = g.addresses.slice(0, 8).map(t).join(", ");
      const more = g.addresses.length > 8 ? ` and ${g.addresses.length - 8} more` : "";
      out.push(
        `    ${ACTION_TEXT[g.action] ?? t(g.action)} ${t(g.type)} x${g.addresses.length}: ${shown}${more}`,
      );
    }
    if (groups.length > 10) out.push(`    ... ${groups.length - 10} more kinds`);
  }
  if (finding.impact.trim()) out.push(`  Why it matters: ${multiline(finding.impact, "    ")}`);
  if (finding.cause.trim()) out.push(`  Why it happens: ${multiline(finding.cause, "    ")}`);
  for (const line of chainLines(finding, null)) {
    out.push(`  Cause: ${line.head ? t(line.head) : t(finding.address)}`);
    for (const item of [...line.items, ...line.last].slice(0, 20)) {
      const changed = item.changed ? paint(ANSI.green, "  [changed in this PR]") : "";
      const detail = item.detail ? paint(ANSI.dim, `  ${truncate(t(item.detail), 160)}`) : "";
      out.push(`    <- ${t(item.text)}${detail}${changed}`);
    }
  }
  if (finding.lineage?.explanation === "upstream") {
    const up = finding.lineage.steps.find((s) => s.kind === "upstream_resource" && s.upstreamAddress);
    out.push(
      `  Follows from the change to ${up?.upstreamAddress ? t(up.upstreamAddress) : "another resource"}.`,
    );
  }
  const rules = unique(finding.signals.map((s) => t(s.ruleId)).filter(Boolean));
  out.push(
    paint(
      ANSI.dim,
      `  ${rules.length > 0 ? `rules: ${rules.join(", ")} · ` : ""}confidence: ${t(finding.confidence)} · raised by: ${ORIGIN_LABEL[finding.origin] ?? t(finding.origin)} · id ${t(finding.id)}`,
    ),
  );
  return out;
}

function cliOthers(others: readonly ScoredChange[], maxOthers: number, paint: Paint, t: Plain): string[] {
  const out = [paint(ANSI.bold, `Other changes (${othersCount(others)})`)];
  for (const severity of SEVERITY_ORDER) {
    const group = others.filter((o) => o.severity === severity);
    if (group.length === 0) continue;
    out.push(`  ${paint(SEVERITY_COLOR[severity], `${severity.toUpperCase()} (${group.length})`)}`);
    const ordered =
      severity === "low" ? [...group].sort((a, b) => cmp(a.change.address, b.change.address)) : group;
    const runs = severity === "noise" ? [] : collapseOthers(ordered).slice(0, maxOthers);
    for (const run of runs) {
      const sc = run[0]!;
      const raw = topSignal(sc)?.reason ?? "";
      const reason = run.length > 1 ? wildcardKeys(raw) : raw;
      const attrs = changedAttributeNames(sc);
      const why = reason.trim()
        ? t(reason)
        : attrs.length > 0
          ? `changes ${attrs.slice(0, 6).join(", ")}`
          : "";
      const pattern = addressPattern(run.map((r) => r.change.address));
      const deposed = sc.change.deposed !== undefined ? ` (deposed ${t(sc.change.deposed)})` : "";
      const where =
        run.length === 1
          ? `${t(sc.change.address)}${deposed}`
          : pattern !== null
            ? `${run.length} x ${t(pattern)}`
            : `${run.length} x ${t(sc.change.address)} and ${run.length - 1} more`;
      out.push(
        `    ${ACTION_TEXT[sc.change.action] ?? t(sc.change.action)}  ${where}${why ? paint(ANSI.dim, `  ${truncate(why, 200)}`) : ""}`,
      );
    }
    const listedSet = new Set(runs.flat());
    const rest = ordered.filter((sc) => !listedSet.has(sc));
    if (rest.length > 0) {
      if (runs.length > 0) out.push(`    ...and ${rest.length} more:`);
      for (const kind of groupByKind(rest))
        out.push(`    ${runs.length > 0 ? "  " : ""}${t(kindLabelText(kind))}`);
    }
  }
  return out;
}

function countsText(counts: Partial<Record<Action, number>>): string {
  const n = (a: Action): number => counts[a] ?? 0;
  const parts = [
    `+${n("create")} create`,
    `~${n("update")} update`,
    `-${n("delete")} destroy`,
    `±${n("replace")} replace`,
  ];
  for (const action of ["move", "import", "forget", "read"] as const) {
    if (n(action) > 0) parts.push(`${n(action)} ${action}${n(action) === 1 ? "" : "s"}`);
  }
  return parts.join(", ");
}

// ───────────────────────────── JSON ─────────────────────────────

export interface JsonReport {
  version: 1;
  totals: { findings: number; changes: number; counts: Partial<Record<Action, number>> };
  reviews: JsonReview[];
  /** Run-level warnings (e.g. about the PR diff); present when there are any. */
  warnings?: string[];
}

export interface JsonReview {
  rootModuleDir: string;
  summary: string;
  stats: Review["stats"];
  findings: Finding[];
  others: JsonOther[];
  agent: AgentRunInfo | null;
  notices: string[];
  warnings: string[];
  /** The plan errored or is partial: it does not show the whole change. Present only when true. */
  planIncomplete?: true;
}

export interface JsonOther {
  address: string;
  action: Action;
  severity: Severity;
  score: number;
  signals: RiskSignal[];
  /** Changed attribute paths in display form, e.g. `ingress[0].cidr_blocks`. */
  changedAttributes: string[];
  replacePaths: string[];
  previousAddress?: string;
  /** Deposed key of a leftover object from an interrupted create_before_destroy replacement. */
  deposed?: string;
}

/** Stable, plain-data report (fixed key order, no Sets/Maps, no resource values) for `--format json` and action outputs. */
export function toJsonReport(reviews: readonly Review[], runWarnings: readonly string[] = []): JsonReport {
  const report: JsonReport = {
    version: 1,
    totals: {
      findings: sum(reviews.map((r) => r.findings.length)),
      changes: sum(reviews.map((r) => r.stats.totalChanges)),
      counts: mergeCounts(reviews.map((r) => r.stats.counts)),
    },
    reviews: reviews.map((r) => ({
      rootModuleDir: r.rootModuleDir,
      ...(isIncomplete(r) && { planIncomplete: true as const }),
      summary: clean(r.summary),
      stats: {
        totalChanges: r.stats.totalChanges,
        counts: sortKeys(r.stats.counts),
        bySeverity: sortKeys(r.stats.bySeverity),
      },
      findings: r.findings.map(jsonFinding),
      others: r.others.map(jsonOther),
      agent: r.agent ? jsonAgent(r.agent) : null,
      notices: (r.notices ?? []).map(clean),
      warnings: r.warnings.map(clean),
    })),
  };
  if (runWarnings.length > 0) report.warnings = runWarnings.map(clean);
  return report;
}

export function renderJson(reviews: readonly Review[], runWarnings: readonly string[] = []): string {
  return `${JSON.stringify(toJsonReport(reviews, runWarnings), null, 2)}\n`;
}

function jsonFinding(f: Finding): Finding {
  const out: Finding = {
    id: f.id,
    address: f.address,
    action: f.action,
    severity: f.severity,
    title: clean(f.title),
    impact: clean(f.impact),
    cause: clean(f.cause),
    causeLinks: f.causeLinks.map((l) => ({
      location: jsonLocation(l.location),
      label: clean(l.label),
      changedInDiff: l.changedInDiff,
    })),
    signals: f.signals.map(jsonSignal),
    confidence: f.confidence,
    origin: f.origin,
  };
  if (f.relatedAddresses?.length) out.relatedAddresses = [...f.relatedAddresses];
  if (f.lineage) out.lineage = jsonLineage(f.lineage);
  return out;
}

function jsonLineage(l: Lineage): Lineage {
  return {
    address: l.address,
    attribute: [...l.attribute],
    steps: l.steps.map((s) => {
      const step: Lineage["steps"][number] = {
        id: s.id,
        kind: s.kind,
        modulePath: [...s.modulePath],
        label: clean(s.label),
        references: [...s.references],
        changedInDiff: s.changedInDiff,
      };
      if (s.snippet !== undefined) step.snippet = clean(s.snippet);
      if (s.location) step.location = jsonLocation(s.location);
      if (s.upstreamAddress !== undefined) step.upstreamAddress = s.upstreamAddress;
      return step;
    }),
    rootCauseIds: [...l.rootCauseIds],
    explanation: l.explanation,
    notes: l.notes.map(clean),
  };
}

function jsonLocation(loc: SourceLocation): SourceLocation {
  const out: SourceLocation = { file: loc.file, startLine: loc.startLine, endLine: loc.endLine };
  if (loc.side === "base") out.side = "base";
  return out;
}

function jsonSignal(s: RiskSignal): RiskSignal {
  const out: RiskSignal = { ruleId: s.ruleId, severity: s.severity, reason: clean(s.reason) };
  if (s.path) out.path = [...s.path];
  return out;
}

function jsonOther(sc: ScoredChange): JsonOther {
  const c = sc.change;
  const out: JsonOther = {
    address: c.address,
    action: c.action,
    severity: sc.severity,
    score: sc.score,
    signals: sc.signals.map(jsonSignal),
    changedAttributes: c.changedPaths.map(formatPath),
    replacePaths: c.replacePaths.map(formatPath),
  };
  if (c.previousAddress) out.previousAddress = c.previousAddress;
  if (c.deposed !== undefined) out.deposed = c.deposed;
  return out;
}

function jsonAgent(a: AgentRunInfo): AgentRunInfo {
  const out: AgentRunInfo = {
    model: a.model,
    turns: a.turns,
    toolCalls: a.toolCalls,
    costUsd: a.costUsd,
    inputTokens: a.inputTokens,
    outputTokens: a.outputTokens,
    durationMs: a.durationMs,
    status: a.status,
  };
  if (a.error !== undefined) out.error = clean(a.error);
  return out;
}

// ───────────────────────────── helpers ─────────────────────────────

/** Defense in depth: values are masked upstream, but nothing secret-looking reaches output either way. */
function clean(text: string | undefined | null): string {
  if (typeof text !== "string" || text === "") return "";
  return redactSecrets(text).text;
}

function cap(ctx: RenderCtx, base: number): number {
  return Math.max(40, Math.floor(base * ctx.limits.text));
}

/** Truncate free text to its cap, recording a cut when the cap is below normal because of the size limit. */
function fit(ctx: RenderCtx, text: string, base: number): string {
  const max = cap(ctx, base);
  if (text.length > max && max < base) ctx.cuts.text = true;
  return truncate(text, max);
}

function displayDir(dir: string): string {
  const d = dir
    .trim()
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+$/, "");
  return d === "" ? "." : d;
}

/** Root module dir as the data marker records it ("" for the repository root). */
function rootKey(dir: string): string {
  const d = displayDir(dir);
  return d === "." ? "" : d;
}

/**
 * A finding's checkbox key: its id, qualified by a short hash of its root module unless that is the
 * repository root. Two roots that make the same change then never share (or swap) a key, whatever
 * other roots the comment shows, so a tick stays on the finding it was given to.
 */
export function checkboxId(findingId: string, rootModuleDir: string): string {
  const id = findingId.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 48) || "finding";
  const root = rootKey(rootModuleDir);
  if (root === "") return id;
  return `${id}:${createHash("sha256").update(root).digest("hex").slice(0, 8)}`;
}

/** Checkbox keys: the finding id restricted to a safe alphabet, made unique within one comment. */
function uniqueKey(id: string, used: Set<string>): string {
  const base = id.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 64) || "finding";
  let key = base;
  for (let n = 2; used.has(key); n++) key = `${base}~${n}`;
  used.add(key);
  return key;
}

function mergeCounts(all: readonly Partial<Record<Action, number>>[]): Partial<Record<Action, number>> {
  const out: Partial<Record<Action, number>> = {};
  for (const counts of all) {
    for (const [action, n] of Object.entries(counts) as [Action, number | undefined][]) {
      if (typeof n === "number") out[action] = (out[action] ?? 0) + n;
    }
  }
  return sortKeys(out);
}

function sortKeys<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b))) as T;
}

function countBy(values: readonly string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
}

/** "1 finding", "3 findings". */
function countOf(n: number, noun: string): string {
  return `${formatCount(n)} ${noun}${n === 1 ? "" : "s"}`;
}

function formatCount(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "?";
}

function formatUsd(cost: number): string {
  // `$` escaped: two on one line would render as GitHub math.
  return cost > 0 && cost < 0.01 ? "&lt;\\$0.01" : `\\$${cost.toFixed(2)}`;
}

function tableText(text: string): string {
  return escapeText(text, 120) || "—";
}
