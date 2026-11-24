/*
 * Loads `terraform show -json <planfile>` output into a PlanModel. Paths are computed on the raw
 * values, then the whole document is masked (plan/mask.ts) and the model is built from the masked
 * copy only, so no raw value ever leaves this module.
 *
 * Plan JSON fields relied on (format_version 0.1 – 1.2, Terraform and OpenTofu):
 * - format_version, terraform_version, errored;
 * - resource_changes[] / resource_drift[]: address, previous_address, module_address, mode, type,
 *   name, index, deposed, provider_name, action_reason, change{actions, before, after,
 *   after_unknown, before_sensitive, after_sensitive, replace_paths, importing{id}};
 * - output_changes{name: {actions, before_sensitive, after_sensitive}};
 * - variables{name: {value}};
 * - configuration.provider_config{key: {version_constraint}};
 * - configuration.root_module (recursively through module_calls[].module): resources[]{address,
 *   mode, type, name, expressions, count_expression, for_each_expression}, module_calls{name:
 *   {source, version, expressions, count_expression, for_each_expression, module}},
 *   variables{name: {default, sensitive, description}}, outputs{name: {expression, sensitive}}.
 * Verified with terraform 1.10.5: ["create","delete"] for create_before_destroy, ["forget"] for a
 * `removed` block with destroy = false, ["no-op"] + previous_address for `moved`, ["no-op"|"update"]
 * + change.importing for `import` blocks, ["read"] for data sources deferred to apply.
 */
import { deepEqual, diffPaths, formatPath, getAtPath, parseAddress } from "./paths.js";
import { alignBefore } from "./align.js";
import { maskPlanJsonWithSecrets } from "./mask.js";
import type {
  Action,
  AttrPath,
  ConfigModule,
  ConfigModuleCall,
  ConfigResource,
  Expression,
  OutputChange,
  PlanModel,
  ResourceChange,
} from "../types.js";

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

type Json = Record<string, unknown>;

const MAX_MODULE_DEPTH = 64;
/** How many `{` line starts parsePlanText tries before giving up on noisy input. */
const MAX_JSON_CANDIDATES = 50;

function isObject(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

// ───────────────────────────── parsePlanText ─────────────────────────────

const UTF16_MESSAGE =
  "The plan file is UTF-16 encoded (Windows PowerShell 5.1 `>` writes UTF-16). Write it as UTF-8: `terraform show -json plan.out | Out-File -Encoding utf8 plan.json`, or run the step with PowerShell 7 (`shell: pwsh`).";

/**
 * Decode the bytes of a plan file: UTF-8 (with or without a BOM), or UTF-16 LE/BE, which Windows
 * PowerShell 5.1 `>` redirection writes (recognised by its BOM or by NUL bytes in the first
 * characters).
 */
export function decodePlanBytes(bytes: Uint8Array): string {
  const [b0, b1] = bytes;
  if (b0 === 0xff && b1 === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (b0 === 0xfe && b1 === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  if (bytes.length >= 2 && b0 !== 0 && b1 === 0) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes.length >= 2 && b0 === 0 && b1 !== 0) return new TextDecoder("utf-16be").decode(bytes);
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Parse the text of `terraform show -json plan.out` (or the file's raw bytes: see
 * decodePlanBytes). Tolerates the hashicorp/setup-terraform wrapper's noise around the JSON
 * (`[command]…/terraform-bin show -json plan.out`, `::debug::…` lines, trailing stderr / exit-code
 * lines) by locating the JSON object. Throws PlanError with a fix-it message for a binary plan
 * file, UTF-16 text read as UTF-8, human-readable plan text, state JSON, invalid JSON, or empty
 * input.
 */
export function parsePlanText(input: string | Uint8Array): unknown {
  const text = typeof input === "string" ? input : decodePlanBytes(input);
  // trim() also drops a UTF-8 BOM (PowerShell redirection writes one).
  const trimmed = text.trim();
  if (!trimmed)
    throw new PlanError("The plan input is empty. Pass the output of `terraform show -json <planfile>`.");
  if (trimmed.startsWith("PK")) {
    throw new PlanError(
      "This is a binary plan file (terraform plan -out). Convert it first: `terraform show -json <planfile> > plan.json`.",
    );
  }
  // UTF-16 bytes decoded as UTF-8 keep a NUL after (or before) every ASCII character. JSON text
  // never holds a raw NUL, so this is not a plan as given.
  if (trimmed.slice(0, 256).includes("\u0000")) throw new PlanError(UTF16_MESSAGE);
  let parseError: string | undefined;
  try {
    return checkNotState(JSON.parse(trimmed) as unknown);
  } catch (err) {
    if (err instanceof PlanError) throw err;
    // Only the position: newer V8 messages quote the input, which may hold secrets.
    const at = err instanceof Error ? /position (\d+)/.exec(err.message)?.[1] : undefined;
    parseError = at === undefined ? "unexpected content" : `at character ${at}`;
    // fall through to locating the JSON inside wrapper noise
  }
  const found = locateJson(trimmed);
  if (found !== undefined) return checkNotState(found);
  if (looksLikeHumanPlan(trimmed)) {
    throw new PlanError(
      "This is human-readable plan output, not JSON. Use `terraform show -json <planfile>` (with setup-terraform, set terraform_wrapper: false or strip its log lines).",
    );
  }
  if (trimmed.startsWith("{")) {
    throw new PlanError(`The plan JSON is invalid or truncated (${parseError}).`);
  }
  throw new PlanError(
    "Could not find a JSON plan in the input. Pass the output of `terraform show -json <planfile>`.",
  );
}

const STATE_MESSAGE =
  "This is Terraform state, not a plan. Run `terraform plan -out=plan.out` and pass `terraform show -json plan.out`.";

/** `terraform show -json` of state has `values`; a raw .tfstate has `lineage` + `resources`. */
function isState(json: Json): boolean {
  return (
    !("resource_changes" in json) &&
    !("planned_values" in json) &&
    ("values" in json || ("resources" in json && "lineage" in json))
  );
}

function checkNotState(json: unknown): unknown {
  if (isObject(json) && isState(json)) throw new PlanError(STATE_MESSAGE);
  return json;
}

/** The first `{…}` that starts a line and parses to an object; plan-shaped objects win. */
function locateJson(text: string): unknown {
  let fallback: unknown;
  let tried = 0;
  const lineStart = /^[ \t]*\{/gm;
  let m: RegExpExecArray | null;
  while ((m = lineStart.exec(text)) !== null && tried < MAX_JSON_CANDIDATES) {
    tried++;
    const start = m.index + m[0].length - 1;
    const end = matchingBrace(text, start);
    if (end < 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      continue;
    }
    if (!isObject(parsed)) continue;
    if ("format_version" in parsed) return parsed;
    // Indented objects are usually pieces of a broken pretty-printed document, not the answer.
    if (m[0] === "{") fallback ??= parsed;
    lineStart.lastIndex = end + 1;
  }
  return fallback;
}

/** Index of the `}` closing the object at `start`, skipping strings; -1 when unbalanced. */
function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (inString) {
      if (ch === 0x5c) i++;
      else if (ch === 0x22) inString = false;
    } else if (ch === 0x22) inString = true;
    else if (ch === 0x7b) depth++;
    else if (ch === 0x7d && --depth === 0) return i;
  }
  return -1;
}

function looksLikeHumanPlan(text: string): boolean {
  return /Terraform (?:will perform the following actions|used the selected providers)|OpenTofu (?:will perform|used the selected providers)|^\s*# \S+ (?:will be|must be|has been)|^Plan: \d+ to add|^No changes\. /m.test(
    text,
  );
}

// ───────────────────────────── loadPlan ─────────────────────────────

/**
 * Validate and normalize a parsed plan. Paths (changed / unknown / sensitive-changed) are computed
 * on the unmasked values; every value in the result comes from the masked copy.
 */
export function loadPlan(json: unknown): PlanModel {
  validate(json);
  const raw = alignNestedBlocks(json);
  const rawChanges = Array.isArray(raw.resource_changes) ? raw.resource_changes : [];
  const rawDrift = Array.isArray(raw.resource_drift) ? raw.resource_drift : [];
  const changePaths = rawChanges.map(rawPaths);
  const driftPaths = rawDrift.map(rawPaths);

  const { masked, secrets } = maskPlanJsonWithSecrets(raw);
  if (!isObject(masked)) throw new PlanError("The plan could not be masked; refusing to continue.");
  const maskedChanges = Array.isArray(masked.resource_changes) ? masked.resource_changes : [];
  const maskedDrift = Array.isArray(masked.resource_drift) ? masked.resource_drift : [];

  const changes = toChanges(maskedChanges, changePaths);
  const drift = toChanges(maskedDrift, driftPaths);
  const config = isObject(masked.configuration) ? masked.configuration : {};
  const rootConfig = isObject(config.root_module) ? config.root_module : {};

  const counts: PlanModel["counts"] = {};
  for (const c of changes) {
    if (c.action === "no-op") continue;
    counts[c.action] = (counts[c.action] ?? 0) + 1;
    // As in Terraform's own "Plan:" line, a forget that also creates (["forget","create"]) is one
    // forget and one create, and an import that also updates is one import and one change.
    const also =
      c.action === "forget" && c.actions.includes("create")
        ? "create"
        : c.action === "import" && c.actions.includes("update")
          ? "update"
          : null;
    if (also) counts[also] = (counts[also] ?? 0) + 1;
  }

  const deferred = Array.isArray(raw.deferred_changes) ? raw.deferred_changes.length : 0;
  const plan: PlanModel = {
    formatVersion: String(raw.format_version),
    terraformVersion: str(raw.terraform_version) ?? "unknown",
    changes,
    drift,
    outputChanges: toOutputChanges(masked.output_changes, rootConfig),
    variables: toVariables(masked.variables, rootConfig),
    modules: buildModules(rootConfig),
    providerConstraints: toProviderConstraints(config.provider_config),
    errored: raw.errored === true,
    // Deferred changes make a plan partial even where `complete` is missing.
    ...(typeof raw.complete === "boolean" || deferred > 0
      ? { complete: raw.complete !== false && deferred === 0 }
      : {}),
    ...(typeof raw.applyable === "boolean" && { applyable: raw.applyable }),
    deferredChanges: deferred,
    counts,
    ...(!isObject(raw.configuration) && { configurationMissing: true }),
  };
  PLAN_SECRETS.set(plan, secrets);
  return plan;
}

/**
 * A shallow copy of the plan whose changes have `before` lined up with `after` (see align.ts), so
 * a set of nested blocks that Terraform listed in another order does not look like an edit to
 * every element. The input is not modified.
 */
function alignNestedBlocks(json: Json): Json {
  const fix = (list: unknown): unknown => {
    if (!Array.isArray(list)) return list;
    let copied: unknown[] | null = null;
    list.forEach((rc, i) => {
      if (!isObject(rc) || !isObject(rc.change)) return;
      const ch = rc.change;
      if (!Array.isArray(ch.before) && !isObject(ch.before)) return;
      const aligned = alignBefore(ch.before, ch.after, ch.before_sensitive);
      if (aligned.before === ch.before && aligned.beforeSensitive === ch.before_sensitive) return;
      copied ??= [...list];
      copied[i] = {
        ...rc,
        change: { ...ch, before: aligned.before, before_sensitive: aligned.beforeSensitive },
      };
    });
    return copied ?? list;
  };
  const changes = fix(json.resource_changes);
  const drift = fix(json.resource_drift);
  if (changes === json.resource_changes && drift === json.resource_drift) return json;
  return {
    ...json,
    ...(changes !== undefined && { resource_changes: changes }),
    ...(drift !== undefined && { resource_drift: drift }),
  };
}

/** Values the masking swept document-wide, per loaded plan. Kept off the model so it never serializes. */
const PLAN_SECRETS = new WeakMap<PlanModel, ReadonlySet<string>>();

/**
 * The sensitive values hidden in `plan` (raw text, never to be printed). Text from outside the plan
 * (source files, the PR diff, model output) is scrubbed of them before it leaves the process. Empty
 * for a PlanModel that loadPlan did not build.
 */
export function planSecrets(plan: PlanModel): ReadonlySet<string> {
  return PLAN_SECRETS.get(plan) ?? new Set();
}

function validate(json: unknown): asserts json is Json {
  if (!isObject(json)) {
    throw new PlanError("The plan JSON must be an object (the output of `terraform show -json <planfile>`).");
  }
  const hasChanges = "resource_changes" in json;
  const hasPlanned = "planned_values" in json;
  if (!hasChanges && !hasPlanned) {
    if (isState(json)) throw new PlanError(STATE_MESSAGE);
    throw new PlanError(
      "Not a Terraform plan: no resource_changes or planned_values. Pass `terraform show -json <planfile>`.",
    );
  }
  if (typeof json.format_version !== "string" && typeof json.format_version !== "number") {
    throw new PlanError("Not a Terraform plan: format_version is missing.");
  }
  // A new major may move or rename fields (docs/research-plan-json.md); any 0.x / 1.x minor is fine.
  const major = Number(/^\s*(\d+)/.exec(String(json.format_version))?.[1] ?? NaN);
  if (major !== 0 && major !== 1) {
    throw new PlanError(
      `Unsupported plan format_version ${JSON.stringify(String(json.format_version).slice(0, 20))}: this tool reads format 0.x and 1.x (Terraform 0.12+ and OpenTofu). Check for a newer tf-change-reviewer release.`,
    );
  }
  if (hasChanges && !Array.isArray(json.resource_changes)) {
    throw new PlanError("Malformed plan: resource_changes is not a list.");
  }
}

interface Paths {
  changed: AttrPath[];
  unknown: AttrPath[];
  sensitiveChanged: AttrPath[];
}

function rawPaths(rc: unknown): Paths {
  const change = isObject(rc) && isObject(rc.change) ? rc.change : {};
  const { changed, unknown } = diffPaths(change.before ?? null, change.after ?? null, change.after_unknown);
  const marks = [change.before_sensitive, change.after_sensitive];
  return {
    changed: truncateAtMarks(changed, marks),
    unknown: truncateAtMarks(unknown, marks),
    sensitiveChanged: sensitiveChangedPaths(change),
  };
}

/**
 * Paths inside a sensitive value end at the marked attribute: map keys and list lengths below it
 * are part of the hidden value.
 */
function truncateAtMarks(paths: AttrPath[], marks: unknown[]): AttrPath[] {
  const out = new Map<string, AttrPath>();
  for (const p of paths) {
    let cut = p;
    for (let n = 1; n < p.length; n++) {
      const prefix = p.slice(0, n);
      if (marks.some((m) => isMarked(m, prefix))) {
        cut = prefix;
        break;
      }
    }
    out.set(JSON.stringify(cut), cut);
  }
  return [...out.values()];
}

/**
 * Marked paths (either side) whose sensitivity changes, or whose hidden value changes or becomes
 * unknown. Only for updates and replacements: a create or delete changes every value anyway.
 */
function sensitiveChangedPaths(change: Json): AttrPath[] {
  const { before, after, before_sensitive: bs, after_sensitive: as, after_unknown: au } = change;
  if (before === null || before === undefined || after === null || after === undefined) return [];
  const marked = new Map<string, AttrPath>();
  for (const p of [...markedPaths(bs), ...markedPaths(as)]) marked.set(JSON.stringify(p), p);
  const out: AttrPath[] = [];
  for (const p of marked.values()) {
    const sensBefore = isMarked(bs, p);
    const sensAfter = isMarked(as, p);
    if (
      sensBefore !== sensAfter ||
      isMarked(au, p) ||
      !deepEqual(getAtPath(before, p) ?? null, getAtPath(after, p) ?? null)
    ) {
      out.push(p);
    }
  }
  return out.sort((a, b) => formatPath(a).localeCompare(formatPath(b)));
}

/** Paths where a marks structure is `true`. */
function markedPaths(marks: unknown, path: AttrPath = [], out: AttrPath[] = [], depth = 0): AttrPath[] {
  if (marks === true) {
    if (path.length) out.push(path);
  } else if (depth < 64 && Array.isArray(marks)) {
    marks.forEach((m, i) => markedPaths(m, [...path, i], out, depth + 1));
  } else if (depth < 64 && isObject(marks)) {
    for (const [k, m] of Object.entries(marks)) markedPaths(m, [...path, k], out, depth + 1);
  }
  return out;
}

/** True when `marks` is `true` at `path` or at one of its prefixes. */
function isMarked(marks: unknown, path: AttrPath): boolean {
  let cur = marks;
  for (const step of path) {
    if (cur === true) return true;
    if (typeof step === "number" ? !Array.isArray(cur) : !isObject(cur)) return false;
    cur = (cur as Record<string | number, unknown>)[step];
  }
  return cur === true;
}

function toChanges(list: unknown[], paths: Paths[]): ResourceChange[] {
  const out: ResourceChange[] = [];
  list.forEach((rc, i) => {
    if (!isObject(rc) || typeof rc.address !== "string") return;
    out.push(toChange(rc, paths[i] ?? { changed: [], unknown: [], sensitiveChanged: [] }));
  });
  return out;
}

function toChange(rc: Json, paths: Paths): ResourceChange {
  const address = rc.address as string;
  const parsed = parseAddress(address);
  const change = isObject(rc.change) ? rc.change : {};
  const actions = Array.isArray(change.actions) ? change.actions.filter((a) => typeof a === "string") : [];
  const importing = isObject(change.importing) ? change.importing : undefined;
  const previousAddress = str(rc.previous_address);
  const { action, replaceOrder } = normalizeAction(actions, {
    importing: importing !== undefined,
    moved: previousAddress !== undefined && previousAddress !== address,
  });
  const index = typeof rc.index === "number" || typeof rc.index === "string" ? rc.index : parsed.index;
  const mode = rc.mode === "data" || rc.mode === "managed" ? rc.mode : parsed.mode;
  const deposed = str(rc.deposed);
  const actionReason = str(rc.action_reason);
  return {
    address,
    moduleAddress: str(rc.module_address) ?? parsed.moduleAddress,
    configModulePath: parsed.configModulePath,
    mode,
    type: str(rc.type) ?? parsed.type,
    name: str(rc.name) ?? parsed.name,
    ...(index !== undefined && { index }),
    providerName: str(rc.provider_name) ?? "",
    ...(previousAddress !== undefined && { previousAddress }),
    ...(deposed !== undefined && { deposed }),
    actions,
    action,
    ...(replaceOrder && { replaceOrder }),
    ...(actionReason !== undefined && { actionReason }),
    replacePaths: toPaths(change.replace_paths),
    ...(importing && { importing: typeof importing.id === "string" ? { id: importing.id } : {} }),
    before: change.before ?? null,
    after: change.after ?? null,
    afterUnknown: change.after_unknown ?? {},
    changedPaths: paths.changed,
    unknownPaths: paths.unknown,
    sensitiveChangedPaths: paths.sensitiveChanged,
  };
}

/**
 * Raw actions → normalized Action. Anything containing "forget" is a forget; an unknown
 * combination counts as an update so it is reviewed rather than hidden.
 */
export function normalizeAction(
  actions: readonly string[],
  opts: { importing?: boolean; moved?: boolean } = {},
): { action: Action; replaceOrder?: "destroy-before-create" | "create-before-destroy" } {
  const key = actions.join(",");
  if (actions.includes("forget")) return { action: "forget" };
  if (key === "delete,create") return { action: "replace", replaceOrder: "destroy-before-create" };
  if (key === "create,delete") return { action: "replace", replaceOrder: "create-before-destroy" };
  if (key === "create") return { action: "create" };
  if (key === "delete") return { action: "delete" };
  if (key === "read") return { action: "read" };
  if (key === "update") return { action: opts.importing ? "import" : "update" };
  if (key === "no-op" || key === "") {
    if (opts.importing) return { action: "import" };
    if (opts.moved) return { action: "move" };
    return { action: "no-op" };
  }
  const del = actions.indexOf("delete");
  const create = actions.indexOf("create");
  if (del >= 0 && create >= 0) {
    return {
      action: "replace",
      replaceOrder: del < create ? "destroy-before-create" : "create-before-destroy",
    };
  }
  if (del >= 0) return { action: "delete" };
  if (create >= 0) return { action: "create" };
  return { action: "update" };
}

function toPaths(v: unknown): AttrPath[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((p): p is unknown[] => Array.isArray(p))
    .map((p) => p.filter((s): s is string | number => typeof s === "string" || typeof s === "number"))
    .filter((p) => p.length > 0);
}

function toOutputChanges(v: unknown, rootConfig: Json): OutputChange[] {
  if (!isObject(v)) return [];
  const declared = isObject(rootConfig.outputs) ? rootConfig.outputs : {};
  return Object.entries(v).map(([name, oc]) => {
    const o = isObject(oc) ? oc : {};
    const decl = declared[name];
    const actions = Array.isArray(o.actions) ? o.actions.filter((a) => typeof a === "string") : [];
    const sensitive =
      containsTrue(o.before_sensitive) ||
      containsTrue(o.after_sensitive) ||
      (isObject(decl) && decl.sensitive === true);
    return { name, actions, sensitive };
  });
}

function containsTrue(v: unknown, depth = 0): boolean {
  if (v === true) return true;
  if (depth > 64 || v === null || typeof v !== "object") return false;
  return Object.values(v).some((x) => containsTrue(x, depth + 1));
}

function toVariables(v: unknown, rootConfig: Json): PlanModel["variables"] {
  const out: PlanModel["variables"] = {};
  if (!isObject(v)) return out;
  const declared = isObject(rootConfig.variables) ? rootConfig.variables : {};
  for (const [name, entry] of Object.entries(v)) {
    const decl = declared[name];
    out[name] = {
      value: isObject(entry) ? (entry.value ?? null) : null,
      sensitive: isObject(decl) && decl.sensitive === true,
    };
  }
  return out;
}

function toProviderConstraints(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObject(v)) return out;
  for (const [key, p] of Object.entries(v)) {
    if (isObject(p) && typeof p.version_constraint === "string") out[key] = p.version_constraint;
  }
  return out;
}

// ───────────────────────────── configuration index ─────────────────────────────

function buildModules(root: Json): Record<string, ConfigModule> {
  const modules: Record<string, ConfigModule> = {};
  const visit = (mod: Json, path: string[], call?: ConfigModuleCall): void => {
    const node = toConfigModule(mod, path, call);
    const key = path.join(".");
    if (!(key in modules)) modules[key] = node;
    if (path.length >= MAX_MODULE_DEPTH || !isObject(mod.module_calls)) return;
    for (const [name, c] of Object.entries(mod.module_calls)) {
      if (!isObject(c)) continue;
      visit(isObject(c.module) ? c.module : {}, [...path, name], node.moduleCalls[name]);
    }
  };
  visit(root, []);
  return modules;
}

function toConfigModule(mod: Json, path: string[], call?: ConfigModuleCall): ConfigModule {
  const resources: Record<string, ConfigResource> = {};
  if (Array.isArray(mod.resources)) {
    for (const r of mod.resources) {
      const res = toConfigResource(r);
      if (res && !(res.address in resources)) resources[res.address] = res;
    }
  }
  const moduleCalls: Record<string, ConfigModuleCall> = {};
  if (isObject(mod.module_calls)) {
    for (const [name, c] of Object.entries(mod.module_calls)) {
      if (!isObject(c)) continue;
      const version = str(c.version);
      const count = toExpression(c.count_expression);
      const forEach = toExpression(c.for_each_expression);
      moduleCalls[name] = {
        name,
        source: str(c.source) ?? "",
        ...(version !== undefined && { version }),
        expressions: isObject(c.expressions) ? c.expressions : {},
        ...(count && { countExpression: count }),
        ...(forEach && { forEachExpression: forEach }),
      };
    }
  }
  const variables: ConfigModule["variables"] = {};
  if (isObject(mod.variables)) {
    for (const [name, v] of Object.entries(mod.variables)) {
      const d = isObject(v) ? v : {};
      variables[name] = {
        ...("default" in d && { default: d.default }),
        ...(typeof d.sensitive === "boolean" && { sensitive: d.sensitive }),
        ...(typeof d.description === "string" && { description: d.description }),
      };
    }
  }
  const outputs: ConfigModule["outputs"] = {};
  if (isObject(mod.outputs)) {
    for (const [name, o] of Object.entries(mod.outputs)) {
      const d = isObject(o) ? o : {};
      const expression = toExpression(d.expression);
      outputs[name] = {
        ...(expression && { expression }),
        ...(typeof d.sensitive === "boolean" && { sensitive: d.sensitive }),
      };
    }
  }
  return {
    path,
    ...(call && { source: call.source }),
    ...(call?.version !== undefined && { version: call.version }),
    resources,
    moduleCalls,
    variables,
    outputs,
  };
}

function toConfigResource(r: unknown): ConfigResource | null {
  if (!isObject(r)) return null;
  const mode = r.mode === "data" ? "data" : "managed";
  const type = str(r.type);
  const name = str(r.name);
  if (!type || !name) return null;
  const address = str(r.address) ?? `${mode === "data" ? "data." : ""}${type}.${name}`;
  const count = toExpression(r.count_expression);
  const forEach = toExpression(r.for_each_expression);
  return {
    address,
    mode,
    type,
    name,
    expressions: isObject(r.expressions) ? r.expressions : {},
    ...(count && { countExpression: count }),
    ...(forEach && { forEachExpression: forEach }),
  };
}

function toExpression(v: unknown): Expression | undefined {
  if (!isObject(v)) return undefined;
  const refs = Array.isArray(v.references) ? v.references.filter((r) => typeof r === "string") : undefined;
  return {
    ...("constant_value" in v && { constant_value: v.constant_value }),
    ...(refs && { references: refs }),
  };
}
