/*
 * Literal references to destroyed objects. Configuration often refers to a shared object by a
 * literal value (a KMS alias name in a .tfvars file, an ARN pasted into a policy) rather than by a
 * Terraform reference, so removing the object changes nothing else in the plan: the resources that
 * use it are unchanged, and break on apply. This searches the values of every resource the plan
 * keeps for the identifiers (ARN, ID, key ID, alias or path-like name) of each deleted object.
 */
import { classify } from "./risk/rules.js";
import { SENSITIVE_PLACEHOLDER } from "./types.js";
import type { PlanModel, ResourceChange, RiskSignal } from "./types.js";

/** Identifier attributes searched for; `name` only when it is path- or alias-like (alias/x, /a/b, arn…). */
const ID_KEYS = ["arn", "id", "key_id"];
const MIN_ID_CHARS = 8;
const MAX_SCAN_DEPTH = 24;
const MAX_ARN_NEEDLES = 200;
const SKIP_KEYS = new Set(["tags", "tags_all"]);

interface Hit {
  /** The resource that still uses the value. */
  address: string;
  type: string;
  /** The value it uses. */
  value: string;
}

/** Signals for deleted resources that resources this plan keeps still use by a literal value. */
export function stillReferencedSignals(plan: PlanModel): Map<ResourceChange, RiskSignal[]> {
  const out = new Map<ResourceChange, RiskSignal[]>();
  const deleted = plan.changes.filter((c) => c.action === "delete" && c.mode === "managed" && !c.deposed);
  if (!deleted.length) return out;

  // Identifier value → deleted object. A value that another object of the same type also carries
  // is not an identifier (a placeholder, a shared default), so it is not searched for.
  const owners = new Map<string, Set<string>>();
  for (const c of plan.changes) {
    for (const side of [c.before, c.after]) {
      for (const v of identifiers(side)) {
        const key = `${c.type}\u0000${v}`;
        owners.set(key, (owners.get(key) ?? new Set()).add(c.address));
      }
    }
  }
  const needles = new Map<string, ResourceChange>();
  for (const d of deleted) {
    for (const v of identifiers(d.before)) {
      if (owners.get(`${d.type}\u0000${v}`)?.size === 1 && !needles.has(v)) needles.set(v, d);
    }
  }
  if (!needles.size) return out;
  const arns = [...needles.keys()].filter((v) => v.startsWith("arn:")).slice(0, MAX_ARN_NEEDLES);

  const hits = new Map<ResourceChange, Hit[]>();
  const deletedSet = new Set(deleted);
  /** Deleted objects that use another deleted one (an alias pointing at a key): its users count too. */
  const via = new Map<ResourceChange, ResourceChange[]>();
  for (const c of plan.changes) {
    const value = deletedSet.has(c) ? c.before : c.after;
    const found = new Map<ResourceChange, string>();
    scan(value, 0, (s) => {
      const exact = needles.get(s);
      if (exact && exact !== c) {
        if (!found.has(exact)) found.set(exact, s);
        return;
      }
      if (s.length > 20 && s.includes("arn:")) {
        for (const a of arns) {
          const owner = needles.get(a)!;
          if (owner !== c && !found.has(owner) && s.includes(a)) found.set(owner, a);
        }
      }
    });
    for (const [owner, v] of found) {
      if (deletedSet.has(c)) {
        via.set(owner, [...(via.get(owner) ?? []), c]);
        continue;
      }
      const list = hits.get(owner) ?? [];
      list.push({ address: c.address, type: c.type, value: v });
      hits.set(owner, list);
    }
  }

  for (const d of deleted) {
    const direct = hits.get(d) ?? [];
    const through = (via.get(d) ?? []).flatMap((u) => (hits.get(u) ?? []).map((h) => ({ h, u })));
    if (!direct.length && !through.length) continue;
    const noun = classify(d.type).noun;
    const reasons: string[] = [];
    if (direct.length) {
      reasons.push(
        `${count(direct)} this plan keeps still use${direct.length === 1 ? "s" : ""} its ${quoted(direct[0]!.value)} as a literal value (${types(direct)}), so ${direct.length === 1 ? "it fails" : "they fail"} once the ${noun} is gone`,
      );
    }
    if (through.length) {
      const users = through.map((t) => t.h);
      const u = through[0]!.u;
      reasons.push(
        `${u.address}, which points at it, is destroyed too, and ${count(users)} this plan keeps still use ${quoted(through[0]!.h.value)} (${types(users)})`,
      );
    }
    out.set(d, [
      {
        ruleId: "still-referenced",
        severity: "high",
        reason: `${capitalize(reasons.join("; "))}.`,
      },
    ]);
  }
  return out;
}

/** The identifiers an object's values carry. */
function identifiers(b: unknown): string[] {
  if (b === null || typeof b !== "object" || Array.isArray(b)) return [];
  const rec = b as Record<string, unknown>;
  const out: string[] = [];
  const ok = (v: unknown): v is string =>
    typeof v === "string" &&
    v.length >= MIN_ID_CHARS &&
    !v.includes(SENSITIVE_PLACEHOLDER) &&
    !/^\d+$/.test(v);
  for (const k of ID_KEYS) if (ok(rec[k])) out.push(rec[k]);
  if (ok(rec.name) && /^(?:alias\/|\/)|:/.test(rec.name)) out.push(rec.name);
  return [...new Set(out)];
}

function scan(value: unknown, depth: number, visit: (s: string) => void): void {
  if (depth > MAX_SCAN_DEPTH) return;
  if (typeof value === "string") {
    if (value.length >= MIN_ID_CHARS) visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) scan(v, depth + 1, visit);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) if (!SKIP_KEYS.has(k)) scan(v, depth + 1, visit);
  }
}

function count(hits: readonly Hit[]): string {
  const n = new Set(hits.map((h) => h.address)).size;
  return n === 1 ? `1 resource` : `${n} resources`;
}

/** "aws_sqs_queue ×10, aws_ssm_parameter ×12, e.g. aws_sqs_queue.jobs". */
function types(hits: readonly Hit[]): string {
  const byType = new Map<string, Set<string>>();
  for (const h of hits) byType.set(h.type, (byType.get(h.type) ?? new Set()).add(h.address));
  const parts = [...byType.entries()]
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([t, s]) => `${t} ×${s.size}`);
  if (byType.size > 4) parts.push(`${byType.size - 4} more types`);
  return `${parts.join(", ")}, e.g. ${hits[0]!.address}`;
}

function quoted(v: string): string {
  return `"${v.length > 80 ? `${v.slice(0, 77)}...` : v}"`;
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}
