import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { AgentFinding, AgentVerdict, Confidence } from "../types.js";

// Length limits live in the descriptions, not in the schema: structured outputs do not support
// minLength/maxItems, and the SDK would turn them into client-side checks that reject an
// otherwise useful answer over one extra character. parseVerdict() clips instead.

export const MAX_TITLE_CHARS = 100;

const SEVERITY_VALUES = ["critical", "high", "medium"] as const satisfies readonly AgentFinding["severity"][];
const CONFIDENCE_VALUES = ["high", "medium", "low"] as const satisfies readonly Confidence[];

// Not z.int(): its JSON Schema carries safe-integer bounds that structured outputs cannot
// enforce, so the SDK would push them into the description as noise for the model.
const wholeNumber = () => z.number().refine(Number.isInteger, { message: "must be a whole number" });

const CauseRefSchema = z.object({
  file: z
    .string()
    .describe(
      "Repository-relative path exactly as shown in a lineage location or a tool result, e.g. main.tf or modules/db/main.tf.",
    ),
  line: wholeNumber().describe(
    "1-based line number in that file at the PR head, exactly as shown in a lineage location or a read_file, " +
      "search_repo or get_diff result. Never estimated.",
  ),
});

const FindingSchema = z.object({
  address: z.string().describe("Exact resource instance address of a change in this plan."),
  severity: z
    .enum(SEVERITY_VALUES)
    .describe(
      "critical: data loss, an outage or a security exposure is likely. high: needs a deliberate yes. " +
        "medium: worth a look.",
    ),
  title: z
    .string()
    .describe(
      `At most ${MAX_TITLE_CHARS} characters: what happens, concretely, e.g. ` +
        '"orders database is destroyed and re-created: storage encryption turned off".',
    ),
  impact: z.string().describe("1-2 sentences: what happens if this plan is applied as is."),
  cause: z
    .string()
    .describe(
      "1-2 sentences: why the plan does this, traced from the attribute through module inputs and " +
        "variables to the PR's change; or where the change comes from when the PR does not explain it.",
    ),
  cause_refs: z
    .array(CauseRefSchema)
    .describe(
      "0-4 lines that cause the change, the PR's changed lines first. Empty when the cause is outside the repository.",
    ),
  confidence: z
    .enum(CONFIDENCE_VALUES)
    .describe(
      "high: tool results confirm the change and its cause. medium: one link is inferred. " +
        "low: plausible from partial evidence.",
    ),
});

const DismissedSchema = z.object({
  address: z.string().describe("Exact address of a candidate judged not material."),
  reason: z.string().describe("One sentence: why it does not need a reviewer's attention."),
});

export const VerdictSchema = z.object({
  summary: z
    .string()
    .describe("2-4 plain sentences: what the PR does to the infrastructure and what needs attention."),
  findings: z
    .array(FindingSchema)
    .describe("One entry per material change, most severe first. Empty when nothing needs attention."),
  dismissed: z.array(DismissedSchema).describe("Every candidate judged not material, each with a reason."),
});

export type WireVerdict = z.infer<typeof VerdictSchema>;

// Compile-time guard: the wire schema is AgentVerdict with snake_case cause_refs.
type WireFinding = WireVerdict["findings"][number];
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type CamelFinding = { [K in keyof WireFinding as K extends "cause_refs" ? "causeRefs" : K]: WireFinding[K] };
const findingMatchesContract: Equals<CamelFinding, AgentFinding> = true;
const verdictKeysMatch: Equals<keyof WireVerdict, keyof AgentVerdict> = true;
void findingMatchesContract;
void verdictKeysMatch;

/** `output_config.format` for the Messages API, built from the schema above. */
export const VERDICT_OUTPUT_FORMAT = betaZodOutputFormat(VerdictSchema);

/**
 * Parse the model's final text into an AgentVerdict, or null when it is not a valid one.
 * Tolerates a code fence or stray prose around the object, which structured outputs should
 * prevent but a fallback model or a cut-off reply can still produce.
 */
export function parseVerdict(text: string): AgentVerdict | null {
  for (const candidate of jsonCandidates(text)) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    const parsed = VerdictSchema.safeParse(value);
    if (parsed.success) return toVerdict(parsed.data);
  }
  return null;
}

/** snake_case → camelCase, plus light cleanup: trimmed text, clipped titles, sane cause refs, no duplicates. */
export function toVerdict(wire: WireVerdict): AgentVerdict {
  const seen = new Set<string>();
  const findings: AgentFinding[] = [];
  for (const finding of wire.findings) {
    const address = finding.address.trim();
    if (address === "" || seen.has(address)) continue;
    seen.add(address);
    findings.push({
      address,
      severity: finding.severity,
      title: clipTitle(finding.title.trim()),
      impact: finding.impact.trim(),
      cause: finding.cause.trim(),
      causeRefs: cleanRefs(finding.cause_refs),
      confidence: finding.confidence,
    });
  }
  const dismissedSeen = new Set<string>();
  const dismissed: AgentVerdict["dismissed"] = [];
  for (const entry of wire.dismissed) {
    const address = entry.address.trim();
    // A change the model both flags and dismisses stays flagged.
    if (address === "" || seen.has(address) || dismissedSeen.has(address)) continue;
    dismissedSeen.add(address);
    dismissed.push({ address, reason: entry.reason.trim() });
  }
  return { summary: wire.summary.trim(), findings, dismissed };
}

function cleanRefs(refs: WireFinding["cause_refs"]): AgentFinding["causeRefs"] {
  const out: AgentFinding["causeRefs"] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    let file = ref.file
      .trim()
      .replace(/\\/g, "/")
      .replace(/^(\.\/)+/, "")
      .replace(/^\/+/, "");
    let line = ref.line;
    // "main.tf:12" in the file field, with or without a line.
    const embedded = /^(.+?):(\d+)(?:-\d+)?$/.exec(file);
    if (embedded) {
      file = embedded[1]!;
      if (!(line >= 1)) line = Number(embedded[2]);
    }
    if (file === "" || !(line >= 1)) continue;
    const key = `${file}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ file, line });
  }
  return out;
}

function clipTitle(title: string): string {
  const chars = Array.from(title);
  if (chars.length <= MAX_TITLE_CHARS) return title;
  return `${chars
    .slice(0, MAX_TITLE_CHARS - 1)
    .join("")
    .trimEnd()}…`;
}

function jsonCandidates(text: string): string[] {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if ((first > 0 || (last !== -1 && last < trimmed.length - 1)) && first !== -1 && last > first) {
    candidates.push(trimmed.slice(first, last + 1));
  }
  return candidates;
}
