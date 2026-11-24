/*
 * Masks every sensitive or secret-looking value in a raw `terraform show -json` plan.
 *
 * `terraform show -json` prints sensitive values in clear text and its sensitivity marks are
 * incomplete (verified with terraform 1.10.5):
 * - change.before/after hold sensitive values verbatim; only *_sensitive says which ones;
 * - planned_values[].sensitive_values can miss marks the resource change has (an RDS `password`);
 * - a sensitive value copied into another attribute is not marked there (terraform_data `output`
 *   repeats a sensitive `input` unmarked in change.before and prior_state);
 * - plan.variables, configuration variable defaults and output_changes print sensitive values;
 * - configuration expressions print constants, provider credentials included (access_key/secret_key).
 * Providers also over-mark: aws_ssm_parameter.value is sensitive even for plain queue names and URLs.
 * So masking runs in three passes over a deep copy:
 *   1. marks: every path marked in *_sensitive / sensitive_values (resource changes and drift),
 *      sensitive outputs (marks or `sensitive = true`), sensitive root variables (value and
 *      default), module-call constants that feed a sensitive child variable, and credential-named
 *      provider_config constants;
 *   2. names: string values under credential-like names (isCredentialName / isSecretAssignment);
 *   3. sweep (value equality): Terraform leaves derived copies of sensitive values unmarked, so a
 *      string equal to a value hidden by pass 1 (at least 4 characters) is hidden anywhere in the
 *      document, and one of at least 8 characters also inside longer strings (escaped as JSON or
 *      HCL, too: scrub.ts encodedForms; a multi-line value's lines when all appear in a row, or a
 *      single line that holds a secret itself, never one it shares with ordinary scripts:
 *      createLineMatcher). Values hidden only by
 *      the name heuristic of pass 2 are swept within their own resource, and document-wide when
 *      they look like secrets. Structural fields (addresses, types, names, references, paths) are
 *      never rewritten. Then every remaining string goes through redactSecrets.
 * The swept values are returned too (maskPlanJsonWithSecrets), so text that never was in the plan
 * (source snippets, the PR diff, model output) can be scrubbed of them before it leaves the process.
 *
 * Plan JSON fields relied on: resource_changes[] / resource_drift[] .address .deposed
 * .change{before, after, before_sensitive, after_sensitive}; prior_state.values and planned_values
 * {outputs{sensitive, value}, root_module{resources[]{address, deposed_key, values,
 * sensitive_values}, child_modules[]}}; output_changes{name: {before, after, before_sensitive,
 * after_sensitive}}; variables{name: {value}}; configuration.root_module{variables{name: {default,
 * sensitive}}, outputs{name: {sensitive, expression}}, module_calls{name: {expressions, module}},
 * resources[].expressions}; configuration.provider_config{key: {expressions}}.
 */
import { isCredentialName, isSecretAssignment, isSettingValue, redactSecrets } from "../redact.js";
import {
  createFormMatcher,
  createLineMatcher,
  encodedForms,
  isDistinctive,
  type FormMatcher,
  type LineMatcher,
} from "../scrub.js";
import { SENSITIVE_PLACEHOLDER } from "../types.js";

export { isCredentialName } from "../redact.js";

type Json = Record<string, unknown>;

/** Deeper structures are replaced by the placeholder (fail closed); real plans are far shallower. */
const MAX_DEPTH = 256;
/** Hidden values shorter than this are not swept elsewhere: too likely to hit unrelated strings. */
const MIN_SWEEP_EXACT = 4;
/** Hidden values at least this long are also replaced inside longer strings (connection strings, URLs). */
const MIN_SWEEP_SUBSTRING = 8;
/** Keys under a credential-named entry whose content is that credential's value. */
const VALUE_WRAPPERS = new Set(["constant_value", "default", "value", "before", "after"]);

function isObject(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** The strings hidden in one scope (a resource, or the rest of the document). */
class Hidden {
  readonly values = new Set<string>();

  /** `also` receives every value added here too (pass 1 feeds the document-wide set). */
  constructor(private readonly also: readonly Hidden[] = []) {}

  addAll(value: unknown, depth = 0): void {
    if (typeof value === "string") {
      if (value !== SENSITIVE_PLACEHOLDER && value.length >= MIN_SWEEP_EXACT) {
        this.values.add(value);
        for (const h of this.also) h.values.add(value);
      }
    } else if (depth < MAX_DEPTH && value !== null && typeof value === "object") {
      for (const v of Object.values(value)) this.addAll(v, depth + 1);
    }
  }
}

/**
 * Fields that hold structure, not values, outside value subtrees (VALUE_KEYS): addresses, names,
 * types, references, attribute paths. Terraform never puts a sensitive value in them (sensitive
 * values cannot be for_each keys), and rewriting them would break every lookup by address.
 */
const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  "address",
  "previous_address",
  "module_address",
  "mode",
  "type",
  "name",
  "index",
  "provider_name",
  "provider_config_key",
  "deposed",
  "deposed_key",
  "action_reason",
  "actions",
  "references",
  "replace_paths",
  "relevant_attributes",
  "resource",
  "attribute",
  "source",
  "version_constraint",
  "format_version",
  "terraform_version",
  "full_name",
]);

/**
 * Copy of `value` with every path marked `true` in `marks` (a before_sensitive / after_sensitive /
 * sensitive_values structure) replaced by SENSITIVE_PLACEHOLDER. A `true` mark hides the whole
 * subtree; null stays null (nothing is set, nothing to hide). Never throws.
 */
export function maskSensitive(value: unknown, marks: unknown): unknown {
  try {
    return maskMarked(copyJson(value), marks, new Hidden(), 0);
  } catch {
    return SENSITIVE_PLACEHOLDER;
  }
}

function maskMarked(value: unknown, marks: unknown, hidden: Hidden, depth: number): unknown {
  if (marks === true) {
    if (value === null || value === undefined) return value;
    hidden.addAll(value);
    return SENSITIVE_PLACEHOLDER;
  }
  if (depth >= MAX_DEPTH) return SENSITIVE_PLACEHOLDER;
  if (Array.isArray(value) && Array.isArray(marks)) {
    return value.map((v, i) => maskMarked(v, marks[i], hidden, depth + 1));
  }
  if (isObject(value) && isObject(marks)) {
    const out: Json = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskMarked(v, marks[k], hidden, depth + 1);
    return out;
  }
  return value;
}

/** JSON-shaped deep copy: drops functions/symbols, breaks cycles, caps depth. */
function copyJson(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") {
    return typeof value === "function" || typeof value === "symbol" || typeof value === "bigint"
      ? null
      : value;
  }
  if (depth >= MAX_DEPTH || seen.has(value)) return SENSITIVE_PLACEHOLDER;
  seen.add(value);
  let out: unknown;
  if (Array.isArray(value)) out = value.map((v) => copyJson(v, depth + 1, seen));
  else {
    const obj: Json = {};
    for (const [k, v] of Object.entries(value)) obj[k] = copyJson(v, depth + 1, seen);
    out = obj;
  }
  seen.delete(value);
  return out;
}

/** One resource instance: its values in resource_changes, resource_drift, prior_state, planned_values. */
interface ResourceScope {
  address: string;
  hidden: Hidden;
  /** Objects whose listed keys hold this resource's values. */
  slots: { holder: Json; key: string }[];
}

class Scopes {
  private readonly byKey = new Map<string, ResourceScope>();

  get(address: unknown, deposed: unknown): ResourceScope {
    const key = `${typeof address === "string" ? address : "?"}\u0000${typeof deposed === "string" ? deposed : ""}`;
    let scope = this.byKey.get(key);
    if (!scope) {
      scope = { address: typeof address === "string" ? address : "?", hidden: new Hidden(), slots: [] };
      this.byKey.set(key, scope);
    }
    return scope;
  }

  all(): Iterable<ResourceScope> {
    return this.byKey.values();
  }
}

/**
 * Deep copy of a raw plan with every sensitive value, credential-like value and secret-looking
 * string hidden (see the top of this file). Shape is preserved except that a hidden subtree becomes
 * the placeholder string. Never throws: odd input is copied and redacted as far as it goes.
 */
export function maskPlanJson(raw: unknown): unknown {
  return maskPlanJsonWithSecrets(raw).masked;
}

/**
 * maskPlanJson, plus the values it swept document-wide (every value hidden by a sensitivity mark,
 * and the secret-looking ones hidden by name). Callers use them to scrub text from outside the plan;
 * they must never be printed. On a failure the result is null and the set is empty.
 */
export function maskPlanJsonWithSecrets(raw: unknown): { masked: unknown; secrets: Set<string> } {
  try {
    const doc = copyJson(raw);
    const scopes = new Scopes();
    const marked = new Hidden();
    const docHidden = new Hidden();
    if (isObject(doc)) {
      maskByMarks(doc, scopes, docHidden, marked);
      for (const scope of scopes.all()) {
        for (const { holder, key } of scope.slots) {
          holder[key] = maskByName(holder[key], null, scope.hidden, 0);
        }
      }
      maskByName(doc, null, docHidden, 0);
    }
    const everywhere = new Set([...marked.values].filter(isSweepable));
    for (const v of docHidden.values) if (isDistinctive(v)) everywhere.add(v);
    for (const scope of scopes.all()) {
      for (const v of scope.hidden.values) if (isDistinctive(v)) everywhere.add(v);
      const local = new Sweeper(scope.hidden.values, false);
      for (const { holder, key } of scope.slots) holder[key] = sweep(holder[key], local, 0, true);
    }
    return { masked: sweep(doc, new Sweeper(everywhere, true), 0), secrets: everywhere };
  } catch {
    return { masked: null, secrets: new Set() };
  }
}

/** Parameter types AWS stores and returns in plain text (SecureString is the secret type). */
const PLAIN_PARAMETER_TYPES = new Set(["String", "StringList"]);

/**
 * The one known schema over-mark: aws_ssm_parameter.value is always marked sensitive, even for a
 * plain String parameter holding a queue name or a database identifier. Such values stay hidden
 * where they are marked but are not swept document-wide (that would blank every resource named the
 * same). A sensitive value copied into one still comes from a marked variable or attribute, which
 * is swept.
 */
function plainParameterAddresses(doc: Json): Set<string> {
  const out = new Set<string>();
  const list = doc.resource_changes;
  if (!Array.isArray(list)) return out;
  for (const rc of list) {
    if (!isObject(rc) || rc.type !== "aws_ssm_parameter" || typeof rc.address !== "string") continue;
    const change = isObject(rc.change) ? rc.change : {};
    const types = [change.before, change.after].map((v) => (isObject(v) ? v.type : undefined));
    const known = types.filter((t) => t !== undefined && t !== null);
    if (known.length && known.every((t) => typeof t === "string" && PLAIN_PARAMETER_TYPES.has(t)))
      out.add(rc.address);
  }
  return out;
}

/** Marked values worth sweeping everywhere: long enough, and not a setting keyword ("enabled"). */
function isSweepable(value: string): boolean {
  return value.length >= MIN_SWEEP_EXACT && !isSettingValue(value);
}

// ───────────────────────────── pass 1: marks ─────────────────────────────

function maskByMarks(doc: Json, scopes: Scopes, docHidden: Hidden, marked: Hidden): void {
  const changeMarks = new Map<string, { before: unknown; after: unknown }>();
  // Pass-1 values go to their own scope and to the document-wide set.
  const docMarked = new Hidden([docHidden, marked]);
  const scopeMarked = new Map<ResourceScope, Hidden>();
  const plain = plainParameterAddresses(doc);
  const markedIn = (scope: ResourceScope): Hidden => {
    let h = scopeMarked.get(scope);
    if (!h) {
      h = plain.has(scope.address) ? new Hidden([scope.hidden]) : new Hidden([scope.hidden, marked]);
      scopeMarked.set(scope, h);
    }
    return h;
  };
  for (const key of ["resource_changes", "resource_drift"]) {
    const list = doc[key];
    if (!Array.isArray(list)) continue;
    for (const rc of list) {
      if (!isObject(rc) || !isObject(rc.change)) continue;
      const change = rc.change;
      const scope = scopes.get(rc.address, rc.deposed);
      change.before = maskMarked(change.before, change.before_sensitive, markedIn(scope), 0);
      change.after = maskMarked(change.after, change.after_sensitive, markedIn(scope), 0);
      scope.slots.push({ holder: change, key: "before" }, { holder: change, key: "after" });
      if (key === "resource_changes" && typeof rc.address === "string" && rc.deposed === undefined) {
        changeMarks.set(rc.address, { before: change.before_sensitive, after: change.after_sensitive });
      }
    }
  }

  // prior_state is the "before" side of the changes, planned_values the "after" side.
  if (isObject(doc.prior_state)) {
    maskStateValues(doc.prior_state.values, changeMarks, "before", scopes, docMarked, markedIn);
  }
  maskStateValues(doc.planned_values, changeMarks, "after", scopes, docMarked, markedIn);

  const config = isObject(doc.configuration) ? doc.configuration : undefined;
  const rootModule = config && isObject(config.root_module) ? config.root_module : undefined;
  const rootOutputs = rootModule && isObject(rootModule.outputs) ? rootModule.outputs : {};
  if (isObject(doc.output_changes)) {
    for (const [name, oc] of Object.entries(doc.output_changes)) {
      if (!isObject(oc)) continue;
      const decl = rootOutputs[name];
      const declared = isObject(decl) && decl.sensitive === true;
      oc.before = maskMarked(oc.before, declared || oc.before_sensitive, docMarked, 0);
      oc.after = maskMarked(oc.after, declared || oc.after_sensitive, docMarked, 0);
    }
  }

  const rootVars = rootModule?.variables;
  if (isObject(doc.variables) && isObject(rootVars)) {
    for (const [name, v] of Object.entries(doc.variables)) {
      const decl = rootVars[name];
      if (isObject(v) && isObject(decl) && decl.sensitive === true) {
        v.value = maskMarked(v.value, true, docMarked, 0);
      }
    }
  }
  if (rootModule) maskConfigModule(rootModule, docMarked, 0);
  if (config && isObject(config.provider_config)) {
    for (const p of Object.values(config.provider_config)) {
      if (isObject(p) && isObject(p.expressions)) maskCredentialConstants(p.expressions, docMarked, 0);
    }
  }
}

/**
 * Provider arguments are printed as constants (`access_key = "…"`): every credential-named
 * constant, nested blocks (`assume_role { … }`) included, is hidden and swept document-wide.
 */
function maskCredentialConstants(expressions: Json, hidden: Hidden, depth: number): void {
  if (depth >= MAX_DEPTH) return;
  for (const [key, expr] of Object.entries(expressions)) {
    if (Array.isArray(expr)) {
      for (const block of expr) if (isObject(block)) maskCredentialConstants(block, hidden, depth + 1);
    } else if (isObject(expr) && "constant_value" in expr) {
      const value = expr.constant_value;
      const credential =
        typeof value === "string" ? isSecretAssignment(key, value) : isCredentialName(key) && value !== null;
      if (credential) expr.constant_value = maskMarked(value, true, hidden, 0);
    }
  }
}

function maskStateValues(
  values: unknown,
  changeMarks: Map<string, { before: unknown; after: unknown }>,
  side: "before" | "after",
  scopes: Scopes,
  docHidden: Hidden,
  markedIn: (scope: ResourceScope) => Hidden,
): void {
  if (!isObject(values)) return;
  if (isObject(values.outputs)) {
    for (const o of Object.values(values.outputs)) {
      if (isObject(o) && o.sensitive === true) o.value = maskMarked(o.value, true, docHidden, 0);
    }
  }
  const walkModule = (mod: unknown, depth: number): void => {
    if (!isObject(mod) || depth >= MAX_DEPTH) return;
    if (Array.isArray(mod.resources)) {
      for (const r of mod.resources) {
        if (!isObject(r)) continue;
        const scope = scopes.get(r.address, r.deposed_key);
        r.values = maskMarked(r.values, r.sensitive_values, markedIn(scope), 0);
        const marks = typeof r.address === "string" ? changeMarks.get(r.address) : undefined;
        if (marks && r.deposed_key === undefined)
          r.values = maskMarked(r.values, marks[side], markedIn(scope), 0);
        scope.slots.push({ holder: r, key: "values" });
      }
    }
    if (Array.isArray(mod.child_modules)) for (const c of mod.child_modules) walkModule(c, depth + 1);
  };
  walkModule(values.root_module, 0);
}

/**
 * Sensitive variable defaults, sensitive output expressions, and module-call constants feeding a
 * sensitive variable of the child module, recursively through module calls.
 */
function maskConfigModule(mod: Json, hidden: Hidden, depth: number): void {
  if (depth >= MAX_DEPTH) return;
  if (isObject(mod.variables)) {
    for (const v of Object.values(mod.variables)) {
      if (isObject(v) && v.sensitive === true && "default" in v) {
        v.default = maskMarked(v.default, true, hidden, 0);
      }
    }
  }
  if (isObject(mod.outputs)) {
    for (const o of Object.values(mod.outputs)) {
      if (isObject(o) && o.sensitive === true && isObject(o.expression) && "constant_value" in o.expression) {
        o.expression.constant_value = maskMarked(o.expression.constant_value, true, hidden, 0);
      }
    }
  }
  if (isObject(mod.module_calls)) {
    for (const call of Object.values(mod.module_calls)) {
      if (!isObject(call)) continue;
      const child = isObject(call.module) ? call.module : undefined;
      const childVars = child && isObject(child.variables) ? child.variables : {};
      if (isObject(call.expressions)) {
        for (const [name, expr] of Object.entries(call.expressions)) {
          const decl = childVars[name];
          if (isObject(decl) && decl.sensitive === true && isObject(expr) && "constant_value" in expr) {
            expr.constant_value = maskMarked(expr.constant_value, true, hidden, 0);
          }
        }
      }
      if (child) maskConfigModule(child, hidden, depth + 1);
    }
  }
}

// ───────────────────────────── pass 2: names ─────────────────────────────

/**
 * Walk everything; a string under a credential-like key is hidden. `credential` carries the
 * credential name through value wrappers (`password: {constant_value: "…"}`, `db_password: {value}`,
 * `api_token: {default}`, an output `{before, after}`) and through lists of strings.
 */
function maskByName(node: unknown, credential: string | null, hidden: Hidden, depth: number): unknown {
  if (depth >= MAX_DEPTH) return SENSITIVE_PLACEHOLDER;
  if (typeof node === "string") {
    if (credential !== null && isSecretAssignment(credential, node)) {
      hidden.addAll(node);
      return SENSITIVE_PLACEHOLDER;
    }
    return node;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const item: unknown = node[i];
      // A list under a credential name: hide its strings, but objects inside are judged by their own keys.
      node[i] = maskByName(item, typeof item === "string" ? credential : null, hidden, depth + 1);
    }
    return node;
  }
  if (!isObject(node)) return node;
  for (const [key, value] of Object.entries(node)) {
    let next: string | null = null;
    if (credential !== null && VALUE_WRAPPERS.has(key)) next = credential;
    else if (typeof value === "string" ? isSecretAssignment(key, value) : isCredentialName(key)) next = key;
    node[key] = maskByName(value, next, hidden, depth + 1);
  }
  return node;
}

// ───────────────────────────── pass 3: sweep ─────────────────────────────

/** Replaces hidden values in other strings: exact matches, and long values inside longer strings. */
class Sweeper {
  private readonly exact: ReadonlySet<string>;
  /** Longest first, so a value containing another is replaced whole. */
  private readonly inner: FormMatcher;
  /** Lines of multi-line values: all in a row, or a secret one alone (scrub.ts isSecretLine). */
  private readonly lines: LineMatcher;

  constructor(
    hidden: ReadonlySet<string>,
    /** Also redact secret formats (the final, document-wide sweep). */
    private readonly redact: boolean,
  ) {
    this.exact = hidden;
    // Encoded forms too: a jsonencode()d or heredoc copy holds the value escaped.
    this.inner = createFormMatcher(
      [...hidden].filter((v) => v.length >= MIN_SWEEP_SUBSTRING).flatMap(encodedForms),
    );
    this.lines = createLineMatcher(hidden);
  }

  string(value: string): string {
    if (value === SENSITIVE_PLACEHOLDER || value === "") return value;
    if (this.exact.has(value)) return SENSITIVE_PLACEHOLDER;
    const out = this.lines.text(this.inner.replace(value, () => SENSITIVE_PLACEHOLDER));
    return this.redact ? redactSecrets(out).text : out;
  }

  formatsOnly(value: string): string {
    return this.redact && value !== "" ? redactSecrets(value).text : value;
  }
}

/**
 * Keys whose subtree is data (resource values, constants, defaults, variable and output values):
 * every string below them is swept, whatever its key. `values` counts only on a resource record.
 */
const VALUE_KEYS: ReadonlySet<string> = new Set([
  "before",
  "after",
  "constant_value",
  "default",
  "value",
  "generated_config",
]);

function sweep(node: unknown, sweeper: Sweeper, depth: number, inValue = false): unknown {
  if (typeof node === "string") return sweeper.string(node);
  if (depth >= MAX_DEPTH) return SENSITIVE_PLACEHOLDER;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) node[i] = sweep(node[i], sweeper, depth + 1, inValue);
    return node;
  }
  if (isObject(node)) {
    const resource = !inValue && typeof node.address === "string";
    for (const [k, v] of Object.entries(node)) {
      if (inValue || VALUE_KEYS.has(k) || (resource && k === "values"))
        node[k] = sweep(v, sweeper, depth + 1, true);
      else if (STRUCTURAL_KEYS.has(k)) node[k] = sweepStructural(v, sweeper, depth + 1);
      else node[k] = sweep(v, sweeper, depth + 1, false);
    }
  }
  return node;
}

/** Structural strings are only checked for secret formats, never for hidden values. */
function sweepStructural(node: unknown, sweeper: Sweeper, depth: number): unknown {
  if (typeof node === "string") return sweeper.formatsOnly(node);
  if (depth >= MAX_DEPTH) return node;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) node[i] = sweepStructural(node[i], sweeper, depth + 1);
    return node;
  }
  return isObject(node) ? sweep(node, sweeper, depth) : node;
}
