/*
 * Live precision/recall from reviewer feedback on the sticky PR comment.
 *
 * Feedback on one PR:
 * - flagged: the findings listed in the comment's hidden data marker (only findings that were shown
 *   shown with a checkbox are listed there), plus the `earlier` findings an earlier run showed that the
 *   current plan no longer has (typically fixed by a later push), with the tick they had then;
 * - confirmed: a flagged finding whose `- [x] Confirmed` box is ticked, or whose address a reviewer
 *   names in a `missed:` reply (naming a flagged change says it matters, so it counts as a confirmation);
 * - missed: distinct addresses from `missed: <address>` replies that the bot did not flag.
 *
 * A PR may have several sticky comments (one per plan set, e.g. matrix jobs): their findings are
 * pooled. When the comments cover several root modules, a reply names the root as
 * `missed: <root module dir>:<address>`; an unqualified address that a flagged finding has is then
 * ambiguous (the reviewer may mean another root) and counts neither way.
 *
 * Metrics over many PRs (computeMetrics) count a PR only when it has this tool's comment and feedback
 * on it (a ticked box or a `missed:` reply): a PR nobody reacted to says nothing about precision.
 * Over counted PRs:
 *   precision = confirmed / flagged
 *   recall    = confirmed / (confirmed + missed)
 * Both are null when their denominator is 0. An unticked box is "not confirmed", not "rejected", so
 * precision is a lower bound. Missed changes have no severity, so recall is overall only.
 */

export interface FlaggedFinding {
  /** Checkbox key from the data marker (the finding id, de-duplicated within the comment). */
  id: string;
  address: string;
  severity: string;
  origin: string;
  /** Root module dir, when the marker records it. */
  root?: string;
  /** Other addresses the finding stands for (one root cause, several changes). */
  related?: string[];
  confirmed: boolean;
  /** Shown by an earlier run of the comment, not by the latest one. */
  earlier?: boolean;
}

export interface PrFeedback {
  /** Set by the GitHub collector. */
  pr?: { number: number; url?: string; updatedAt?: string };
  /** True when the PR has this tool's comment with a readable data marker. */
  hasReview: boolean;
  findings: FlaggedFinding[];
  /** Distinct addresses reviewers said the bot missed (flagged addresses excluded). */
  missed: string[];
  /** The PR has our comment and any ticked box or `missed:` reply. Only PRs with feedback count in metrics. */
  hasFeedback: boolean;
}

export interface Reply {
  body: string;
  author?: string;
}

const DATA_LINE = /^[ \t]*<!-- tf-change-reviewer:data (.*) -->[ \t]*$/m;
const CHECKBOX =
  /^[ \t]*[-*+][ \t]+\[([ xX])\][ \t]+Confirmed\b[^\n]*?<!--[ \t]*finding:([A-Za-z0-9_.:~-]+)[ \t]*-->[ \t]*$/gm;
const MISSED_LINE = /^[ \t]*(?:[-*+][ \t]+)?\**missed\**[ \t]*:[ \t]*(.*)$/gim;
/** `envs/prod:aws_x.y`: a root module dir (no brackets or quotes) before the address. */
const ROOT_QUALIFIED = /^([\w./-]+):(.+)$/;
const MAX_BODY = 200_000;
const MAX_MISSED_PER_REPLY = 50;
/** Related addresses kept per earlier finding. */
const MAX_EARLIER_RELATED = 10;

/** An instance key: a quoted string (which may hold `]` or escaped quotes) or a bare index. */
const KEY = String.raw`\[(?:"(?:[^"\\\n]|\\.)*"|[^\]"\n]+)\]`;
/**
 * Terraform address shapes accepted from replies: a resource instance (optionally in modules,
 * optionally a data source) or a module instance. Keys may hold spaces only inside brackets.
 */
const MODULE_SEG = String.raw`module\.[A-Za-z_][\w-]*(?:${KEY})?`;
const RESOURCE = String.raw`(?:data\.)?[A-Za-z_][\w-]*\.[A-Za-z_][\w-]*(?:${KEY})?`;
const ADDRESS = new RegExp(
  String.raw`^(?:(?:${MODULE_SEG}\.)*${RESOURCE}|${MODULE_SEG}(?:\.${MODULE_SEG})*)$`,
);

/**
 * Parse the bot comment (null when the PR has none; several when it has one per plan set) and the
 * other comments on the PR.
 */
export function parseFeedback(
  commentBody: string | readonly string[] | null,
  replies: readonly Reply[],
): PrFeedback {
  const bodies = (
    commentBody === null ? [] : typeof commentBody === "string" ? [commentBody] : commentBody
  ).map((b) => b.slice(0, MAX_BODY).replace(/\r\n?/g, "\n"));
  const findings: FlaggedFinding[] = [];
  const roots = new Set<string>();
  let hasMarker = false;
  for (const body of bodies) {
    const data = parseMarkerData(body);
    if (data === null) continue;
    hasMarker = true;
    const ticked = parseConfirmedIds(body);
    const seen = new Set<string>();
    for (const f of data.findings) {
      seen.add(f.id);
      findings.push({ ...f, confirmed: ticked.has(f.id) });
    }
    for (const f of data.earlier) if (!seen.has(f.id)) findings.push(f);
    for (const r of data.roots) roots.add(normalizeRoot(r));
    for (const f of [...data.findings, ...data.earlier]) roots.add(normalizeRoot(f.root ?? ""));
  }
  const multiRoot = roots.size > 1;

  const flaggedByAddress = new Map<string, FlaggedFinding[]>();
  for (const f of findings) {
    for (const address of [f.address, ...(f.related ?? [])])
      flaggedByAddress.set(address, [...(flaggedByAddress.get(address) ?? []), f]);
  }

  const missed = new Set<string>();
  let anyMissedReply = false;
  for (const reply of replies) {
    for (const entry of parseMissedEntries(reply.body)) {
      anyMissedReply = true;
      const all = flaggedByAddress.get(entry.address) ?? [];
      if (entry.root === undefined) {
        if (all.length === 0) missed.add(entry.address);
        // Flagged in some root, but which one did the reviewer mean? Count it neither way.
        else if (!multiRoot) for (const f of all) f.confirmed = true;
        continue;
      }
      const root = normalizeRoot(entry.root);
      const flagged = all.filter((f) => normalizeRoot(f.root ?? "") === root);
      if (flagged.length > 0) for (const f of flagged) f.confirmed = true;
      else missed.add(root === "" ? entry.address : `${root}:${entry.address}`);
    }
  }
  return {
    hasReview: hasMarker,
    findings,
    missed: [...missed].sort(),
    // Without our comment there was nothing to react to: a stray `missed:` reply is not feedback on a review.
    hasFeedback: hasMarker && (anyMissedReply || findings.some((f) => f.confirmed)),
  };
}

function normalizeRoot(dir: string): string {
  const d = dir
    .trim()
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+$/, "");
  return d === "." ? "" : d;
}

interface MarkerData {
  findings: Omit<FlaggedFinding, "confirmed">[];
  earlier: FlaggedFinding[];
  roots: string[];
}

function parseMarkerData(body: string): MarkerData | null {
  const json = DATA_LINE.exec(body)?.[1];
  if (json === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.findings)) return null;
  const findings = markerEntries(parsed.findings, new Set()).map(([f]) => f);
  const earlier = Array.isArray(parsed.earlier)
    ? markerEntries(parsed.earlier, new Set(findings.map((f) => f.id))).map(([f, raw]) => ({
        ...f,
        confirmed: raw.confirmed === true,
        earlier: true,
      }))
    : [];
  const roots = Array.isArray(parsed.roots)
    ? parsed.roots.filter((r): r is string => typeof r === "string")
    : [];
  return { findings, earlier, roots };
}

/** Findings recorded in the hidden data marker; null when absent or unreadable. */
export function parseDataMarker(body: string): Omit<FlaggedFinding, "confirmed">[] | null {
  return parseMarkerData(body)?.findings ?? null;
}

/**
 * Everything a comment's data marker recorded, for carrying into its next version: the findings it
 * showed (ticked or not) and its earlier ones, most recent first. Root is "" for the repository root.
 */
export function parseEarlierFindings(
  body: string,
): (Omit<FlaggedFinding, "root" | "earlier"> & { root: string })[] {
  const text = body.slice(0, MAX_BODY).replace(/\r\n?/g, "\n");
  const data = parseMarkerData(text);
  if (data === null) return [];
  const ticked = parseConfirmedIds(text);
  const strip = (f: Omit<FlaggedFinding, "confirmed">, confirmed: boolean) => {
    const out: Omit<FlaggedFinding, "root" | "earlier"> & { root: string } = {
      id: f.id,
      address: f.address,
      severity: f.severity,
      origin: f.origin,
      root: f.root ?? "",
      confirmed,
    };
    if (f.related) out.related = f.related.slice(0, MAX_EARLIER_RELATED);
    return out;
  };
  return [
    ...data.findings.map((f) => strip(f, ticked.has(f.id))),
    ...data.earlier.map((f) => strip(f, f.confirmed)),
  ];
}

/**
 * Marker entries with a string id and address, first of each id only (ids in `skip` are left out),
 * each with its raw record.
 */
function markerEntries(
  items: readonly unknown[],
  skip: ReadonlySet<string>,
): [Omit<FlaggedFinding, "confirmed">, Record<string, unknown>][] {
  const out: [Omit<FlaggedFinding, "confirmed">, Record<string, unknown>][] = [];
  const seen = new Set(skip);
  for (const item of items) {
    if (!isRecord(item)) continue;
    const { id, address, severity, origin, root, related } = item;
    if (typeof id !== "string" || typeof address !== "string" || id === "" || seen.has(id)) continue;
    seen.add(id);
    const finding: Omit<FlaggedFinding, "confirmed"> = {
      id,
      address,
      severity: typeof severity === "string" ? severity : "unknown",
      origin: typeof origin === "string" ? origin : "unknown",
    };
    if (typeof root === "string") finding.root = root;
    if (Array.isArray(related)) {
      const addresses = related.filter((a): a is string => typeof a === "string" && a !== "");
      if (addresses.length > 0) finding.related = addresses;
    }
    out.push([finding, item]);
  }
  return out;
}

/** Keys of ticked `Confirmed` checkboxes. Also used to carry ticks over when the comment is re-rendered. */
export function parseConfirmedIds(body: string): Set<string> {
  const ids = new Set<string>();
  for (const match of body.replace(/\r\n?/g, "\n").matchAll(CHECKBOX)) {
    if (match[1] !== " " && match[2]) ids.add(match[2]);
  }
  return ids;
}

/**
 * Addresses named in `missed:` lines of one reply. Accepts several lines per reply and several
 * addresses per line (backticked, or separated by spaces/commas); words that are not Terraform
 * addresses (prose after the address, the `<address>` placeholder) are ignored. Quoted lines
 * (`> missed: …`) are not counted, so quoting someone else's reply adds nothing. A root-qualified
 * address (`envs/prod:aws_x.y`) comes back as written.
 */
export function parseMissedAddresses(text: string): string[] {
  return parseMissedEntries(text).map((e) => (e.root === undefined ? e.address : `${e.root}:${e.address}`));
}

/** `missed:` addresses of one reply, each with the root module dir it names, if any. */
export function parseMissedEntries(text: string): { root?: string; address: string }[] {
  const out: { root?: string; address: string }[] = [];
  const seen = new Set<string>();
  const body = text.slice(0, MAX_BODY).replace(/\r\n?/g, "\n");
  for (const match of body.matchAll(MISSED_LINE)) {
    const rest = match[1] ?? "";
    const ticked = [...rest.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? "");
    const candidates = ticked.length > 0 ? ticked : rest.split(/[\s,;]+/);
    for (const raw of candidates) {
      const word = raw.trim().replace(/[.,;:!?)]+$/, "");
      const qualified = ADDRESS.test(word) ? null : ROOT_QUALIFIED.exec(word);
      const entry =
        qualified && ADDRESS.test(qualified[2] ?? "")
          ? { root: qualified[1] ?? "", address: qualified[2] ?? "" }
          : ADDRESS.test(word)
            ? { address: word }
            : null;
      if (entry === null) continue;
      const k = `${entry.root ?? ""}\u0000${entry.address}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push(entry);
      }
      if (out.length >= MAX_MISSED_PER_REPLY) return out;
    }
  }
  return out;
}

// ───────────────────────────── metrics ─────────────────────────────

export interface Breakdown {
  flagged: number;
  confirmed: number;
  /** confirmed / flagged; null when nothing was flagged. */
  precision: number | null;
}

export interface Metrics {
  prs: {
    /** PRs looked at. */
    total: number;
    /** PRs with this tool's comment. */
    reviewed: number;
    /** PRs with any feedback: the ones the metrics below are computed over. */
    counted: number;
  };
  flagged: number;
  confirmed: number;
  missed: number;
  /** confirmed / flagged over counted PRs; null when nothing was flagged. A lower bound (unticked ≠ wrong). */
  precision: number | null;
  /** confirmed / (confirmed + missed) over counted PRs; null when both are 0. */
  recall: number | null;
  /** By finding severity (critical/high/medium). */
  bySeverity: Record<string, Breakdown>;
  /** By who raised the finding (rules/agent/both). */
  byOrigin: Record<string, Breakdown>;
  /** Every missed address with its PR number, for follow-up (rules to add). */
  missedChanges: { pr: number | null; address: string }[];
}

export function computeMetrics(prs: readonly PrFeedback[]): Metrics {
  const counted = prs.filter((p) => p.hasFeedback);
  const bySeverity: Record<string, Breakdown> = {};
  const byOrigin: Record<string, Breakdown> = {};
  let flagged = 0;
  let confirmed = 0;
  let missed = 0;
  const missedChanges: Metrics["missedChanges"] = [];
  for (const pr of counted) {
    for (const f of pr.findings) {
      flagged++;
      if (f.confirmed) confirmed++;
      tally(bySeverity, f.severity, f.confirmed);
      tally(byOrigin, f.origin, f.confirmed);
    }
    missed += pr.missed.length;
    for (const address of pr.missed) missedChanges.push({ pr: pr.pr?.number ?? null, address });
  }
  return {
    prs: { total: prs.length, reviewed: prs.filter((p) => p.hasReview).length, counted: counted.length },
    flagged,
    confirmed,
    missed,
    precision: ratio(confirmed, flagged),
    recall: ratio(confirmed, confirmed + missed),
    bySeverity: finish(bySeverity),
    byOrigin: finish(byOrigin),
    missedChanges,
  };
}

function tally(into: Record<string, Breakdown>, key: string, confirmed: boolean): void {
  const b = (into[key] ??= { flagged: 0, confirmed: 0, precision: null });
  b.flagged++;
  if (confirmed) b.confirmed++;
}

function finish(into: Record<string, Breakdown>): Record<string, Breakdown> {
  for (const b of Object.values(into)) b.precision = ratio(b.confirmed, b.flagged);
  return into;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
