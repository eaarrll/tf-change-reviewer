/*
 * Deterministic finding text and structure: stable ids, titles, "why it matters" / "why it happens"
 * text built from the risk signals and the lineage chain, cause links, the "not explained by this
 * PR" wording, and grouping of findings that share one root cause. Used by review.ts when the agent
 * did not supply its own text (rules-only runs, agent failures, findings the agent did not mention).
 */
import { createHash } from "node:crypto";
import { causePaths, collapsePath, encloses, topSteps } from "./lineage/chain.js";
import { describePath, getAtPath, parseAddress, pathKey } from "./plan/paths.js";
import { classify, fmtValue, isUnknownAt, severityRank } from "./risk/rules.js";
import { isDestroyPlan } from "./risk/score.js";
import { locationLabel } from "./report/links.js";
import { SENSITIVE_PLACEHOLDER } from "./types.js";
import type {
  Action,
  AttrPath,
  CauseLink,
  Confidence,
  Finding,
  Lineage,
  LineageStep,
  PlanModel,
  RelatedChange,
  ResourceChange,
  ScoredChange,
  Severity,
  SourceLocation,
} from "./types.js";

export const MAX_TITLE_CHARS = 100;
const MAX_IMPACT_SIGNALS = 4;
const MAX_LABEL_SNIPPET = 80;

/** Keys that usually hold a resource's real-world name, in order of preference. */
const IDENTITY_KEYS = [
  "identifier",
  "name",
  "bucket",
  "function_name",
  "cluster_identifier",
  "cluster_name",
  "table_name",
  "domain_name",
  "repository_name",
  "queue_name",
  "topic_name",
  "role_name",
  "policy_name",
  "family",
];

/** sha256(address + primary rule id), first 12 hex: stable across re-runs, so feedback maps back. */
export function findingId(address: string, primaryRule: string): string {
  return createHash("sha256").update(`${address}\u0000${primaryRule}`).digest("hex").slice(0, 12);
}

/** The rule id of the most severe signal ("agent" when the rules raised nothing). */
export function primaryRule(scored: ScoredChange | null): string {
  const real = (scored?.signals ?? []).filter((s) => s.severity !== "noise");
  if (!real.length) return "agent";
  return [...real].sort((a, b) => severityRank(a.severity) - severityRank(b.severity))[0]!.ruleId;
}

export function lowerConfidence(c: Confidence): Confidence {
  return c === "high" ? "medium" : "low";
}

function capitalize(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}

/** At most `max` characters, cut at a word boundary with "…" (never mid-word, never "….". */
export function clip(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  let cut = chars.slice(0, Math.max(1, max - 1)).join("");
  const space = cut.lastIndexOf(" ");
  if (space >= cut.length * 0.5) cut = cut.slice(0, space);
  return `${cut.replace(/[\s,;:.(\-–—]+$/u, "")}…`;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A sentence ending: adds "." unless it already ends in punctuation (or an ellipsis). */
function sentence(text: string): string {
  const t = text.trim();
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

/** The resource's real-world name when the plan shows one (an identity attribute or its Name tag), else null. */
function realName(change: ResourceChange): string | null {
  // What is destroyed is the existing object: name it by its current value.
  const destroying = change.action === "delete" || change.action === "replace" || change.action === "forget";
  const readable = (v: unknown): v is string =>
    typeof v === "string" && v.trim() !== "" && !v.includes(SENSITIVE_PLACEHOLDER) && v.length <= 80;
  const sides = destroying ? [change.before, change.after] : [change.after, change.before];
  for (const side of sides) {
    if (side === null || typeof side !== "object" || Array.isArray(side)) continue;
    const rec = side as Record<string, unknown>;
    for (const key of IDENTITY_KEYS) if (readable(rec[key])) return rec[key] as string;
  }
  for (const side of sides) {
    if (side === null || typeof side !== "object" || Array.isArray(side)) continue;
    const tags = (side as Record<string, unknown>).tags;
    if (tags && typeof tags === "object" && !Array.isArray(tags)) {
      const name = (tags as Record<string, unknown>).Name;
      if (readable(name)) return name;
    }
  }
  return null;
}

/** The resource's real-world name when the plan shows one, else its full address. */
export function identityName(change: ResourceChange): string {
  return realName(change) ?? change.address;
}

/** "RDS database orders-prod (aws_db_instance)", or "aws_foo bar" for types without a noun. */
export function describeResource(change: ResourceChange, withType = true): string {
  const noun = classify(change.type).noun;
  const name = realName(change);
  // Without a readable name the address says it all, type included.
  if (name === null) return noun === change.type ? change.address : `${capitalize(noun)} ${change.address}`;
  if (noun === change.type) return `${change.type} ${name}`;
  return withType ? `${capitalize(noun)} ${name} (${change.type})` : `${capitalize(noun)} ${name}`;
}

const VERB: Record<Action, string> = {
  create: "will be created",
  update: "will be updated in place",
  delete: "will be destroyed",
  replace: "will be destroyed and re-created",
  read: "will be read during apply",
  "no-op": "does not change",
  forget: "will be removed from Terraform state without being destroyed",
  import: "will be imported",
  move: "moves to a new address",
};

function verb(change: ResourceChange): string {
  if (change.action === "replace" && change.replaceOrder === "create-before-destroy")
    return "will be replaced (the new one is created first)";
  return VERB[change.action] ?? "changes";
}

/** Clause boundaries: the consequence that follows them belongs in "why it matters", not the title. */
const CLAUSE_END =
  /(?:[.;:]\s|,\s(?:so|which|because|and so|meaning)\s|\s(?:so that|which means)\s|\s[—–]\s)/;

/** First clause of a signal reason, for update titles. */
export function shortReason(reason: string): string {
  const m = CLAUSE_END.exec(reason);
  const first = m ? reason.slice(0, m.index) : reason;
  return first.replace(/[.;:,]+$/, "").trim();
}

/** ≤ 100 chars: what happens, e.g. "RDS database orders-prod (aws_db_instance) will be destroyed and re-created". */
export function deterministicTitle(scored: ScoredChange, related = 0, notExplained = false): string {
  const c = scored.change;
  const suffixes: string[] = [];
  if (related > 0) suffixes.push(` (and ${related} related change${related === 1 ? "" : "s"})`);
  if (notExplained) suffixes.push(" (not caused by this PR)");
  const suffix = suffixes.join("");
  const room = MAX_TITLE_CHARS - [...suffix].length;
  const top = [...scored.signals]
    .filter((s) => s.severity !== "noise")
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))[0];
  const update = (c.action === "update" || c.action === "import") && top !== undefined;
  const renamed = c.action === "delete" && scored.signals.some((s) => s.ruleId === "renamed-without-moved");
  const fullVerb = renamed
    ? "will be destroyed and re-created empty (renamed without a moved block)"
    : verb(c);
  const shortVerb = renamed
    ? "will be re-created empty (renamed without a moved block)"
    : c.action === "replace"
      ? "will be replaced"
      : verb(c);
  // Longest form that fits: with the resource type, without it, then with a shorter verb.
  // "ECS service x: … scales the ECS service to zero" → "… scales it to zero".
  const clause = update
    ? shortReason(top.reason).replace(new RegExp(`\\bthe ${escapeRe(classify(c.type).noun)}\\b`, "gi"), "it")
    : "";
  // A deposed leftover shares its address with the live object: its key tells them apart.
  const who = (withType: boolean): string =>
    `${describeResource(c, withType)}${c.deposed ? ` (deposed object ${c.deposed})` : ""}`;
  const forms = update
    ? [`${who(true)}: ${clause}`, `${who(false)}: ${clause}`]
    : [
        `${who(true)} ${fullVerb}`,
        `${who(false)} ${fullVerb}`,
        `${who(true)} ${shortVerb}`,
        `${who(false)} ${shortVerb}`,
      ];
  const fits = forms.find((f) => [...f].length <= room);
  return clip(fits ?? forms[forms.length - 1]!, Math.max(20, room)) + suffix;
}

/** Plan-wide signals: said once for the whole review (a banner), not on every finding. */
export const PLAN_WIDE_RULES: ReadonlySet<string> = new Set(["mass-destroy"]);
/** Signals the title and "why it happens" already state (with the specific source); not repeated in the impact. */
const STATED_ELSEWHERE: ReadonlySet<string> = new Set(["not-explained-by-diff"]);

/** Why it matters: the distinct reasons of the most severe signals, most severe first. */
export function deterministicImpact(scored: ScoredChange): string {
  const reasons: string[] = [];
  const ranked = [...scored.signals]
    .map((s, i) => ({ s, i }))
    .sort((a, b) => severityRank(a.s.severity) - severityRank(b.s.severity) || a.i - b.i)
    .map((x) => x.s);
  for (const s of ranked) {
    if (s.severity === "noise" || s.severity === "low") continue;
    if (PLAN_WIDE_RULES.has(s.ruleId) || STATED_ELSEWHERE.has(s.ruleId)) continue;
    const r = s.reason.trim();
    if (r && !reasons.includes(r)) reasons.push(r);
    if (reasons.length >= MAX_IMPACT_SIGNALS) break;
  }
  if (!reasons.length) {
    const top = ranked.find((s) => !PLAN_WIDE_RULES.has(s.ruleId))?.reason.trim();
    if (top) reasons.push(top);
  }
  return reasons.map(sentence).join(" ");
}

// ───────────────────────────── cause text ─────────────────────────────

function firstLine(text: string | undefined): string {
  return (text ?? "").split("\n")[0]?.trim() ?? "";
}

function stepWhere(step: LineageStep): string {
  if (!step.location) return "";
  if (step.location.side === "base") {
    const { file, startLine, endLine } = step.location;
    return ` (${locationLabel({ file, startLine, endLine })}, deleted by this PR)`;
  }
  const changed = step.changedInDiff ? ", changed in this PR" : "";
  return ` (${locationLabel(step.location)}${changed})`;
}

/** A removed_code label without its own "removed by this PR" wording (stepWhere says it). */
function removedLabel(label: string): string {
  return label.replace(/ \(file removed by this PR\)$/, "").replace(/ removed by this PR$/, "");
}

/**
 * Why Terraform deletes, by action_reason. `first`: said before the lineage's own "instance … no
 * longer exists" wording, because that wording would be wrong for it (the instance still exists).
 */
const DELETE_REASONS: Readonly<Record<string, { text: string; first: boolean }>> = {
  delete_because_no_resource_config: { text: "The resource is no longer in the configuration", first: false },
  delete_because_no_module: {
    text: "The module instance it belongs to no longer exists (the module's count or for_each shrank)",
    first: false,
  },
  delete_because_count_index: {
    text: "The configuration still has the resource, but its count index no longer exists",
    first: false,
  },
  delete_because_each_key: {
    text: "The configuration still has the resource, but its for_each key no longer exists",
    first: false,
  },
  delete_because_wrong_repetition: {
    text: "The resource switched between count and for_each without moved blocks, so it gets a new address",
    first: true,
  },
  delete_because_no_move_target: {
    text: "A moved block points at an address that no longer exists",
    first: true,
  },
  // OpenTofu's `enabled` meta-argument: the block stays, the object goes.
  delete_because_enabled_false: {
    text: "The configuration still has the resource, but its enabled argument is now false",
    first: true,
  },
};

/** Why-it-happens text for every delete in a destroy plan: no line of code causes it. */
const DESTROY_PLAN_CAUSE =
  "This is a destroy plan (terraform plan -destroy or terraform destroy): Terraform destroys every resource it manages, whatever the configuration says.";

/** What makes a whole-resource change (create, delete): the first traced step, in words. */
function blockClause(change: ResourceChange, lineage: Lineage): string {
  const first = lineage.steps[0];
  switch (change.action) {
    case "create":
      return "The resource is new";
    case "forget":
      return "A removed block tells Terraform to stop managing it";
    case "delete": {
      if (change.deposed)
        return "This is a leftover (deposed) object from an earlier create_before_destroy replacement that did not finish, so Terraform destroys it";
      if (first?.kind === "removed_code") {
        if (/^renames /.test(first.label)) {
          const loc = first.location;
          const next = lineage.steps.find((s) => s.parentId === first.id && s.location);
          const now = next?.location ? `, now ${locationLabel(next.location)}` : "";
          const at = loc
            ? ` (${locationLabel({ file: loc.file, startLine: loc.startLine, endLine: loc.endLine })} in the base version${now})`
            : "";
          return `This PR ${first.label}${at}`;
        }
        return `This PR deletes ${removedLabel(first.label)}${stepWhere(first)}`;
      }
      const reason = DELETE_REASONS[change.actionReason ?? ""];
      if (reason?.first) return reason.text;
      const gone = /\((instance [^)]*|module instance [^)]*) no longer exists\)/.exec(first?.label ?? "");
      if (gone) return `The configuration still has the resource, but ${gone[1]} no longer exists`;
      return reason?.text ?? "The resource is no longer in the configuration";
    }
    default:
      return "The resource changes";
  }
}

/** The value of an attribute for the text, policy documents as a statement-level difference. */
function valueChange(
  change: ResourceChange,
  attribute: AttrPath,
): { text: string; transition: boolean } | null {
  const before = getAtPath(change.before, attribute);
  const after = getAtPath(change.after, attribute);
  const unknown = isUnknownAt(change.afterUnknown, attribute);
  if (before === undefined && after === undefined && !unknown) return null;
  if (!unknown && typeof before === "string" && typeof after === "string") {
    const policy = policyDifference(before, after);
    if (policy) return { text: policy, transition: false };
  }
  return {
    text: `${fmtValue(before)} → ${unknown ? "(known after apply)" : fmtValue(after)}`,
    transition: true,
  };
}

/**
 * A whole nested block element (path ending in an index) that is new or gone: "is added
 * (cidr_blocks ["0.0.0.0/0"], from_port 22, …)" / "is removed (…)". align.ts leaves null on the
 * missing side of an element added to or removed from a set, which would otherwise read as
 * "changes from null to {…}".
 */
function blockElementChange(change: ResourceChange, attribute: AttrPath, named: string): string | null {
  if (typeof attribute[attribute.length - 1] !== "number") return null;
  if (isUnknownAt(change.afterUnknown, attribute)) return null;
  const before = getAtPath(change.before, attribute);
  const after = getAtPath(change.after, attribute);
  const isBlock = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v);
  if ((before === null || before === undefined) && isBlock(after))
    return `is added${blockFields(after, named)}`;
  if ((after === null || after === undefined) && isBlock(before))
    return `is removed${blockFields(before, named)}`;
  return null;
}

/**
 * ` (cidr_blocks ["0.0.0.0/0"], from_port 22, …)`: the first few set fields of a block, leaving out
 * a value the block's name already shows (`ingress "ssh debug"`).
 */
function blockFields(block: Record<string, unknown>, named: string): string {
  const set = Object.entries(block).filter(
    ([, v]) =>
      v !== null &&
      v !== undefined &&
      v !== "" &&
      !(Array.isArray(v) && v.length === 0) &&
      !(typeof v === "string" && named.includes(JSON.stringify(v))),
  );
  if (!set.length) return "";
  const shown = set.slice(0, 3).map(([k, v]) => `${k} ${fmtValue(v)}`);
  return ` (${shown.join(", ")}${set.length > 3 ? ", …" : ""})`;
}

/** The attribute clause: `storage_encrypted true → false forces replacement`, `desired_count changes from 6 to 0`. */
function attributeClause(change: ResourceChange, attribute: AttrPath): string {
  if (attribute[0] === "lifecycle" && attribute[1] === "replace_triggered_by")
    return "lifecycle.replace_triggered_by replaces it because a resource it watches changes";
  const named = describePath(change.action === "delete" ? change.before : change.after, attribute);
  const block = blockElementChange(change, attribute, named);
  if (block) {
    const text = `${named} ${block}`;
    if (change.action !== "replace") return text;
    const forces = change.replacePaths.some((p) => pathKey(p) === pathKey(attribute));
    return forces ? `${text}, which forces replacement` : `${text}, and the resource is replaced`;
  }
  const value = valueChange(change, attribute);
  if (change.action === "replace") {
    const forces = change.replacePaths.some((p) => pathKey(p) === pathKey(attribute));
    const values = value ? (value.transition ? ` ${value.text}` : ` (${value.text})`) : "";
    return forces
      ? `${named}${values} forces replacement`
      : `${named}${values} changes, and the resource is replaced`;
  }
  if (!value) return `${named} changes`;
  if (!value.transition) return `${named} changes (${value.text})`;
  const [b, a] = value.text.split(" → ");
  return `${named} changes from ${b} to ${a === "(known after apply)" ? "a value known only after apply" : a}`;
}

/**
 * A policy document (JSON with a Statement list) on both sides: what changes per statement, e.g.
 * `statement "ReportsBucket": Action [s3:GetObject, s3:PutObject] → s3:*; Resource [...] → *`.
 */
export function policyDifference(before: string, after: string): string | null {
  const b = parsePolicy(before);
  const a = parsePolicy(after);
  if (!b || !a) return null;
  const parts: string[] = [];
  const used = new Set<number>();
  a.forEach((st, i) => {
    const sid = typeof st.Sid === "string" && st.Sid !== "" ? st.Sid : null;
    let j = sid === null ? -1 : b.findIndex((x, k) => !used.has(k) && x.Sid === sid);
    if (j < 0 && i < b.length && !used.has(i)) j = i;
    const name = sid !== null ? `statement "${sid}"` : `statement ${i + 1}`;
    if (j < 0) {
      parts.push(`${name} added (${policyFields(st)})`);
      return;
    }
    used.add(j);
    const diffs: string[] = [];
    for (const key of POLICY_KEYS) {
      const x = normalizePolicyValue(b[j]![key]);
      const y = normalizePolicyValue(st[key]);
      if (x !== y) diffs.push(`${key} ${x ?? "(none)"} → ${y ?? "(none)"}`);
    }
    if (diffs.length) parts.push(`${name} ${diffs.join(", ")}`);
  });
  b.forEach((st, k) => {
    if (!used.has(k))
      parts.push(
        `${typeof st.Sid === "string" && st.Sid ? `statement "${st.Sid}"` : `statement ${k + 1}`} removed`,
      );
  });
  if (!parts.length) return null;
  return clip(parts.join("; "), 400);
}

const POLICY_KEYS = [
  "Effect",
  "Action",
  "NotAction",
  "Resource",
  "NotResource",
  "Principal",
  "NotPrincipal",
  "Condition",
];

function parsePolicy(text: string): Record<string, unknown>[] | null {
  if (!/^\s*\{/.test(text) || !text.includes("Statement")) return null;
  try {
    const doc = JSON.parse(text) as unknown;
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null;
    const st = (doc as Record<string, unknown>).Statement;
    const list = Array.isArray(st) ? st : st && typeof st === "object" ? [st] : null;
    if (!list || !list.every((x) => x !== null && typeof x === "object" && !Array.isArray(x))) return null;
    return list as Record<string, unknown>[];
  } catch {
    return null;
  }
}

function normalizePolicyValue(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    const items = v.map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
    return items.length === 1 ? items[0]! : `[${items.join(", ")}]`;
  }
  return JSON.stringify(v);
}

function policyFields(st: Record<string, unknown>): string {
  return POLICY_KEYS.filter((k) => st[k] !== undefined)
    .slice(0, 3)
    .map((k) => `${k} ${normalizePolicyValue(st[k])}`)
    .join("; ");
}

/** Unchanged inputs that only add noise to the narrative (a declaration without a default, an overridden value). */
function quietStep(s: LineageStep, roots: ReadonlySet<string>): boolean {
  if (roots.has(s.id)) return false;
  if (s.kind === "variable_default" && s.label.includes("(no default)")) return true;
  if ((s.kind === "variable_default" || s.kind === "variable_value") && !s.changedInDiff) return true;
  return !CHAIN_KINDS.has(s.kind) && s.kind !== "resource_attribute";
}

const CHAIN_KINDS = new Set<LineageStep["kind"]>([
  "module_input",
  "module_output",
  "local",
  "variable_default",
  "variable_value",
  "count_for_each",
  "upstream_resource",
  "file_content",
  "removed_code",
  "module_source",
  "provider_config",
]);

function describeStep(step: LineageStep): string {
  switch (step.kind) {
    case "variable_default":
      return `${step.label.replace(/ default\b/, "'s default")}${stepWhere(step)}`;
    case "file_content":
      return `the ${step.label}${stepWhere(step)}`;
    case "removed_code":
      return `${removedLabel(step.label)}${stepWhere(step)}`;
    default:
      return `${step.label}${stepWhere(step)}`;
  }
}

/**
 * "it comes from A (loc), from B (loc, changed in this PR)" for the cause paths below one traced
 * attribute: their shared steps once, then each branch's own steps joined with "and".
 */
function chainText(paths: readonly LineageStep[][], roots: ReadonlySet<string>): string {
  const shown = paths.map((p) => collapsePath(p).filter((s) => !quietStep(s, roots)));
  if (!shown.some((p) => p.length)) return "";
  let common = 0;
  while (shown.every((p) => p.length > common && p[common]!.id === shown[0]![common]!.id)) common++;
  const shared = shown[0]!.slice(0, common).map(describeStep);
  const branches = shown
    .map((p) => p.slice(common).map(describeStep).join(", from "))
    .filter((t) => t !== "");
  const unique = [...new Set(branches)];
  const parts = [...shared];
  if (unique.length) parts.push(unique.join(" and "));
  return parts.join(", from ");
}

export interface ExternalSource {
  /** Short category, e.g. "drift". */
  kind:
    | "drift"
    | "tainted"
    | "replace-request"
    | "triggers"
    | "injected-variable"
    | "removed-earlier"
    | "data-source"
    | "remote-module"
    | "version-bump"
    | "deposed"
    | "destroy-plan"
    | "unknown";
  /** Plain sentence naming the likely source. */
  text: string;
}

/** Where a change no line of the PR explains most likely comes from. */
export function externalSource(
  change: ResourceChange,
  lineage: Lineage | null,
  plan: PlanModel,
): ExternalSource {
  const notes = lineage?.notes ?? [];
  const steps = lineage?.steps ?? [];
  if (change.deposed)
    return {
      kind: "deposed",
      text: "an earlier create_before_destroy replacement did not finish and left this old object behind",
    };
  if (change.action === "delete" && isDestroyPlan(plan))
    return {
      kind: "destroy-plan",
      text: "the plan was made in destroy mode (terraform plan -destroy), which destroys every resource",
    };
  if (change.actionReason === "replace_because_tainted")
    return {
      kind: "tainted",
      text: "the object is tainted (a previous apply failed, or someone ran `terraform taint`), so Terraform replaces it whatever the code says",
    };
  if (change.actionReason === "replace_by_request")
    return {
      kind: "replace-request",
      text: "a `-replace` option on the command line requested the replacement",
    };
  if (change.actionReason === "replace_by_triggers") {
    const up = steps.find((s) => s.kind === "upstream_resource" && s.upstreamAddress);
    return {
      kind: "triggers",
      text: up?.upstreamAddress
        ? `lifecycle.replace_triggered_by: ${up.upstreamAddress} changes in this plan`
        : "lifecycle.replace_triggered_by: a resource it watches changes in this plan",
    };
  }
  if (plan.drift.some((d) => d.address === change.address))
    return {
      kind: "drift",
      text: "drift: someone changed the object outside Terraform, and this plan reverts that change",
    };
  for (const n of notes) {
    const m = /value of var\.([\p{L}\p{N}_-]+) matches no default or \.tfvars value/u.exec(n);
    if (m)
      return {
        kind: "injected-variable",
        text: `an injected variable value: var.${m[1]} is set outside the repository (-var, -var-file, TF_VAR_${m[1]} or a CI variable)`,
      };
  }
  if (notes.some((n) => /does not remove it: it was removed before this PR/.test(n)))
    return {
      kind: "removed-earlier",
      text: "the code was removed before this PR (or in files outside its diff), so an earlier change is being applied now",
    };
  const roots = new Set(lineage?.rootCauseIds ?? []);
  const versionRoot = steps.find(
    (s) => roots.has(s.id) && (s.kind === "module_source" || s.kind === "provider_config"),
  );
  if (versionRoot)
    return { kind: "version-bump", text: `a version change in this PR (${versionRoot.label})` };
  const data = steps.find((s) => s.kind === "upstream_resource" && s.label.startsWith("data."));
  if (data)
    return {
      kind: "data-source",
      text: `a data source read at plan time (${data.label}) returned a different value`,
    };
  const remote = steps.find((s) => s.kind === "unresolved" && /outside the repository/.test(s.label));
  if (remote) return { kind: "remote-module", text: remote.label };
  return {
    kind: "unknown",
    text: "a value set outside this PR: drift, a provider or module upgrade, or a variable injected by CI",
  };
}

/** True when the PR's own changes are only module/provider version lines (PLAN-12). */
export function causedByVersionBump(lineage: Lineage | null): boolean {
  if (!lineage || lineage.explanation !== "diff" || !lineage.rootCauseIds.length) return false;
  const roots = new Set(lineage.rootCauseIds);
  return lineage.steps
    .filter((s) => roots.has(s.id))
    .every((s) => s.kind === "module_source" || s.kind === "provider_config");
}

/** Whether a finding is "not explained by this PR": the lineage found no changed line that causes it. */
export function notExplained(lineage: Lineage | null): boolean {
  return lineage !== null && (lineage.explanation === "external" || lineage.explanation === "unknown");
}

/** True when the lineage could not use a PR diff (none was available). */
export function noDiff(lineage: Lineage | null): boolean {
  return (lineage?.notes ?? []).some((n) => /^No PR diff was available/.test(n));
}

/**
 * Why it happens, as a narrative of the lineage branches that explain the change, one clause per
 * traced attribute: `storage_encrypted true → false forces replacement; it comes from module
 * "orders_db" argument encrypted (main.tf:12, changed in this PR), from variable
 * "orders_db_encrypted"'s default (main.tf:18, changed in this PR).`
 */
export function deterministicCause(change: ResourceChange, lineage: Lineage | null, plan: PlanModel): string {
  if (change.action === "delete" && !change.deposed && isDestroyPlan(plan)) return DESTROY_PLAN_CAUSE;
  if (!lineage) return "The cause was not traced (the tracing limit was reached).";
  const roots = new Set(lineage.rootCauseIds);
  const paths = causePaths(lineage, MAX_CAUSE_PATHS);
  const clauses: string[] = [];
  if (lineage.attribute.length === 0) {
    // A rename's clause already names both lines.
    const rename = lineage.steps[0]?.kind === "removed_code" && /^renames /.test(lineage.steps[0].label);
    const chain = rename
      ? ""
      : chainText(
          paths.map((p) => p.filter((s) => s.id !== lineage.steps[0]?.id)),
          roots,
        );
    clauses.push(`${blockClause(change, lineage)}${chain ? `; it comes from ${chain}` : ""}`);
  } else {
    // One clause per traced attribute that a branch explains (all of them when none does).
    const tops = topSteps(lineage).filter(
      (t) => t.kind === "resource_attribute" || t.kind === "provider_config",
    );
    const explained = tops.filter((t) => paths.some((p) => p[0]?.id === t.id));
    const picked = explained.length ? explained : tops.slice(0, 1);
    for (const top of picked.slice(0, MAX_CAUSE_CLAUSES)) {
      const attribute = top.path ?? (top === tops[0] ? lineage.attribute : null);
      const head =
        top.kind === "provider_config"
          ? `tags_all changes with ${top.label}${stepWhere(top)}`
          : attributeClause(change, attribute ?? lineage.attribute);
      const below = paths.filter((p) => p[0]?.id === top.id).map((p) => p.slice(1));
      const chain = chainText(below, roots);
      clauses.push(`${head}${chain ? `; it comes from ${chain}` : ""}`);
    }
    if (!clauses.length) clauses.push(attributeClause(change, lineage.attribute));
  }
  let tail = "";
  switch (lineage.explanation) {
    case "diff":
      if (causedByVersionBump(lineage))
        tail =
          " The PR changes no configuration on this path: a module or provider version change is the cause, so read its upgrade notes.";
      break;
    case "upstream": {
      const up = lineage.steps.find((s) => s.kind === "upstream_resource" && s.upstreamAddress);
      const mentioned = up !== undefined && paths.some((p) => p.includes(up));
      tail = up?.upstreamAddress && !mentioned ? ` It follows from the change to ${up.upstreamAddress}.` : "";
      break;
    }
    case "external": {
      const src = externalSource(change, lineage, plan);
      tail = ` Not caused by this PR: ${src.text}.`;
      break;
    }
    case "unknown": {
      // Without a diff the banner says so once; repeating it on every finding adds nothing.
      if (noDiff(lineage)) break;
      const src = externalSource(change, lineage, plan);
      tail = ` No changed line of this PR was found on its cause chain. Likely source: ${src.text}.`;
      break;
    }
  }
  // A delete next to a create of the same type is often a rename that needs a moved block.
  const rename = change.action === "delete" ? lineage.notes.find((n) => /moved block/.test(n)) : undefined;
  return `${clauses.map((c) => c.trim()).join("; ")}.${tail}${rename ? ` ${rename}` : ""}`.replace(
    /\.\./g,
    ".",
  );
}

/** Cause paths and attribute clauses named in the text. */
const MAX_CAUSE_PATHS = 6;
const MAX_CAUSE_CLAUSES = 3;

/** Cause links: the resource's own step(s), then the root causes (base side for deleted code). */
export function lineageCauseLinks(lineage: Lineage | null): CauseLink[] {
  if (!lineage) return [];
  const roots = new Set(lineage.rootCauseIds);
  const picked: LineageStep[] = [];
  const paths = causePaths(lineage, MAX_CAUSE_PATHS);
  const first = lineage.steps[0];
  for (const p of paths) if (p[0]?.location) picked.push(p[0]);
  if (!picked.length && first?.location) picked.push(first);
  // Root causes, without a block whose changed line is also a root cause.
  const rootSteps = lineage.steps.filter((s) => roots.has(s.id) && s.location);
  for (const s of rootSteps) {
    if (rootSteps.some((o) => o !== s && encloses(s.location, o.location))) continue;
    if (!picked.includes(s)) picked.push(s);
  }
  const seen = new Set<string>();
  const out: CauseLink[] = [];
  for (const s of picked) {
    const loc = s.location as SourceLocation;
    const key = `${loc.side ?? "head"}|${loc.file}|${loc.startLine}|${loc.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const snippet = clip(firstLine(s.snippet), MAX_LABEL_SNIPPET);
    out.push({
      location: { ...loc },
      label: snippet ? `${locationLabel(loc)} ${snippet}` : `${locationLabel(loc)} ${s.label}`,
      changedInDiff: s.changedInDiff,
    });
  }
  return out;
}

/** Deterministic confidence: high when a changed line (or an upstream change) explains it. */
export function deterministicConfidence(lineage: Lineage | null): Confidence {
  if (!lineage) return "medium";
  return lineage.explanation === "diff" || lineage.explanation === "upstream" ? "high" : "medium";
}

// ───────────────────────────── grouping ─────────────────────────────

function actionClass(action: Action): string {
  if (action === "delete" || action === "replace") return "destroy";
  if (action === "update" || action === "import") return "update";
  return action;
}

/**
 * Root-cause key of a finding: where its explaining branches end (the deepest root causes; a
 * resource's own block or attribute only when nothing upstream of it changed), or the upstream
 * addresses when another resource's change explains it; without either, the lines the AI review
 * cited for it. Null when nothing groups it.
 */
function rootKey(f: Finding): string | null {
  const traced = f.lineage ? lineageRootKey(f.lineage) : null;
  if (traced !== null || !f.agentCauseLinks?.length) return traced;
  // No traced root: the lines the AI review itself cited.
  const cited = f.agentCauseLinks.map(
    ({ location: loc }) => `${loc.side ?? "head"}|${loc.file}|${loc.startLine}|${loc.endLine}`,
  );
  return `agent:${[...new Set(cited)].sort().join(",")}`;
}

function lineageRootKey(l: Lineage): string | null {
  const locKey = (s: LineageStep): string => {
    const loc = s.location as SourceLocation;
    return `${loc.side ?? "head"}|${loc.file}|${loc.startLine}|${loc.endLine}`;
  };
  if (l.rootCauseIds.length) {
    const ends = causePaths(l, Number.POSITIVE_INFINITY)
      .map((p) => p[p.length - 1]!)
      .filter((s) => l.rootCauseIds.includes(s.id) && s.location);
    // A removed module call explains every resource in it; their own removed blocks differ.
    const shared = ends.filter((s) => s.parentId !== undefined);
    const upstream = l.steps.filter(
      (s) => l.rootCauseIds.includes(s.id) && s.location && s.parentId !== undefined,
    );
    const use = shared.length ? shared : upstream.length ? upstream : ends;
    if (use.length) return `loc:${[...new Set(use.map(locKey))].sort().join(",")}`;
  }
  if (l.explanation === "upstream") {
    const ups = l.steps
      .filter((s) => s.kind === "upstream_resource" && s.upstreamAddress)
      .map((s) => s.upstreamAddress);
    if (ups.length) return `up:${[...new Set(ups)].sort().join(",")}`;
  }
  return null;
}

function topRule(f: Finding): string {
  const real = f.signals.filter((s) => s.severity !== "noise" && !PLAN_WIDE_RULES.has(s.ruleId));
  return [...real].sort((a, b) => severityRank(a.severity) - severityRank(b.severity))[0]?.ruleId ?? "";
}

/**
 * Whether `f` can be listed under `rep` (same root cause): a cascade of the same change (a
 * listener replaced because its load balancer is, a DNS alias that follows it, every resource of a
 * removed module) folds; a second, different critical exposure on an in-place change stays its
 * own finding. A finding the AI review wrote or confirmed folds only into one of the same resource
 * type and kind of action (one variable fanning out to many instances), whatever its severity: the
 * representative is the most severe, and each member keeps its own severity in relatedChanges.
 */
function canFold(rep: Finding, f: Finding): boolean {
  if (rep.origin !== "rules" || f.origin !== "rules") {
    return actionClass(f.action) === actionClass(rep.action) && typeOf(f) === typeOf(rep);
  }
  if (f.severity === "critical" && actionClass(f.action) !== "destroy" && topRule(f) !== topRule(rep))
    return false;
  return true;
}

/**
 * Findings that share their root causes become one finding: the first (highest ranked) stands for
 * the rest, which it lists in `relatedAddresses` / `relatedChanges` with their own action and
 * severity. `findings` must be ranked; the result keeps that order.
 */
export function groupByRootCause(findings: readonly Finding[]): Finding[] {
  const groups = new Map<string, Finding>();
  const out: Finding[] = [];
  for (const f of findings) {
    const root = rootKey(f);
    const rep = root === null ? undefined : groups.get(root);
    if (rep && canFold(rep, f)) {
      const own: RelatedChange = { address: f.address, action: f.action, severity: f.severity };
      rep.relatedAddresses = [...(rep.relatedAddresses ?? []), f.address, ...(f.relatedAddresses ?? [])];
      rep.relatedChanges = [...(rep.relatedChanges ?? []), own, ...(f.relatedChanges ?? [])];
      continue;
    }
    const copy: Finding = { ...f };
    if (root !== null && !rep) groups.set(root, copy);
    out.push(copy);
  }
  return out;
}

/** Resource type of an address (`module.a.aws_s3_bucket.b["k"]` → aws_s3_bucket). */
export function typeOfAddress(address: string): string {
  // parseAddress splits around quoted instance keys, which may contain "]" or ".".
  const { mode, type } = parseAddress(address);
  return mode === "data" ? `data:${type}` : type;
}

function typeOf(f: Finding): string {
  return typeOfAddress(f.address);
}

/** Severity comparison helper for sorting (most severe first). */
export function bySeverity(a: Severity, b: Severity): number {
  return severityRank(a) - severityRank(b);
}
