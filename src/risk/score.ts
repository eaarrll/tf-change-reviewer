/*
 * Deterministic risk scoring: every non-no-op change gets signals (rule hits with one-sentence
 * reasons), a severity (its worst signal) and a sortable score. Rule data lives in rules.ts and
 * policy.ts; this module applies them per action and adds the plan-level rules that need the whole
 * plan (taxonomy ids in comments):
 *
 * - PLAN-01 action × tier base severity, create_before_destroy softening outage-only severity;
 * - PLAN-02 replace_paths named with a plain-words explanation; PLAN-08 tainted / -replace / triggers;
 * - PLAN-04/05/06 delete reasons: block or module removed, module count shrank, count/for_each re-index,
 *   plus "renamed without a moved block" (a delete next to a create of the same object);
 * - PLAN-07 forget, PLAN-09 moved / import, PLAN-10 drift revert, PLAN-11 mass destroy,
 *   PLAN-14 unknowns inherited from a replacement; AWS-U01/U02 escalation when the plan also destroys;
 * - PLAN-03 via escalateForLineage, once lineage says no line of the PR explains a replace/delete.
 */
import { formatPath, getAtPath, isPrefix } from "../plan/paths.js";
import type {
  AttrPath,
  Expression,
  Lineage,
  PlanModel,
  ResourceChange,
  RiskSignal,
  ScoredChange,
  Severity,
} from "../types.js";
import { POLICY_ATTRIBUTES, POLICY_ATTRIBUTE_NAMES, abacTagKeys, parsePolicyDocument } from "./policy.js";
import {
  SEVERITY_WEIGHT,
  asRecord,
  classify,
  classifyNoise,
  destroyLoss,
  destroySeverity,
  evaluateRules,
  explainForceNew,
  fmtValue,
  forceNewExplanation,
  isForceNewAttribute,
  isTagPath,
  isUnknownAt,
  lowerSeverity,
  maxSeverity,
  noiseSignals,
  raiseSeverity,
  severityRank,
  taskDefinitionDiff,
  touchedPaths,
  transition,
} from "./rules.js";
import type { Rec, RuleAction, RuleContext } from "./rules.js";

/** PLAN-11: this many deletes/replacements (forget excluded) make a mass destroy. Tunable, not sourced. */
export const MASS_DESTROY_THRESHOLD = 5;
/** PLAN-06: this many touched instances of one count/for_each resource make a re-index high. */
export const REINDEX_HIGH_THRESHOLD = 3;
const MAX_REFERENCE_DEPTH = 8;

// ───────────────────────────── context ─────────────────────────────

/** Plan-wide indexes, built once per plan and shared by every scoreChange call. */
export interface ScoreContext extends RuleContext {
  plan: PlanModel;
  /** Non-deposed change per address. */
  byAddress: Map<string, ResourceChange>;
  driftByAddress: Map<string, ResourceChange>;
  /** Deletes and replacements (forget excluded). */
  destroyed: ResourceChange[];
  /** module instance + type.name → every instance change (no-ops included). */
  groups: Map<string, ResourceChange[]>;
  /** Missing module call (config path) → the deletes under it. */
  removedModules: Map<string, ResourceChange[]>;
  /** Scored changes by key, so upstream severities are computed once (PLAN-14). */
  memo: Map<string, ScoredChange>;
  /** Plan-wide lookups that keep scoring linear in the number of changes. */
  index: PlanIndex;
}

/** Hash lookups over the plan, built once per ScoreContext (rename, re-index, upstream, mass destroy). */
interface PlanIndex {
  /** Position of each change in plan.changes, so a lookup returns what a scan in plan order would. */
  order: Map<ResourceChange, number>;
  /** Creates by `type|key|value` of each identity their planned object has. */
  createsByIdentity: Map<string, ResourceChange[]>;
  /** Deletes (deposed leftovers excluded) by `type|key|value` of each identity their current object has. */
  deletesByIdentity: Map<string, ResourceChange[]>;
  /** Creates / deletes whose object has no identity attribute, by type (the loose 90% match). */
  createsWithoutIdentity: Map<string, ResourceChange[]>;
  deletesWithoutIdentity: Map<string, ResourceChange[]>;
  /** The same creates / deletes by tokenKey of each scalar attribute value. */
  createsByValue: Map<string, ResourceChange[]>;
  deletesByValue: Map<string, ResourceChange[]>;
  /** Per count/for_each group: re-index lookups, built on first use. */
  groupIndexes: Map<string, GroupIndex>;
  /** `action|module path|type|name` → replacements / creates (findReplacedUpstream). */
  byConfigAction: Map<string, ResourceChange[]>;
  /** Per member of a removed module call: its key in removedModules; per key: whether a member holds data. */
  removedModuleOf: Map<ResourceChange, string>;
  removedModuleHoldsData: Map<string, boolean>;
  /** `from\0to` module instance pairs → whether a module-level moved block keeps everything (lazy). */
  moduleMoves: Map<string, boolean>;
  /** Live objects destroyed (deposed leftovers excluded), split by kind; and the deposed leftovers. */
  replaced: number;
  deleted: number;
  deposed: number;
}

interface GroupIndex {
  /** Instances deleted, replaced or created (deposed leftovers are not instances of the list). */
  touched: number;
  /** Members by `key|value` of their planned / current object's identities. */
  byAfterIdentity: Map<string, ResourceChange[]>;
  byBeforeIdentity: Map<string, ResourceChange[]>;
}

const groupKeys = new WeakMap<ResourceChange, string>();
const groupKey = (c: ResourceChange): string => {
  let key = groupKeys.get(c);
  if (key === undefined) {
    key = `${c.moduleAddress ?? ""}|${c.mode}|${c.type}.${c.name}`;
    groupKeys.set(c, key);
  }
  return key;
};
const configKey = (c: ResourceChange): string =>
  `${c.configModulePath.join(".")}|${c.mode}|${c.type}.${c.name}`;
const memoKey = (c: ResourceChange): string => `${c.address}|${c.deposed ?? ""}`;
const isDestroy = (c: ResourceChange): boolean => c.action === "delete" || c.action === "replace";

function accountsIn(v: unknown, out: Set<string>): void {
  const o = asRecord(v);
  for (const [k, val] of Object.entries(o)) {
    if (typeof val !== "string") continue;
    if (k === "arn" || k.endsWith("_arn")) {
      const m = /^arn:[^:]+:[^:]+:[^:]*:(\d{12}):/.exec(val);
      if (m?.[1]) out.add(m[1]);
    } else if ((k === "account_id" || k === "owner_id") && /^\d{12}$/.test(val)) out.add(val);
  }
}

function functionalTagKeysIn(c: ResourceChange, out: Set<string>): void {
  for (const side of [c.before, c.after]) {
    const o = asRecord(side);
    const specs = POLICY_ATTRIBUTES[c.type] ?? [];
    const values = specs.length
      ? specs.map((s) =>
          getAtPath(
            o,
            s.path.filter((p) => p !== "*"),
          ),
        )
      : Object.entries(o)
          .filter(([k]) => POLICY_ATTRIBUTE_NAMES.has(k))
          .map(([, v]) => v);
    for (const v of values) for (const k of abacTagKeys(parsePolicyDocument(v))) out.add(k.toLowerCase());
    if (c.type === "aws_backup_selection") {
      for (const t of Array.isArray(o.selection_tag) ? o.selection_tag : []) {
        const key = asRecord(t).key;
        if (typeof key === "string") out.add(key.toLowerCase());
      }
      for (const cond of Array.isArray(o.condition) ? o.condition : []) {
        for (const op of Object.values(asRecord(cond))) {
          for (const entry of Array.isArray(op) ? op : []) {
            const key = asRecord(entry).key;
            if (typeof key === "string") out.add(key.replace(/^aws:ResourceTag\//i, "").toLowerCase());
          }
        }
      }
    }
  }
}

/** The shortest module path prefix of `path` that the configuration no longer declares, or null. */
function missingModulePrefix(plan: PlanModel, path: string[]): string[] | null {
  for (let n = 1; n <= path.length; n++) {
    const prefix = path.slice(0, n);
    if (!(prefix.join(".") in plan.modules)) return prefix;
  }
  return null;
}

export function buildScoreContext(plan: PlanModel): ScoreContext {
  const byAddress = new Map<string, ResourceChange>();
  const groups = new Map<string, ResourceChange[]>();
  const destroyed: ResourceChange[] = [];
  const destroyedConfigs = new Set<string>();
  const destroyedBuckets = new Set<string>();
  const createdBuckets = new Set<string>();
  const knownAccounts = new Set<string>();
  const functionalTagKeys = new Set<string>();
  const ruleManagedGroups = new Set<string>();
  const removedModules = new Map<string, ResourceChange[]>();

  for (const c of plan.changes) {
    if (!c.deposed || !byAddress.has(c.address)) byAddress.set(c.address, c);
    const g = groups.get(groupKey(c)) ?? [];
    g.push(c);
    groups.set(groupKey(c), g);
    accountsIn(c.before, knownAccounts);
    accountsIn(c.after, knownAccounts);
    functionalTagKeysIn(c, functionalTagKeys);
    if (/^aws_(vpc_)?security_group_(ingress_|egress_)?rule$/.test(c.type)) {
      for (const side of [c.before, c.after]) {
        const id = asRecord(side).security_group_id;
        if (typeof id === "string") ruleManagedGroups.add(id);
      }
    }
    if (c.type === "aws_s3_bucket") {
      const b = asRecord(c.before).bucket;
      const a = asRecord(c.after).bucket;
      if (isDestroy(c) && typeof b === "string") destroyedBuckets.add(b);
      if ((c.action === "create" || c.action === "replace") && typeof a === "string") createdBuckets.add(a);
    }
    if (isDestroy(c)) {
      destroyed.push(c);
      destroyedConfigs.add(configKey(c));
    }
    if (
      c.action === "delete" &&
      c.actionReason === "delete_because_no_resource_config" &&
      c.configModulePath.length
    ) {
      const missing = missingModulePrefix(plan, c.configModulePath);
      if (missing) {
        const key = missing.join(".");
        const list = removedModules.get(key) ?? [];
        list.push(c);
        removedModules.set(key, list);
      }
    }
  }
  const driftByAddress = new Map<string, ResourceChange>();
  for (const d of plan.drift) if (!d.deposed) driftByAddress.set(d.address, d);

  return {
    plan,
    byAddress,
    driftByAddress,
    destroyed,
    groups,
    removedModules,
    memo: new Map(),
    index: buildPlanIndex(plan, removedModules),
    knownAccounts,
    functionalTagKeys,
    ruleManagedGroups,
    siblingCount: (c) => groups.get(groupKey(c))?.length ?? 1,
    destroysSameConfig: (c) => destroyedConfigs.has(configKey(c)),
    bucketDestroyed: (name) => destroyedBuckets.has(name),
    bucketCreated: (name) => createdBuckets.has(name),
  };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function buildPlanIndex(plan: PlanModel, removedModules: Map<string, ResourceChange[]>): PlanIndex {
  const index: PlanIndex = {
    order: new Map(),
    createsByIdentity: new Map(),
    deletesByIdentity: new Map(),
    createsWithoutIdentity: new Map(),
    deletesWithoutIdentity: new Map(),
    createsByValue: new Map(),
    deletesByValue: new Map(),
    groupIndexes: new Map(),
    byConfigAction: new Map(),
    removedModuleOf: new Map(),
    removedModuleHoldsData: new Map(),
    moduleMoves: new Map(),
    replaced: 0,
    deleted: 0,
    deposed: 0,
  };
  plan.changes.forEach((c, i) => {
    index.order.set(c, i);
    if (c.action === "create") {
      const ids = identitiesOf(c.after);
      for (const [k, v] of ids) push(index.createsByIdentity, `${c.type}\u0000${k}\u0000${v}`, c);
      if (!ids.length) {
        push(index.createsWithoutIdentity, c.type, c);
        for (const [k, v] of looseTokens(c.after, c.afterUnknown))
          push(index.createsByValue, tokenKey(c.type, k, v), c);
      }
    } else if (c.action === "delete" && !c.deposed) {
      const ids = identitiesOf(c.before);
      for (const [k, v] of ids) push(index.deletesByIdentity, `${c.type}\u0000${k}\u0000${v}`, c);
      if (!ids.length) {
        push(index.deletesWithoutIdentity, c.type, c);
        for (const t of beforeTokens(c.type, c.before)) push(index.deletesByValue, t, c);
      }
    }
    if (c.action === "create" || c.action === "replace")
      push(index.byConfigAction, `${c.action}|${c.configModulePath.join(".")}|${c.type}|${c.name}`, c);
    if (isDestroy(c)) {
      if (c.deposed) index.deposed++;
      else if (c.action === "replace") index.replaced++;
      else index.deleted++;
    }
  });
  for (const [key, members] of removedModules) {
    for (const m of members) index.removedModuleOf.set(m, key);
    index.removedModuleHoldsData.set(
      key,
      members.some((m) => classify(m.type).tier === "A"),
    );
  }
  return index;
}

function groupIndex(change: ResourceChange, ctx: ScoreContext): GroupIndex {
  const key = groupKey(change);
  let gi = ctx.index.groupIndexes.get(key);
  if (gi) return gi;
  gi = { touched: 0, byAfterIdentity: new Map(), byBeforeIdentity: new Map() };
  for (const o of ctx.groups.get(key) ?? []) {
    if (!o.deposed && (isDestroy(o) || o.action === "create")) gi.touched++;
    for (const [k, v] of identitiesOf(o.after)) push(gi.byAfterIdentity, `${k}\u0000${v}`, o);
    for (const [k, v] of identitiesOf(o.before)) push(gi.byBeforeIdentity, `${k}\u0000${v}`, o);
  }
  ctx.index.groupIndexes.set(key, gi);
  return gi;
}

/**
 * The first change in plan order that `test` accepts, among the lists an object's identities point
 * at (`prefix` + `key|value`). Equivalent to a scan of the whole plan for predicates that need a
 * shared identity value.
 */
function firstByIdentity(
  map: Map<string, ResourceChange[]>,
  prefix: string,
  ids: readonly [string, string][],
  order: Map<ResourceChange, number>,
  test: (o: ResourceChange) => boolean,
): ResourceChange | undefined {
  let best: ResourceChange | undefined;
  let bestAt = Number.POSITIVE_INFINITY;
  for (const [k, v] of ids) {
    for (const o of map.get(`${prefix}${k}\u0000${v}`) ?? []) {
      const at = order.get(o) ?? Number.POSITIVE_INFINITY;
      if (at < bestAt && test(o)) {
        best = o;
        bestAt = at;
      }
    }
  }
  return best;
}

const destroyPlans = new WeakMap<PlanModel, boolean>();

/**
 * True for a plan made in destroy mode (`terraform plan -destroy`, `terraform destroy`): every change
 * is a delete without an action_reason, and resources the configuration still declares are among
 * them. A normal plan (format 1.0+, Terraform 1.1+) gives each delete of a live object a reason; only
 * deposed leftovers have none, and those are not counted. The plan JSON has no mode field.
 */
export function isDestroyPlan(plan: PlanModel): boolean {
  const cached = destroyPlans.get(plan);
  if (cached !== undefined) return cached;
  const live = plan.changes.filter((c) => !c.deposed && c.action !== "no-op" && c.action !== "read");
  const major = Number.parseInt(plan.formatVersion, 10);
  const result =
    (Number.isNaN(major) || major >= 1) &&
    live.some((c) => c.action === "delete") &&
    live.every((c) => (c.action === "delete" || c.action === "forget") && c.actionReason === undefined) &&
    live.some((c) => c.action === "delete" && stillConfigured(plan, c));
  destroyPlans.set(plan, result);
  return result;
}

/** True when the configuration still declares the resource block (whatever its count / for_each). */
function stillConfigured(plan: PlanModel, c: ResourceChange): boolean {
  const mod = plan.modules[c.configModulePath.join(".")];
  return mod?.resources[`${c.mode === "data" ? "data." : ""}${c.type}.${c.name}`] !== undefined;
}

// ───────────────────────────── references (PLAN-14) ─────────────────────────────

/** Every reference string inside an expression or nested-block structure from plan.configuration. */
function collectReferences(expr: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 16 || expr === null || typeof expr !== "object") return out;
  if (Array.isArray(expr)) {
    for (const e of expr) collectReferences(e, out, depth + 1);
    return out;
  }
  const e = expr as Expression & Rec;
  if (Array.isArray(e.references)) {
    for (const r of e.references) if (typeof r === "string") out.push(r);
  }
  for (const [k, v] of Object.entries(e)) {
    if (k !== "references" && k !== "constant_value") collectReferences(v, out, depth + 1);
  }
  return out;
}

/** Split a reference on dots outside brackets: `module.svc["a.b"].out` → ["module", `svc["a.b"]`, "out"]. */
function splitReference(ref: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < ref.length; i++) {
    const ch = ref[i]!;
    if (quoted) {
      cur += ch;
      if (ch === "\\" && i + 1 < ref.length) cur += ref[++i];
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === "[") depth++;
    else if (ch === "]") depth--;
    if (ch === "." && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

const stripKey = (segment: string): string => segment.replace(/\[.*$/, "");

/**
 * The replaced resource an attribute's value flows from, following references across module
 * inputs and outputs (locals are not in the plan JSON, so a local ends the walk).
 */
export function findReplacedUpstream(
  change: ResourceChange,
  attr: string,
  ctx: ScoreContext,
  /** Which upstream changes count: replacements (default) or creates. */
  kind: "replace" | "create" = "replace",
): ResourceChange | null {
  const mod = ctx.plan.modules[change.configModulePath.join(".")];
  const res = mod?.resources[`${change.mode === "data" ? "data." : ""}${change.type}.${change.name}`];
  if (!res) return null;
  const seen = new Set<string>();
  const walk = (refs: string[], modulePath: string[], depth: number): ResourceChange | null => {
    if (depth > MAX_REFERENCE_DEPTH) return null;
    for (const ref of refs) {
      const key = `${modulePath.join(".")}|${ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const parts = splitReference(ref);
      const head = parts[0] ?? "";
      if (head === "var" && parts[1] && modulePath.length) {
        const parent = modulePath.slice(0, -1);
        const call = ctx.plan.modules[parent.join(".")]?.moduleCalls[modulePath[modulePath.length - 1]!];
        const hit = walk(collectReferences(call?.expressions[parts[1]]), parent, depth + 1);
        if (hit) return hit;
      } else if (head === "module" && parts[1] && parts[2]) {
        const child = [...modulePath, stripKey(parts[1])];
        const output = ctx.plan.modules[child.join(".")]?.outputs[parts[2]];
        const hit = walk(collectReferences(output?.expression), child, depth + 1);
        if (hit) return hit;
      } else if (head === "data" && parts[1] && parts[2]) {
        // A data source read during apply (a policy document over a new resource's ARN): its arguments.
        const ds =
          ctx.plan.modules[modulePath.join(".")]?.resources[`data.${parts[1]}.${stripKey(parts[2])}`];
        const hit = ds ? walk(collectReferences(ds.expressions), modulePath, depth + 1) : null;
        if (hit) return hit;
      } else if (head === "each" && depth === 0 && res.forEachExpression) {
        // `for_each = aws_subnet.private` + `subnet_id = each.value.id`: the collection is the source.
        const hit = walk(collectReferences(res.forEachExpression), modulePath, depth + 1);
        if (hit) return hit;
      } else if (
        !["var", "module", "data", "local", "each", "count", "path", "terraform", "self"].includes(head)
      ) {
        const type = head;
        const name = parts[1] ? stripKey(parts[1]) : "";
        if (!name) continue;
        const exact = `${modulePath.length ? `${modulePath.map((m) => `module.${m}`).join(".")}.` : ""}${type}.${parts[1]}`;
        const candidates = (
          ctx.index.byConfigAction.get(`${kind}|${modulePath.join(".")}|${type}|${name}`) ?? []
        ).filter((c) => c.address !== change.address);
        const hit =
          candidates.find((c) => c.address === exact) ??
          (change.index !== undefined ? candidates.find((c) => c.index === change.index) : undefined) ??
          candidates[0];
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(collectReferences(res.expressions[attr]), change.configModulePath, 0);
}

// ───────────────────────────── identity matching (PLAN-04 / PLAN-06) ─────────────────────────────

const IDENTITY_KEYS = [
  "bucket",
  "name",
  "identifier",
  "function_name",
  "cluster_identifier",
  "cluster_name",
  "domain_name",
  "table_name",
  "cidr_block",
  "family",
];
const VOLATILE_KEYS = new Set(["id", "arn", "tags", "tags_all", "timeouts", "labels", "effective_labels"]);

/** Identity attribute/value pairs an object is known by, e.g. ["bucket", "acme-prod-exports"]. */
function identities(o: Rec): [string, string][] {
  const out: [string, string][] = [];
  for (const k of IDENTITY_KEYS) {
    const v = o[k];
    if (typeof v === "string" && v) out.push([k, v]);
  }
  const name = asRecord(o.tags).Name;
  if (typeof name === "string" && name) out.push(["tags.Name", name]);
  return out;
}

const identityCache = new WeakMap<object, [string, string][]>();

/** identities() of a plan value, computed once per object. */
function identitiesOf(v: unknown): [string, string][] {
  if (v === null || typeof v !== "object") return [];
  let ids = identityCache.get(v);
  if (!ids) {
    ids = identities(asRecord(v));
    identityCache.set(v, ids);
  }
  return ids;
}

function identityOf(o: Rec): [string, string] | null {
  return identitiesOf(o)[0] ?? null;
}

/**
 * True when `after` (another instance's planned object) is the same real object as `before`: the
 * first identity attribute both sides know decides. With `loose`, objects without any identity
 * attribute match when at least 90% of at least three known scalar attributes are equal.
 */
function sameObject(before: unknown, after: unknown, afterUnknown: unknown, loose = false): boolean {
  const ib = identitiesOf(before);
  const ia = identitiesOf(after);
  for (const [k, v] of ib) {
    const other = ia.find(([key]) => key === k);
    if (other !== undefined) return other[1] === v;
  }
  if (!loose || ib.length || ia.length) return false;
  const b = asRecord(before);
  let keys = 0;
  let equal = 0;
  for (const [k, v] of looseTokens(after, afterUnknown)) {
    if (!(k in b)) continue;
    keys++;
    if (b[k] === v) equal++;
  }
  return keys >= 3 && equal / keys >= 0.9;
}

const looseCache = new WeakMap<object, [string, unknown][]>();

/** The known, non-volatile scalar attributes of a planned object: what the loose match compares. */
function looseTokens(after: unknown, afterUnknown: unknown): [string, unknown][] {
  if (after === null || typeof after !== "object") return [];
  let tokens = looseCache.get(after);
  if (!tokens) {
    const a = asRecord(after);
    tokens = Object.keys(a)
      .filter(
        (k) =>
          !VOLATILE_KEYS.has(k) &&
          a[k] !== null &&
          typeof a[k] !== "object" &&
          !isUnknownAt(afterUnknown, [k]),
      )
      .map((k) => [k, a[k]]);
    looseCache.set(after, tokens);
  }
  return tokens;
}

/** Hash key of one scalar attribute value (a loose match shares at least one). */
const tokenKey = (type: string, k: string, v: unknown): string =>
  `${type}\u0000${k}\u0000${JSON.stringify(v)}`;

/** Non-volatile scalar attributes of a current object, as tokenKeys. */
function beforeTokens(type: string, before: unknown): string[] {
  const b = asRecord(before);
  return Object.keys(b)
    .filter((k) => !VOLATILE_KEYS.has(k) && b[k] !== null && typeof b[k] !== "object")
    .map((k) => tokenKey(type, k, b[k]));
}

/**
 * The first change of `list` (plan order) that `test` accepts, for the loose match.
 *
 * A loose match has at least three equal scalar attributes (sameObject: 90% of at least three keys),
 * so it sits in at least three of the probe's value buckets, and leaving out the two largest buckets
 * cannot lose it. Buckets are filled in plan order, so each one is read only up to its first accepted
 * change. Scanning `list` instead is quadratic when every object shares a common value (a `kind` or
 * `region` that all instances have).
 */
function firstLoose(
  list: readonly ResourceChange[] | undefined,
  buckets: Map<string, ResourceChange[]>,
  probe: readonly string[],
  order: Map<ResourceChange, number>,
  test: (o: ResourceChange) => boolean,
): ResourceChange | undefined {
  if (!list?.length) return undefined;
  const lists = [...new Set(probe)].map((t) => buckets.get(t) ?? []).sort((a, b) => a.length - b.length);
  if (lists.length < 3) return undefined;
  let best: ResourceChange | undefined;
  let bestAt = Number.POSITIVE_INFINITY;
  for (const bucket of lists.slice(0, lists.length - 2)) {
    for (const o of bucket) {
      const at = order.get(o) ?? Number.POSITIVE_INFINITY;
      if (at >= bestAt) break;
      if (test(o)) {
        best = o;
        bestAt = at;
        break;
      }
    }
  }
  return best;
}

function identityText(o: unknown): string {
  const id = identityOf(asRecord(o));
  return id ? ` (${id[0]} ${fmtValue(id[1])})` : "";
}

// ───────────────────────────── helpers ─────────────────────────────

function signal(ruleId: string, severity: Severity, reason: string, path?: AttrPath): RiskSignal {
  return { ruleId, severity, reason, ...(path && { path }) };
}

/** "the RDS database" / "aws_foo_bar" for unknown types. */
function theNoun(change: ResourceChange): string {
  const n = classify(change.type).noun;
  return n === change.type ? change.type : `the ${n}`;
}

function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Replace paths with a known before → after change first, then the ones known only after apply. */
function orderedReplacePaths(change: ResourceChange): AttrPath[] {
  const rank = (p: AttrPath): number =>
    isUnknownAt(change.afterUnknown, p)
      ? 1
      : fmtValue(getAtPath(change.before, p)) !== fmtValue(getAtPath(change.after, p))
        ? 0
        : 2;
  return change.replacePaths
    .map((p, i) => ({ p, i }))
    .sort((x, y) => rank(x.p) - rank(y.p) || x.i - y.i)
    .map(({ p }) => p);
}

const isScalarValue = (v: unknown): boolean => v === null || v === undefined || typeof v !== "object";

/** "storage_encrypted true → false and kms_key_id" for the paths that forced a replacement. */
function describeForcing(change: ResourceChange, paths: AttrPath[]): string {
  const parts = paths.slice(0, 3).map((p) => {
    const name = formatPath(p);
    if (isUnknownAt(change.afterUnknown, p)) return `${name} (known only after apply)`;
    const b = getAtPath(change.before, p);
    const a = getAtPath(change.after, p);
    const shown = (v: unknown): boolean =>
      isScalarValue(v) || (Array.isArray(v) && v.length <= 4 && v.every(isScalarValue));
    return shown(b) && shown(a) && fmtValue(b) !== fmtValue(a) ? `${name} ${transition(b, a)}` : name;
  });
  const more = paths.length > 3 ? ` and ${paths.length - 3} more` : "";
  return parts.join(" and ") + more;
}

/** PLAN-02 reason for a replace_because_cannot_update. */
function forcedReplaceReason(change: ResourceChange, ctx: ScoreContext, tail: string): string {
  const noun = theNoun(change);
  const paths = orderedReplacePaths(change);
  const first = paths[0];
  if (!first) return `The provider cannot update ${noun} in place, so it is destroyed and re-created${tail}.`;
  const attr = typeof first[0] === "string" ? first[0] : "";
  if (paths.every((p) => isUnknownAt(change.afterUnknown, p)) && attr) {
    const upstream = findReplacedUpstream(change, attr, ctx);
    if (upstream) {
      const why = forceNewExplanation(change.type, first);
      return `${formatPath(first)} follows ${upstream.address}, which is replaced${why ? `, and ${why}` : ""}, so ${noun} is destroyed and re-created too${tail}.`;
    }
  }
  const verb = paths.length > 1 ? "force" : "forces";
  return `${describeForcing(change, paths)} ${verb} replacement (${explainForceNew(change.type, first)}): ${noun} is destroyed and re-created${tail}.`;
}

const DELETION_GUARDS: readonly AttrPath[] = [
  ["deletion_protection"],
  ["deletion_protection_enabled"],
  ["enable_deletion_protection"],
];

function guardNote(change: ResourceChange): string {
  const before = asRecord(change.before);
  const after = asRecord(change.after);
  const on = DELETION_GUARDS.some(
    (p) => getAtPath(before, p) === true && (change.action === "delete" || getAtPath(after, p) !== false),
  );
  return on ? "; deletion protection is on, so the apply fails until it is turned off" : "";
}

// ───────────────────────────── per action ─────────────────────────────

function destroySignals(change: ResourceChange, ctx: ScoreContext): RiskSignal[] {
  const cls = classify(change.type);
  const out: RiskSignal[] = [];
  const noun = theNoun(change);
  const loss = destroyLoss(change);
  const isReplace = change.action === "replace";
  const cbd = change.replaceOrder === "create-before-destroy";
  let base = destroySeverity(change, ctx);
  const tierA = cls.tier === "A";

  // NOISE-02: a task definition "replace" is how a new revision is registered.
  if (isReplace && change.type === "aws_ecs_task_definition") {
    const diff = taskDefinitionDiff(change);
    if (diff?.equal) {
      return [
        signal(
          "task-definition-revision",
          "noise",
          "A new task definition revision is registered with the same container definitions (only formatting or defaults differ).",
        ),
      ];
    }
    const images = diff?.images.length ? `: ${diff.images.slice(0, 2).join("; ")}` : "";
    return [
      signal(
        "task-definition-revision",
        "low",
        `A new task definition revision is registered${images}; the service picks it up on its next deployment.`,
      ),
    ];
  }

  const kind = isReplace ? "replace" : "delete";
  const prefix = tierA ? "stateful" : cls.tier === "B" ? "identity" : "";
  let ruleId = prefix ? `${prefix}-${kind}` : kind;
  let reason: string;
  const lossClause = loss ? `, and ${loss}` : "";
  const lossColon = loss ? `: ${loss}` : "";
  const guard = guardNote(change);

  if (isReplace) {
    const order = cbd ? " (the new one is created first)" : "";
    switch (change.actionReason) {
      case "replace_because_tainted": // PLAN-08
        ruleId = "tainted-replace";
        base = tierA ? "critical" : "medium";
        reason = `Terraform replaces ${noun} because it is tainted (an earlier apply failed part-way, or someone ran terraform taint), not because of the configuration${lossClause}${guard}.`;
        break;
      case "replace_by_request": // PLAN-08
        ruleId = "replace-by-request";
        if (!tierA) base = "medium";
        reason = `${capitalize(noun)} is replaced because the plan was run with -replace, not because of the configuration${lossClause}${guard}.`;
        break;
      case "replace_by_triggers": // PLAN-08
        ruleId = "replace-by-triggers";
        reason = `${capitalize(noun)} is replaced because a resource named in its lifecycle replace_triggered_by changed${lossClause}${guard}.`;
        break;
      default: // PLAN-02
        reason = forcedReplaceReason(change, ctx, `${order}${lossClause}${guard}`);
    }
    // PLAN-01: create_before_destroy softens an outage, never data loss or identity change.
    if (cbd && cls.impact === "outage") base = lowerSeverity(base);
  } else {
    switch (change.actionReason) {
      case "delete_because_no_resource_config": // PLAN-04
        reason = `The ${change.type}.${change.name} block was removed from the configuration, so Terraform destroys ${noun}${lossColon}${guard}.`;
        break;
      case "delete_because_no_module": // PLAN-05
        ruleId = "module-instance-removed";
        base = tierA ? "critical" : maxSeverity(base, "high");
        reason = `The module instance ${change.moduleAddress ?? ""} no longer exists because the module's count or for_each shrank, so ${noun} in it is destroyed${lossColon}${guard}.`;
        break;
      case "delete_because_wrong_repetition": // PLAN-06
        ruleId = "wrong-repetition";
        base = tierA ? "critical" : maxSeverity(base, "high");
        reason = `The resource switched between count and for_each without moved blocks, so ${noun} is destroyed and re-created under a new address${lossClause}.`;
        break;
      case "delete_because_no_move_target": // PLAN-06
        ruleId = "missing-move-target";
        base = maxSeverity(base, "high");
        reason = `A moved block points at an address that no longer exists, so ${noun} is destroyed${lossColon}.`;
        break;
      case "delete_because_count_index":
      case "delete_because_each_key": {
        const what = change.actionReason === "delete_because_count_index" ? "count index" : "for_each key";
        reason = `${capitalize(noun)} is destroyed because its ${what} ${fmtValue(change.index)} is no longer in the configuration${lossColon}${guard}.`;
        break;
      }
      case "delete_because_enabled_false": // OpenTofu `enabled` meta-argument
        reason = `${capitalize(noun)} is destroyed because its enabled argument is now false (the block stays in the configuration)${lossColon}${guard}.`;
        break;
      default:
        reason = change.deposed
          ? `This leftover (deposed) object from an earlier create_before_destroy replacement is destroyed${lossColon}.`
          : isDestroyPlan(ctx.plan)
            ? `${capitalize(noun)} is destroyed because this is a destroy plan (terraform plan -destroy), not because of the configuration${lossColon}${guard}.`
            : `${capitalize(noun)} is destroyed${lossColon}${guard}.`;
    }
  }
  out.push(signal(ruleId, base, reason, change.replacePaths[0]));

  // PLAN-09: an import or a move that ends in a destroy.
  if (change.importing) {
    out.push(
      signal("import-destroy", "high", `This plan imports ${noun} and destroys it in the same apply.`),
    );
  }
  // In a destroy plan a moved object is destroyed with everything else: the move has nothing to absorb.
  if (change.previousAddress && change.previousAddress !== change.address && !isDestroyPlan(ctx.plan)) {
    out.push(
      signal(
        "moved-but-destroyed",
        "high",
        `${capitalize(noun)} was moved from ${change.previousAddress}, but the move did not absorb the change: it is still destroyed.`,
      ),
    );
  }
  out.push(...moduleRemovedSignals(change, ctx));
  out.push(...reindexSignals(change, ctx));
  out.push(...renameSignals(change, ctx));
  return out;
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** PLAN-04: the whole module call was removed. */
function moduleRemovedSignals(change: ResourceChange, ctx: ScoreContext): RiskSignal[] {
  if (change.action !== "delete" || change.actionReason !== "delete_because_no_resource_config") return [];
  const key = ctx.index.removedModuleOf.get(change);
  const members = key === undefined ? undefined : ctx.removedModules.get(key);
  if (key !== undefined && members) {
    const anyTierA = ctx.index.removedModuleHoldsData.get(key) === true;
    const name = `module.${key.split(".").join(".module.")}`;
    return [
      signal(
        "module-removed",
        anyTierA ? "high" : "medium",
        `The module call ${name} was removed, so all ${pluralize(members.length, "resource")} in it are destroyed, including ${theNoun(change)}${anyTierA ? " (the module holds data)" : ""}.`,
      ),
    ];
  }
  return [];
}

/** PLAN-06: count / for_each re-index: the object this instance holds moves to another key, or vice versa. */
function reindexSignals(change: ResourceChange, ctx: ScoreContext): RiskSignal[] {
  if (change.index === undefined) return [];
  const gi = groupIndex(change, ctx);
  const other = (o: ResourceChange): boolean => o !== change && o.index !== change.index && !o.deposed;
  const ownIdentityKept = sameObject(change.before, change.after, change.afterUnknown);
  const movesTo = ownIdentityKept
    ? undefined
    : firstByIdentity(
        gi.byAfterIdentity,
        "",
        identitiesOf(change.before),
        ctx.index.order,
        (o) =>
          other(o) &&
          ["create", "replace", "update"].includes(o.action) &&
          sameObject(change.before, o.after, o.afterUnknown),
      );
  const takesFrom =
    change.action === "replace" && !ownIdentityKept
      ? firstByIdentity(
          gi.byBeforeIdentity,
          "",
          identitiesOf(change.after),
          ctx.index.order,
          (o) => other(o) && isDestroy(o) && sameObject(o.before, change.after, change.afterUnknown),
        )
      : undefined;
  const byReason =
    change.actionReason === "delete_because_count_index" || change.actionReason === "delete_because_each_key";
  if (!movesTo && !takesFrom && !byReason) return [];
  const touched = gi.touched;
  const tierA = classify(change.type).tier === "A";
  const severity: Severity = tierA ? "critical" : touched >= REINDEX_HIGH_THRESHOLD ? "high" : "medium";
  const fix = "a moved block, or for_each keyed by a stable name, keeps it";
  let reason: string;
  if (movesTo) {
    reason = `The count/for_each list shifted: ${movesTo.address} now describes the object this instance holds${identityText(change.before)}, so Terraform ${change.action === "delete" ? "destroys" : "destroys and re-creates"} it instead of keeping it (${fix}).`;
  } else if (takesFrom) {
    reason = `The count/for_each list shifted: this instance now gets the settings of ${takesFrom.address}${identityText(change.after)}, so its current object${identityText(change.before)} is destroyed and a new one is created in its place (${fix}).`;
  } else {
    reason = `Its index left the count/for_each collection; if an element was removed from the middle of a list, every later instance shifts and is re-created too (${fix}).`;
  }
  return [signal("count-reindex", severity, reason)];
}

/** PLAN-04 / DESIGN: a delete next to a create of the same object = a rename without a moved block. */
function renameSignals(change: ResourceChange, ctx: ScoreContext): RiskSignal[] {
  if (change.action !== "delete" || change.deposed) return [];
  const own = groupKey(change);
  const test = (o: ResourceChange): boolean =>
    o.address !== change.address &&
    groupKey(o) !== own &&
    sameObject(change.before, o.after, o.afterUnknown, true);
  const ids = identitiesOf(change.before);
  const target = ids.length
    ? firstByIdentity(ctx.index.createsByIdentity, `${change.type}\u0000`, ids, ctx.index.order, test)
    : firstLoose(
        ctx.index.createsWithoutIdentity.get(change.type),
        ctx.index.createsByValue,
        beforeTokens(change.type, change.before),
        ctx.index.order,
        test,
      );
  if (!target) return [];
  return [
    signal(
      "renamed-without-moved",
      "high",
      `${target.address} creates the same object${identityText(change.before)}, so this looks like a rename without a moved block: Terraform destroys the existing one and creates a new, empty one, in no fixed order (the create can also fail while the old name is still taken). ${movedAdvice(change, target, ctx)}`,
    ),
  ];
}

/** The address inside its module, as a moved block in that module writes it. */
function relativeAddress(change: ResourceChange): string {
  return change.moduleAddress ? change.address.slice(change.moduleAddress.length + 1) : change.address;
}

/** `module.a["x"].module.b` → [`module.a["x"]`, `module.b`]; [] for the root module. */
function moduleSegments(moduleAddress: string | null): string[] {
  if (!moduleAddress) return [];
  const parts = splitReference(moduleAddress);
  const out: string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) out.push(`${parts[i]}.${parts[i + 1]}`);
  return out;
}

/**
 * The moved block that keeps a renamed object, written in the module that contains both addresses
 * (the root module, or the module both calls live in). Within one module it is the relative
 * addresses; across module calls it is the addresses below that common module, and the whole module
 * call when everything in it moves to the same place under the new one.
 */
function movedAdvice(change: ResourceChange, target: ResourceChange, ctx: ScoreContext): string {
  if ((change.moduleAddress ?? "") === (target.moduleAddress ?? ""))
    return `A moved block keeps it: moved { from = ${relativeAddress(change)} to = ${relativeAddress(target)} }.`;
  const from = moduleSegments(change.moduleAddress);
  const to = moduleSegments(target.moduleAddress);
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common++;
  const prefix = from.slice(0, common).join(".");
  const strip = (address: string): string => (prefix ? address.slice(prefix.length + 1) : address);
  const where = prefix ? `the code of ${from.slice(0, common).map(stripKey).join(".")}` : "the root module";
  const wholeModule =
    change.moduleAddress !== null &&
    target.moduleAddress !== null &&
    relativeAddress(change) === relativeAddress(target) &&
    movesWholeModule(change.moduleAddress, target.moduleAddress, ctx);
  const [a, b] = wholeModule
    ? [strip(change.moduleAddress as string), strip(target.moduleAddress as string)]
    : [strip(change.address), strip(target.address)];
  return `A moved block in ${where} keeps it: moved { from = ${a} to = ${b} }.`;
}

/**
 * True when every object under module instance `from` is destroyed and re-created at the same place
 * under `to`, and nothing else lives under `to`: a module-level moved block keeps them all.
 */
function movesWholeModule(from: string, to: string, ctx: ScoreContext): boolean {
  const key = `${from}\u0000${to}`;
  const cached = ctx.index.moduleMoves.get(key);
  if (cached !== undefined) return cached;
  let ok = true;
  let moved = 0;
  for (const c of ctx.plan.changes) {
    if (c.address.startsWith(`${from}.`)) {
      const twin = ctx.byAddress.get(`${to}${c.address.slice(from.length)}`);
      if (c.action !== "delete" || (!c.deposed && twin?.action !== "create")) ok = false;
      else if (!c.deposed) moved++;
    } else if (c.address.startsWith(`${to}.`) && c.action !== "create") ok = false;
    if (!ok) break;
  }
  const result = ok && moved > 0;
  ctx.index.moduleMoves.set(key, result);
  return result;
}

function renameTargetSignals(change: ResourceChange, ctx: ScoreContext): RiskSignal[] {
  const own = groupKey(change);
  const test = (o: ResourceChange): boolean =>
    groupKey(o) !== own && sameObject(o.before, change.after, change.afterUnknown, true);
  const ids = identitiesOf(change.after);
  const source = ids.length
    ? firstByIdentity(ctx.index.deletesByIdentity, `${change.type}\u0000`, ids, ctx.index.order, test)
    : firstLoose(
        ctx.index.deletesWithoutIdentity.get(change.type),
        ctx.index.deletesByValue,
        looseTokens(change.after, change.afterUnknown).map(([k, v]) => tokenKey(change.type, k, v)),
        ctx.index.order,
        test,
      );
  if (!source) return [];
  return [
    signal(
      "renamed-without-moved",
      "medium",
      `This creates the same object${identityText(change.after)} that ${source.address} destroys; with a moved block Terraform would keep the existing one instead.`,
    ),
  ];
}

function ruleSignals(change: ResourceChange, action: RuleAction, ctx: ScoreContext): RiskSignal[] {
  return evaluateRules({
    change,
    action,
    before: asRecord(change.before),
    after: asRecord(change.after),
    ctx,
  }).map((h) => signal(h.ruleId, h.severity, h.reason, h.path));
}

const FUNCTIONAL_TAG_WHY =
  "load balancer subnet discovery, Karpenter, patching, backups or ABAC policies key on it";

/** Recovery guards of AWS-U01 / AWS-U02 (and GCP equivalents). */
const SAFETY_NETS: Readonly<Record<string, string>> = {
  "deletion-protection-off": "deletion protection",
  "final-snapshot-off": "final snapshot",
  "backups-off": "backups",
};

/**
 * AWS-U01/U02 composite: one change that removes two or more independent recovery guards at once
 * leaves a single destroy (or mistake) with no way back, so it is critical even without a destroy.
 */
function safetyNetSignals(change: ResourceChange, signals: readonly RiskSignal[]): RiskSignal[] {
  const off = [...new Set(signals.map((s) => s.ruleId).filter((id) => id in SAFETY_NETS))];
  if (off.length < 2) return [];
  const names = off.map((id) => SAFETY_NETS[id]!);
  const list =
    names.length === 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return [
    signal(
      "safety-nets-off",
      "critical",
      `${capitalize(list)} ${names.length === 2 ? "are both" : "are all"} turned off: a destroy or mistake after this apply leaves ${theNoun(change)} with no recovery point.`,
    ),
  ];
}

function updateSignals(change: ResourceChange, action: RuleAction, ctx: ScoreContext): RiskSignal[] {
  const out = ruleSignals(change, action, ctx);
  out.push(...safetyNetSignals(change, out));
  const noise = classifyNoise(change, ctx);
  const firstTag = noise.functionalTags[0];
  if (firstTag) {
    out.push(
      signal(
        "functional-tag",
        "medium",
        `Tag ${fmtValue(firstTag)} changes, and it is not cosmetic: ${FUNCTIONAL_TAG_WHY}.`,
      ),
    );
  }
  if (noise.material.length === 0 && noise.unknownOnly.length) {
    out.push(...cascadeSignals(change, noise.unknownOnly, ctx));
  }
  if (!out.length && noise.material.length === 0 && noise.unknownOnly.length === 0) {
    out.push(...noiseSignals(change, noise));
  }
  return out;
}

/** PLAN-14: unknown-only updates inherit from the replacement they flow from; otherwise LOW (NOISE-05). */
function cascadeSignals(change: ResourceChange, unknown: AttrPath[], ctx: ScoreContext): RiskSignal[] {
  const attrs = [...new Set(unknown.map((p) => (typeof p[0] === "string" ? p[0] : "")).filter(Boolean))];
  for (const attr of attrs) {
    const upstream = findReplacedUpstream(change, attr, ctx);
    if (!upstream) continue;
    const upstreamSeverity = scoreChange(upstream, ctx.plan, ctx).severity;
    const forceNew = isForceNewAttribute(change.type, attr);
    const severity = forceNew ? upstreamSeverity : lowerSeverity(upstreamSeverity);
    if (severity === "noise") continue;
    return [
      signal(
        "unknown-from-replacement",
        severity,
        `${attr} becomes unknown because ${upstream.address} is replaced, so ${theNoun(change)} is updated with the new value on apply${forceNew ? `, and since ${attr} cannot change in place it will be replaced too` : ""}.`,
        [attr],
      ),
    ];
  }
  const shown = attrs.slice(0, 3).join(", ") + (attrs.length > 3 ? ` and ${attrs.length - 3} more` : "");
  for (const attr of attrs) {
    const created = findReplacedUpstream(change, attr, ctx, "create");
    if (created)
      return [
        signal(
          "unknown-only",
          "low",
          `Only values known after apply change (${shown}): they come from ${created.address}, which this plan creates.`,
        ),
      ];
  }
  return [
    signal(
      "unknown-only",
      "low",
      `Only values known after apply change (${shown}), and they do not come from a resource this plan replaces or creates.`,
    ),
  ];
}

const SECURITY_DRIFT_ROOTS = new Set([
  "ingress",
  "egress",
  "policy",
  "assume_role_policy",
  "inline_policy",
  "access_policies",
  "block_public_acls",
  "block_public_policy",
  "ignore_public_acls",
  "restrict_public_buckets",
  "publicly_accessible",
  "cidr_blocks",
  "ipv6_cidr_blocks",
  "cidr_ipv4",
  "cidr_ipv6",
  "from_port",
  "to_port",
  "acl",
  "source_ranges",
  "security_rule",
  "network_rules",
  "network_acls",
  "public_network_access_enabled",
]);
const CAPACITY_DRIFT: readonly AttrPath[] = [
  ["desired_capacity"],
  ["desired_count"],
  ["scaling_config", 0, "desired_size"],
];

/** PLAN-10: the plan reverts a change made outside Terraform. */
function driftSignals(change: ResourceChange, ctx: ScoreContext): RiskSignal[] {
  if (change.action !== "update" && change.action !== "replace") return [];
  const drift = ctx.driftByAddress.get(change.address);
  if (!drift) return [];
  const driftPaths = [...drift.changedPaths, ...drift.sensitiveChangedPaths];
  const overlap = touchedPaths(change).find(
    (p) => !isTagPath(p) && driftPaths.some((d) => isPrefix(d, p) || isPrefix(p, d)),
  );
  if (!overlap) return [];
  const top = typeof overlap[0] === "string" ? overlap[0] : "";
  const security = SECURITY_DRIFT_ROOTS.has(top) || POLICY_ATTRIBUTE_NAMES.has(top);
  const capacity = CAPACITY_DRIFT.some((p) => isPrefix(p, overlap) || isPrefix(overlap, p));
  const severity: Severity = security || capacity ? "high" : "medium";
  const why = security
    ? "which may undo a manual security fix"
    : capacity
      ? "which scales it back from what autoscaling or an operator set"
      : "which may undo someone's manual change";
  return [
    signal(
      "drift-revert",
      severity,
      `${formatPath(overlap)} was changed outside Terraform and this plan sets it back (${transition(getAtPath(change.before, overlap), getAtPath(change.after, overlap), isUnknownAt(change.afterUnknown, overlap))}), ${why}.`,
      overlap,
    ),
  ];
}

/**
 * PLAN-11: attached to every destroyed change once the plan destroys MASS_DESTROY_THRESHOLD or more
 * live objects. A deposed leftover (an earlier create_before_destroy's old object) is not one more
 * live resource: it is named apart and does not count toward the threshold.
 */
function massDestroySignal(change: ResourceChange, current: Severity, ctx: ScoreContext): RiskSignal[] {
  const { replaced, deleted, deposed } = ctx.index;
  const n = replaced + deleted;
  if (n < MASS_DESTROY_THRESHOLD || !isDestroy(change) || severityRank(current) >= severityRank("low"))
    return [];
  const leftovers = deposed ? `, plus ${pluralize(deposed, "leftover deposed object")}` : "";
  return [
    signal(
      "mass-destroy",
      "high",
      `This plan destroys ${n} resources (${pluralize(replaced, "replacement")}, ${pluralize(deleted, "delete")})${leftovers}, so check the whole blast radius before approving.`,
    ),
  ];
}

// ───────────────────────────── scoring ─────────────────────────────

function severityOf(signals: readonly RiskSignal[]): Severity {
  if (!signals.length) return "low";
  const real = signals.filter((s) => s.severity !== "noise");
  if (!real.length) return "noise";
  return maxSeverity(...real.map((s) => s.severity));
}

function finalize(change: ResourceChange, raw: RiskSignal[]): ScoredChange {
  const seen = new Set<string>();
  const signals = raw
    .filter((s) => {
      const key = `${s.ruleId}|${s.reason}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((s, i) => ({ s, i }))
    .sort((a, b) => severityRank(a.s.severity) - severityRank(b.s.severity) || a.i - b.i)
    .map(({ s }) => s);
  const severity = severityOf(signals);
  const tier = classify(change.type).tier;
  const real = signals.filter((s) => s.severity !== "noise").length;
  const bonus = Math.min(
    0.95,
    0.05 * Math.min(real, 6) + (tier === "A" ? 0.3 : tier === "B" ? 0.1 : 0) + (isDestroy(change) ? 0.2 : 0),
  );
  const score = Math.round((SEVERITY_WEIGHT[severity] + bonus) * 100) / 100;
  return { change, severity, score, signals };
}

/**
 * Score one change. `ctx` carries the plan-wide indexes (build it once with buildScoreContext and
 * pass it to every call when scoring a whole plan); it is built on demand otherwise.
 */
export function scoreChange(change: ResourceChange, plan: PlanModel, ctx?: ScoreContext): ScoredChange {
  const c = ctx && ctx.plan === plan ? ctx : buildScoreContext(plan);
  const key = memoKey(change);
  const cached = c.memo.get(key);
  if (cached && cached.change === change) return cached;
  const signals: RiskSignal[] = [];
  const noun = theNoun(change);
  switch (change.action) {
    case "no-op":
      break;
    case "move": // PLAN-09
      signals.push(
        signal(
          "moved",
          "noise",
          `Moved from ${change.previousAddress ?? "another address"} by a moved block; nothing about the object changes.`,
        ),
      );
      break;
    case "read": // NOISE-05
      signals.push(
        signal(
          "data-read",
          "noise",
          "A data source is read during apply because its inputs are not known yet; reading it changes nothing.",
        ),
      );
      break;
    case "forget": {
      // PLAN-07
      const recreate = change.actions.includes("create");
      signals.push(
        recreate
          ? signal(
              "forget-create",
              "high",
              `Terraform forgets the existing ${classify(change.type).noun} and creates a new one, leaving two live copies (or failing on a name collision).`,
            )
          : signal(
              "forget",
              "medium",
              `Terraform stops managing ${noun} but leaves it running (removed block with destroy = false), so it keeps running and costing money unmanaged; confirm who owns it now.`,
            ),
      );
      break;
    }
    case "import": {
      // PLAN-09
      const updates = change.actions.includes("update");
      signals.push(
        updates
          ? signal(
              "import-update",
              "medium",
              `This imports an existing ${classify(change.type).noun} and changes it on the first apply, so check the attributes it will overwrite.`,
            )
          : signal(
              "import",
              "low",
              `This adopts an existing ${classify(change.type).noun} into Terraform state without changing it.`,
            ),
      );
      if (updates) signals.push(...updateSignals(change, "import", c).filter((s) => s.severity !== "noise"));
      break;
    }
    case "create":
      signals.push(...ruleSignals(change, "create", c), ...renameTargetSignals(change, c));
      break;
    case "update":
      signals.push(...updateSignals(change, "update", c), ...driftSignals(change, c));
      break;
    case "delete":
      signals.push(...destroySignals(change, c));
      break;
    case "replace":
      signals.push(
        ...destroySignals(change, c),
        ...ruleSignals(change, "replace", c),
        ...driftSignals(change, c),
      );
      break;
  }
  signals.push(...massDestroySignal(change, severityOf(signals), c));
  const scored = finalize(change, signals);
  c.memo.set(key, scored);
  return scored;
}

function compareScored(a: ScoredChange, b: ScoredChange): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.change.address !== b.change.address) return a.change.address < b.change.address ? -1 : 1;
  return (a.change.deposed ?? "") < (b.change.deposed ?? "") ? -1 : 1;
}

/** Every non-no-op change, highest score first; ties by address for determinism. */
export function scorePlan(plan: PlanModel): ScoredChange[] {
  const ctx = buildScoreContext(plan);
  return plan.changes
    .filter((c) => c.action !== "no-op")
    .map((c) => scoreChange(c, plan, ctx))
    .sort(compareScored);
}

/**
 * PLAN-03: a replace/delete that no line of the PR explains (lineage "external" or "unknown") goes up
 * one level; Tier A data-holding resources always become critical.
 */
export function escalateForLineage(scored: ScoredChange, lineage: Lineage): ScoredChange {
  const { change } = scored;
  if (!isDestroy(change)) return scored;
  if (lineage.explanation !== "external" && lineage.explanation !== "unknown") return scored;
  if (scored.signals.some((s) => s.ruleId === "not-explained-by-diff")) return scored;
  const severity: Severity =
    classify(change.type).tier === "A"
      ? "critical"
      : raiseSeverity(scored.severity === "noise" ? "low" : scored.severity);
  const what = change.action === "replace" ? "replacement" : "deletion";
  const reason = change.deposed
    ? `No line in this PR causes this ${what}: it removes a leftover (deposed) object from an earlier create_before_destroy replacement that did not finish.`
    : `No line in this PR causes this ${what}.`;
  return finalize(change, [...scored.signals, signal("not-explained-by-diff", severity, reason)]);
}

/**
 * The same change scored with extra signals (rules that need the PR diff or the lineage, decided by
 * review.ts: prevent_destroy removed, provider-induced replacement, a dismissal by the AI review).
 * Severity and score are recomputed; duplicate signals are dropped.
 */
export function withSignals(
  scored: ScoredChange,
  extra: readonly RiskSignal[],
  /** "first": among signals of equal severity, the extra ones lead (they become the shown reason). */
  position: "first" | "last" = "last",
): ScoredChange {
  if (!extra.length) return scored;
  const all = position === "first" ? [...extra, ...scored.signals] : [...scored.signals, ...extra];
  return finalize(scored.change, all);
}

/** A short, stable grouping label for summaries ("tags only", "retention_in_days", "create aws_ssm_parameter"). */
export function changeKind(change: ResourceChange): string {
  switch (change.action) {
    case "create":
    case "delete":
    case "replace":
    case "forget":
    case "import":
      return `${change.action} ${change.type}`;
    case "read":
      return `read data.${change.type}`;
    case "move":
      return "moved";
    case "no-op":
      return "no change";
    case "update": {
      const paths = touchedPaths(change);
      if (!paths.length) return `update ${change.type}`;
      if (paths.every(isTagPath)) return "tags only";
      const attrs = [
        ...new Set(
          paths.filter((p) => !isTagPath(p)).map((p) => (typeof p[0] === "string" ? p[0] : formatPath(p))),
        ),
      ].sort();
      return attrs.join(", ");
    }
  }
}
