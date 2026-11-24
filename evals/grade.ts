/**
 * Pure grading of one Review against a fixture's labels.json, and aggregation over many. See
 * evals/README.md ("Metrics") for the definitions; this file is the reference implementation.
 */
import { z } from "zod";
import { normalizePath } from "../src/git/diff.js";
import { SEVERITY_ORDER } from "../src/types.js";
import type { CauseLink, Finding, Review, Severity, SourceLocation } from "../src/types.js";

// ───────────────────────────── labels ─────────────────────────────

const EXPLANATIONS = ["diff", "upstream", "external", "unknown"] as const;
export type LabelExplanation = (typeof EXPLANATIONS)[number];

const causeSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  side: z.literal("base").optional(),
});

const materialSchema = z.object({
  address: z.string().min(1),
  severity: z.enum(["critical", "high", "medium", "low", "noise"]).optional(),
  why: z.string().optional(),
  cause: z.array(causeSchema).optional(),
  explanation: z.enum(EXPLANATIONS).optional(),
});

const SETS = ["dev", "holdout"] as const;
export type FixtureSet = (typeof SETS)[number];

const labelsSchema = z.object({
  description: z.string().optional(),
  /** "holdout" fixtures are a blind test set: never tune rules on them. Absent = "dev". */
  set: z.enum(SETS).optional(),
  material: z.array(materialSchema),
  acceptable: z.array(z.string().min(1)).optional(),
});

export type LabelCause = z.infer<typeof causeSchema>;
export type MaterialLabel = z.infer<typeof materialSchema>;
export type Labels = z.infer<typeof labelsSchema>;

/** Bad labels.json: thrown by parseLabels with every problem listed. */
export class LabelsError extends Error {
  override name = "LabelsError";
}

/** Validates labels.json (shape, no duplicate addresses, nothing both material and acceptable). */
export function parseLabels(json: unknown): Labels {
  const parsed = labelsSchema.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new LabelsError(`invalid labels: ${problems.join("; ")}`);
  }
  const labels = parsed.data;
  const problems: string[] = [];
  const material = new Set<string>();
  for (const m of labels.material) {
    if (material.has(m.address)) problems.push(`material address ${m.address} is listed twice`);
    material.add(m.address);
  }
  const acceptable = new Set<string>();
  for (const a of labels.acceptable ?? []) {
    if (material.has(a)) problems.push(`${a} is both material and acceptable`);
    if (acceptable.has(a)) problems.push(`acceptable address ${a} is listed twice`);
    acceptable.add(a);
  }
  if (problems.length > 0) throw new LabelsError(`invalid labels: ${problems.join("; ")}`);
  return labels;
}

// ───────────────────────────── per fixture ─────────────────────────────

/** How a true positive's trace was judged. */
export type TraceVerdict =
  | "traced" // a cause link to a changed line hits a labeled cause line, or the explanation matches
  | "missed" // the label says where the cause is, and the finding points elsewhere
  | "unlabeled"; // the label gives no cause lines and no explanation: not judged

/**
 * Changed-line cause links, and how many of them hit no labeled cause line ("stray": a wrong line,
 * or any changed line for a change the label says the PR does not explain). null when the label
 * gives no cause lines and no "external" explanation, so a link cannot be judged.
 */
export type LinkCount = { changed: number; stray: number } | null;

/**
 * The agent's own citations (Finding.agentCauseLinks), graded apart from the merged comment: the
 * deterministic lineage is attached to every finding and its links are merged in, so the merged
 * trace cannot tell a right agent citation from a wrong one.
 */
export interface AgentCitation {
  /**
   * "traced": a changed-line agent link hits a labeled cause line, or (external label) the agent
   * cites no changed line; "missed": otherwise; "unlabeled": the label gives neither.
   */
  trace: TraceVerdict;
  links: LinkCount;
}

export interface TruePositive {
  address: string;
  trace: TraceVerdict;
  /** How the trace matched: "line" (a cause link location) or "explanation". */
  tracedBy?: "line" | "explanation";
  labeledSeverity: Severity | null;
  /** The finding's severity, or for a related address the severity it was grouped with. */
  severity: Severity;
  /** Distance in SEVERITY_ORDER; null when the label has no severity. */
  severityDistance: number | null;
  /**
   * Labeled cause lines, and how many of them a cause link to a changed line covers. Each link
   * covers at most one labeled line, so one block-wide span cannot stand for several causes.
   */
  causeLines: { labeled: number; covered: number };
  /** The finding's changed-line cause links and how many of them hit no labeled cause line. */
  links: LinkCount;
  /** Present when the finding carries the agent's own citations (origin "agent" or "both"). */
  agent?: AgentCitation;
}

export interface FixtureGrade {
  /** Distinct flagged addresses (review.findings). */
  flagged: number;
  material: number;
  tp: TruePositive[];
  /** Flagged, neither material nor acceptable. */
  fp: string[];
  /** Material, not flagged. */
  fn: string[];
  /** Flagged and labeled acceptable: neither credit nor penalty. */
  acceptableFlagged: string[];
  /** FN that the review still listed under "other changes", with the severity it gave them. */
  fnInOthers: Record<string, Severity>;
  /** Addresses with more than one finding (counted once for TP/FP). */
  duplicateFindings: string[];
  /** TP / (TP + FP); null when nothing non-acceptable was flagged. */
  precision: number | null;
  /** TP / (TP + FN); null when the fixture has no material changes. */
  recall: number | null;
  f1: number | null;
  /** TP whose trace was judged ("traced" or "missed"). */
  traceJudged: number;
  traced: number;
  /** Over TP: labeled cause lines, and those covered by a changed-line cause link. */
  causeLines: { labeled: number; covered: number };
}

/** Holdout fixtures are named ho-*: the name alone says a fixture is blind, before it is parsed. */
export function setOfName(name: string): FixtureSet {
  return name.startsWith("ho-") ? "holdout" : "dev";
}

/**
 * The set a fixture belongs to. With its name, the name decides (ho-* = holdout) and a labels.json
 * "set" that disagrees is an error, so a holdout fixture can never be reported as dev by a missing
 * field. Without a name: labels.set, "dev" when absent.
 */
export function fixtureSet(labels: Labels, name?: string): FixtureSet {
  if (name === undefined) return labels.set ?? "dev";
  const set = setOfName(name);
  if (labels.set !== undefined && labels.set !== set) {
    throw new LabelsError(
      `labels.json says set "${labels.set}" but the fixture name ${set === "holdout" ? "starts" : "does not start"} with "ho-" (holdout fixtures are named ho-*)`,
    );
  }
  return set;
}

/**
 * Grades one review. `review.findings` is the "Needs your attention" list; nothing else counts as
 * flagged. A finding flags its address and every address in its `relatedAddresses` (one finding
 * standing for several changes with the same root cause); those share the finding's trace.
 */
export function gradeFixture(review: Review, labels: Labels): FixtureGrade {
  const material = new Map(labels.material.map((m) => [m.address, m]));
  const acceptable = new Set(labels.acceptable ?? []);

  const byAddress = new Map<string, Finding>();
  const duplicates = new Set<string>();
  for (const finding of review.findings) {
    for (const address of [finding.address, ...(finding.relatedAddresses ?? [])]) {
      if (byAddress.has(address)) duplicates.add(address);
      // The first finding wins: it is the one ranked highest in the comment.
      else byAddress.set(address, finding);
    }
  }

  const tp: TruePositive[] = [];
  const fp: string[] = [];
  const acceptableFlagged: string[] = [];
  for (const [address, finding] of byAddress) {
    const label = material.get(address);
    if (label) tp.push(truePositive(address, finding, label));
    else if (acceptable.has(address)) acceptableFlagged.push(address);
    else fp.push(address);
  }
  const fn = labels.material.map((m) => m.address).filter((a) => !byAddress.has(a));

  const othersSeverity = new Map(review.others.map((o) => [o.change.address, o.severity]));
  const fnInOthers: Record<string, Severity> = {};
  for (const address of fn) {
    const severity = othersSeverity.get(address);
    if (severity !== undefined) fnInOthers[address] = severity;
  }

  const precision = ratio(tp.length, tp.length + fp.length);
  const recall = ratio(tp.length, tp.length + fn.length);
  return {
    flagged: byAddress.size,
    material: material.size,
    tp,
    fp,
    fn,
    acceptableFlagged,
    fnInOthers,
    duplicateFindings: [...duplicates],
    precision,
    recall,
    f1: f1(precision, recall),
    traceJudged: tp.filter((t) => t.trace !== "unlabeled").length,
    traced: tp.filter((t) => t.trace === "traced").length,
    causeLines: {
      labeled: sum(tp.map((t) => t.causeLines.labeled)),
      covered: sum(tp.map((t) => t.causeLines.covered)),
    },
  };
}

function truePositive(address: string, finding: Finding, label: MaterialLabel): TruePositive {
  const labeledSeverity = label.severity ?? null;
  const severity = finding.relatedChanges?.find((r) => r.address === address)?.severity ?? finding.severity;
  const base = {
    address,
    labeledSeverity,
    severity,
    severityDistance: labeledSeverity === null ? null : severityDistance(labeledSeverity, severity),
    links: countLinks(finding.causeLinks, label),
    ...agentCitation(finding, label),
  };
  const causes = label.cause ?? [];
  // Only links to lines the PR changed count: the resource's own (unchanged) attribute line is not a cause.
  const changed = finding.causeLinks.filter((link) => link.changedInDiff);
  const covered = coveredCauses(changed, causes);
  const lines = { labeled: causes.length, covered };
  if (causes.length === 0 && label.explanation === undefined)
    return { ...base, trace: "unlabeled", causeLines: lines };
  if (covered > 0) return { ...base, trace: "traced", tracedBy: "line", causeLines: lines };
  if (label.explanation !== undefined && explanationMatches(finding, label.explanation)) {
    return { ...base, trace: "traced", tracedBy: "explanation", causeLines: lines };
  }
  return { ...base, trace: "missed", causeLines: lines };
}

function agentCitation(finding: Finding, label: MaterialLabel): { agent?: AgentCitation } {
  const cited = finding.agentCauseLinks;
  if (cited === undefined) return {};
  const causes = label.cause ?? [];
  const changed = cited.filter((link) => link.changedInDiff);
  const links = countLinks(cited, label);
  let trace: TraceVerdict;
  // Without cause lines, only an "external" label says what the agent should cite (nothing).
  if (causes.length === 0 && label.explanation !== "external") trace = "unlabeled";
  else if (coveredCauses(changed, causes) > 0) trace = "traced";
  // Nothing in the PR explains an external change: the right citation is no changed line at all.
  else if (label.explanation === "external" && changed.length === 0) trace = "traced";
  else trace = "missed";
  return { agent: { trace, links } };
}

function countLinks(links: readonly CauseLink[], label: MaterialLabel): LinkCount {
  const causes = label.cause ?? [];
  if (causes.length === 0 && label.explanation !== "external") return null;
  const changed = links.filter((link) => link.changedInDiff);
  return {
    changed: changed.length,
    stray: changed.filter((link) => !causes.some((c) => locationHits(link.location, c))).length,
  };
}

/**
 * How many labeled cause lines the links cover when each link covers at most one of them (a
 * maximum matching), so a link spanning a whole deleted block does not count as every labeled line
 * inside it.
 */
export function coveredCauses(links: readonly CauseLink[], causes: readonly LabelCause[]): number {
  const owner = new Map<number, number>(); // link index -> cause index
  const assign = (cause: number, seen: Set<number>): boolean => {
    for (const [i, link] of links.entries()) {
      const target = causes[cause];
      if (target === undefined || seen.has(i) || !locationHits(link.location, target)) continue;
      seen.add(i);
      const current = owner.get(i);
      if (current === undefined || assign(current, seen)) {
        owner.set(i, cause);
        return true;
      }
    }
    return false;
  };
  let covered = 0;
  for (const cause of causes.keys()) if (assign(cause, new Set())) covered++;
  return covered;
}

/** Same file, same side (head unless "base"), labeled line inside the location's span. */
export function locationHits(location: SourceLocation, cause: LabelCause): boolean {
  return (
    normalizePath(location.file) === normalizePath(cause.file) &&
    (location.side ?? "head") === (cause.side ?? "head") &&
    cause.line >= location.startLine &&
    cause.line <= location.endLine
  );
}

/**
 * Says the change does NOT come from the PR's code. Only consulted for findings without a lineage
 * (rule findings past the tracing limit; the review attaches a lineage to every agent finding), and
 * only when none of their cause links is a changed line.
 */
const NOT_FROM_DIFF =
  /\bnot (?:caused by|from|in|introduced by|part of) (?:the|this|your) (?:pr|diff|pull request|change)|\boutside (?:the|this) (?:pr|diff|pull request|repo(?:sitory)?)|\bno (?:code|line|change) in (?:the|this|your) (?:pr|diff|pull request)|\bdrift\b/i;

/**
 * The finding's lineage gives the labeled explanation. Without a lineage, an "external" label also
 * accepts a finding that links no changed line and whose cause text says it is not from the diff.
 */
export function explanationMatches(finding: Finding, expected: LabelExplanation): boolean {
  if (finding.lineage) return finding.lineage.explanation === expected;
  return (
    expected === "external" &&
    !finding.causeLinks.some((link) => link.changedInDiff) &&
    NOT_FROM_DIFF.test(finding.cause)
  );
}

export function severityDistance(a: Severity, b: Severity): number {
  return Math.abs(SEVERITY_ORDER.indexOf(a) - SEVERITY_ORDER.indexOf(b));
}

// ───────────────────────────── aggregate ─────────────────────────────

export interface Summary {
  fixtures: number;
  tp: number;
  fp: number;
  fn: number;
  acceptableFlagged: number;
  /** Micro-averaged over all fixtures (sums of TP/FP/FN). */
  precision: number | null;
  recall: number | null;
  f1: number | null;
  /** Fixtures with no FP and no FN (run-evals leaves out cases whose review crashed). */
  perfect: number;
  trace: { judged: number; traced: number; accuracy: number | null };
  /** Labeled cause lines covered by a changed-line cause link / labeled cause lines (over TP). */
  causeLineRecall: { labeled: number; covered: number; recall: number | null };
  /** Changed-line cause links that hit a labeled cause line / changed-line links (over judged TP). */
  linkPrecision: LinkPrecision;
  /**
   * The agent's own citations, over TP that carry them (AgentCitation): judged/traced as for
   * trace accuracy, and the precision of the changed lines it cited. judged 0 without an agent.
   */
  agentTrace: { judged: number; traced: number; accuracy: number | null; links: LinkPrecision };
  /** Over TP whose label has a severity. */
  severity: { compared: number; exact: number; offByOne: number; worse: number };
}

export interface LinkPrecision {
  changed: number;
  stray: number;
  precision: number | null;
}

function linkPrecision(counts: readonly LinkCount[]): LinkPrecision {
  const changed = sum(counts.map((c) => c?.changed ?? 0));
  const stray = sum(counts.map((c) => c?.stray ?? 0));
  return { changed, stray, precision: ratio(changed - stray, changed) };
}

export function aggregate(grades: readonly FixtureGrade[]): Summary {
  const tp = sum(grades.map((g) => g.tp.length));
  const fp = sum(grades.map((g) => g.fp.length));
  const fn = sum(grades.map((g) => g.fn.length));
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const judged = sum(grades.map((g) => g.traceJudged));
  const traced = sum(grades.map((g) => g.traced));
  const distances = grades.flatMap((g) =>
    g.tp.flatMap((t) => (t.severityDistance === null ? [] : [t.severityDistance])),
  );
  return {
    fixtures: grades.length,
    tp,
    fp,
    fn,
    acceptableFlagged: sum(grades.map((g) => g.acceptableFlagged.length)),
    precision,
    recall,
    f1: f1(precision, recall),
    perfect: grades.filter((g) => g.fp.length === 0 && g.fn.length === 0).length,
    trace: { judged, traced, accuracy: ratio(traced, judged) },
    causeLineRecall: (() => {
      const labeled = sum(grades.map((g) => g.causeLines.labeled));
      const covered = sum(grades.map((g) => g.causeLines.covered));
      return { labeled, covered, recall: ratio(covered, labeled) };
    })(),
    linkPrecision: linkPrecision(grades.flatMap((g) => g.tp.map((t) => t.links))),
    agentTrace: (() => {
      const cited = grades.flatMap((g) => g.tp.flatMap((t) => (t.agent ? [t.agent] : [])));
      const judged = cited.filter((a) => a.trace !== "unlabeled").length;
      const traced = cited.filter((a) => a.trace === "traced").length;
      return {
        judged,
        traced,
        accuracy: ratio(traced, judged),
        links: linkPrecision(cited.map((a) => a.links)),
      };
    })(),
    severity: {
      compared: distances.length,
      exact: distances.filter((d) => d === 0).length,
      offByOne: distances.filter((d) => d === 1).length,
      worse: distances.filter((d) => d > 1).length,
    },
  };
}

// ───────────────────────────── helpers ─────────────────────────────

/** n / d, or null for 0/0. */
export function ratio(n: number, d: number): number | null {
  return d === 0 ? null : n / d;
}

/**
 * Harmonic mean. 0 when either side is 0 (material missed with nothing flagged, or only false
 * positives on a fixture with no material); otherwise null when either side is undefined.
 */
export function f1(precision: number | null, recall: number | null): number | null {
  if (precision === 0 || recall === 0) return 0;
  if (precision === null || recall === null) return null;
  return (2 * precision * recall) / (precision + recall);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, v) => total + v, 0);
}
