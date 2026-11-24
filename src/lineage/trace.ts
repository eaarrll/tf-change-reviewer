/*
 * Traces a planned resource change back to the code that causes it (DESIGN.md "Lineage
 * algorithm"): the attribute's expression in the resource, then each reference outward through
 * module inputs, variables (defaults and .tfvars), locals, module outputs, count / for_each, data
 * sources and upstream resource changes. Each step is marked when the PR diff touches it; the
 * changed steps, most upstream first, are the root causes. Deletes whose code the PR removed point
 * at the removed block in the base version of the file. Never throws.
 */
import { posix } from "node:path";
import { redactSecrets } from "../redact.js";
import { isDestroyPlan } from "../risk/score.js";
import { normalizePath } from "../git/diff.js";
import { deepEqual, describePath, formatPath, getAtPath } from "../plan/paths.js";
import { SENSITIVE_PLACEHOLDER } from "../types.js";
import type {
  AttrPath,
  ConfigResource,
  DiffIndex,
  Lineage,
  LineageStep,
  LineageStepKind,
  PlanModel,
  ResourceChange,
  SourceLocation,
} from "../types.js";
import { evaluateLiteral, parseHcl, type HclBlock, type HclBody } from "./hcl.js";
import {
  joinRepoPath,
  jsonKeySpan,
  makeSnippet,
  type DynamicScope,
  type ResourceRef,
  type SourceHit,
} from "./source.js";
import type { SourceIndex } from "./source.js";

export interface TraceContext {
  plan: PlanModel;
  source: SourceIndex;
  diff: DiffIndex;
  /** The PR's unified diff, for code it removed (deletes); null when unavailable. */
  diffText: string | null;
  /** Every resource change of the plan by address (upstream lookups). */
  changesByAddress: Map<string, ResourceChange>;
  /** Maximum reference hops from the resource (default 12). */
  maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 12;
const MAX_STEPS = 60;
/** Attributes traced per change when none is given. */
const MAX_PATHS = 4;
/** Nested upstream resources followed (a → b → c). */
const MAX_UPSTREAM_LEVELS = 3;
const MAX_UPSTREAM_INSTANCES = 3;
const MAX_DATA_ATTRIBUTES = 40;

/**
 * Lineage of one change. `attribute` picks the attribute to trace ([] = the whole resource);
 * otherwise: replace → replacePaths, update → changed paths, create → the resource block,
 * delete → the removed code or the count / for_each that dropped the instance.
 */
export async function traceChange(
  change: ResourceChange,
  ctx: TraceContext,
  attribute?: AttrPath | readonly AttrPath[],
): Promise<Lineage> {
  try {
    return await new Tracer(ctx, change).run(attribute);
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error)).text;
    const first = isPathList(attribute) ? attribute[0] : attribute;
    return {
      address: change.address,
      attribute: first ? [...first] : [],
      steps: [],
      rootCauseIds: [],
      explanation: "unknown",
      notes: [`Tracing stopped on an internal error: ${message.slice(0, 200)}`],
    };
  }
}

/** A list of attribute paths (several traced together), not one path. */
function isPathList(a: AttrPath | readonly AttrPath[] | undefined): a is readonly AttrPath[] {
  return Array.isArray(a) && a.length > 0 && a.every((p) => Array.isArray(p));
}

// ───────────────────────────── internal types ─────────────────────────────

interface Step extends LineageStep {
  depth: number;
  /** False for steps whose value does not apply (a tfvars value overridden, a value set outside the repo). */
  eligible: boolean;
  /** The step's span contains an added line (not only a removal anchor). */
  added: boolean;
}

interface Scope {
  modulePath: string[];
  /** Instance address of the module (`module.a["x"]`); null = root; undefined = unknown instance. */
  moduleInstance: string | null | undefined;
  /** The resource whose argument the expression is (each / count refer to its for_each / count). */
  resource?: ResourceRef;
  /** That resource instance's count index or for_each key (resolves `x[count.index]`). */
  index?: string | number;
  /** The module call whose argument the expression is (each / count refer to the call's). */
  moduleCall?: string[];
  dynamic?: DynamicScope[];
}

type Target =
  | { kind: "var" | "local"; name: string }
  | { kind: "module"; call: string; key?: string | number; output?: string }
  | { kind: "data"; type: string; name: string }
  | {
      kind: "resource";
      type: string;
      name: string;
      keys: (string | number)[];
      attrs: string[];
      whole: boolean;
    }
  | { kind: "each" | "count" }
  | { kind: "dynamic"; scope: DynamicScope };

interface StepInput {
  kind: LineageStepKind;
  modulePath: string[];
  label: string;
  hit?: SourceHit | null;
  location?: SourceLocation;
  snippet?: string;
  references?: string[];
  upstreamAddress?: string;
  eligible?: boolean;
  path?: AttrPath;
  /** Overrides whether the PR changes the step (default: the diff touches its location). */
  changed?: boolean;
}

// ───────────────────────────── diff patches (base side) ─────────────────────────────

export interface Hunk {
  oldStart: number;
  newStart: number;
  newCount: number;
  lines: { type: " " | "-" | "+"; text: string }[];
}

export interface Patch {
  oldPath: string | null;
  newPath: string | null;
  hunks: Hunk[];
  /** Old-file line numbers of removed lines. */
  removed: Set<number>;
}

interface PatchCache {
  text: string;
  patches: Patch[];
  base: Map<Patch, Promise<{ text: string; body: HclBody } | null>>;
}

const patchCaches = new WeakMap<TraceContext, PatchCache>();

function stripDiffPath(raw: string): string | null {
  let p = raw.replace(/\t.*$/, "").trim();
  if (p === "/dev/null") return null;
  if (p.startsWith('"') && p.endsWith('"')) {
    try {
      p = JSON.parse(p) as string;
    } catch {
      p = p.slice(1, -1);
    }
  }
  return normalizePath(p.replace(/^[ab]\//, ""));
}

/** Files and hunks of a unified diff, with the old side's text. Tolerant, never throws. */
export function parsePatches(text: string): Patch[] {
  const patches: Patch[] = [];
  let cur: Patch | null = null;
  let hunk: Hunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let oldLine = 0;
  for (const line of text.split(/\r?\n/)) {
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const type = line[0];
      if (type === "\\") continue;
      if (type === "-" || type === "+" || type === " " || line === "") {
        const t: " " | "-" | "+" = type === "-" || type === "+" ? type : " ";
        hunk.lines.push({ type: t, text: line.slice(1) });
        if (t !== "+") {
          if (t === "-") cur?.removed.add(oldLine);
          oldLine++;
          oldLeft--;
        }
        if (t !== "-") newLeft--;
        continue;
      }
      hunk = null;
    }
    if (line.startsWith("diff --git ")) {
      cur = { oldPath: null, newPath: null, hunks: [], removed: new Set() };
      patches.push(cur);
      hunk = null;
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m) {
        cur.oldPath = normalizePath(m[1]!);
        cur.newPath = normalizePath(m[2]!);
      }
      continue;
    }
    if (!cur) {
      if (!line.startsWith("--- ")) continue;
      cur = { oldPath: null, newPath: null, hunks: [], removed: new Set() };
      patches.push(cur);
    }
    if (line.startsWith("--- ")) cur.oldPath = stripDiffPath(line.slice(4));
    else if (line.startsWith("+++ ")) cur.newPath = stripDiffPath(line.slice(4));
    else if (line.startsWith("rename from ")) cur.oldPath = normalizePath(line.slice(12));
    else if (line.startsWith("rename to ")) cur.newPath = normalizePath(line.slice(10));
    else if (line.startsWith("deleted file")) cur.newPath = null;
    else if (line.startsWith("new file")) cur.oldPath = null;
    else {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m) {
        oldLine = Number(m[1]);
        oldLeft = m[2] === undefined ? 1 : Number(m[2]);
        const newCount = m[4] === undefined ? 1 : Number(m[4]);
        newLeft = newCount;
        hunk = { oldStart: oldLine, newStart: Number(m[3]), newCount, lines: [] };
        cur.hunks.push(hunk);
      }
    }
  }
  return patches;
}

/** The base version of a patched file: the head text with the hunks reversed, or the hunks' old side. */
export function reconstructBase(patch: Patch, head: string | null): string {
  const sparse = (): string => {
    const lines: string[] = [];
    for (const h of patch.hunks) {
      let n = h.oldStart;
      for (const l of h.lines) {
        if (l.type === "+") continue;
        while (lines.length < n - 1) lines.push("");
        lines[n - 1] = l.text;
        n++;
      }
    }
    return lines.join("\n");
  };
  if (head === null || patch.newPath === null) return sparse();
  const headLines = head.split(/\r?\n/);
  const out: string[] = [];
  let h = 1;
  for (const hunk of [...patch.hunks].sort((a, b) => a.newStart - b.newStart)) {
    const start = hunk.newCount === 0 ? hunk.newStart + 1 : hunk.newStart;
    while (h < start && h <= headLines.length) out.push(headLines[h++ - 1]!);
    if (out.length + 1 !== hunk.oldStart) return sparse(); // head and diff disagree
    for (const l of hunk.lines) if (l.type !== "+") out.push(l.text);
    h += hunk.newCount;
  }
  while (h <= headLines.length) out.push(headLines[h++ - 1]!);
  return out.join("\n");
}

// ───────────────────────────── helpers ─────────────────────────────

function refOf(change: ResourceChange): ResourceRef {
  return { mode: change.mode, type: change.type, name: change.name };
}

function configAddress(ref: ResourceRef): string {
  return `${ref.mode === "data" ? "data." : ""}${ref.type}.${ref.name}`;
}

function formatKey(key: string | number): string {
  return typeof key === "number" ? `[${key}]` : `[${JSON.stringify(key)}]`;
}

/** `module.a["x"].module.b` → [`module.a["x"]`, `module.b`]. */
function splitModuleInstance(address: string): string[] {
  const segments: string[] = [];
  let cur = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < address.length; i++) {
    const ch = address[i]!;
    if (quoted) {
      cur += ch;
      if (ch === "\\") cur += address[++i] ?? "";
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === "[") depth++;
    else if (ch === "]") depth--;
    if (ch === "." && depth === 0 && address.startsWith("module.", i + 1) && cur.startsWith("module.")) {
      segments.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) segments.push(cur);
  return segments;
}

/** The instance key of the innermost module call of an instance address (`module.a["x"]` → "x"). */
function instanceKey(instance: string | null | undefined): string | number | undefined {
  if (!instance) return undefined;
  const last = splitModuleInstance(instance).at(-1) ?? "";
  const m = /\[(.+)\]$/.exec(last);
  if (!m) return undefined;
  if (/^\d+$/.test(m[1]!)) return Number(m[1]);
  try {
    const key = JSON.parse(m[1]!) as unknown;
    return typeof key === "string" ? key : undefined;
  } catch {
    return undefined;
  }
}

function parentInstance(instance: string | null | undefined): string | null | undefined {
  if (instance === undefined || instance === null) return instance;
  const segments = splitModuleInstance(instance);
  return segments.length > 1 ? segments.slice(0, -1).join(".") : null;
}

type RefStep = { attr: string } | { index: string | number } | { self: "count" | "each" };

/** `module.m["k"].out[0]` → root "module" + steps. */
function parseTraversal(ref: string): { root: string; steps: RefStep[] } | null {
  const m = /^[\p{L}_][\p{L}\p{N}_-]*/u.exec(ref);
  if (!m) return null;
  const steps: RefStep[] = [];
  let i = m[0].length;
  while (i < ref.length) {
    if (ref[i] === ".") {
      const a = /^[\p{L}\p{N}_-]+/u.exec(ref.slice(i + 1));
      if (!a) break;
      steps.push(/^\d+$/.test(a[0]) ? { index: Number(a[0]) } : { attr: a[0] });
      i += 1 + a[0].length;
    } else if (ref[i] === "[") {
      const rest = ref.slice(i + 1);
      const num = /^(\d+)\]/.exec(rest);
      if (num) {
        steps.push({ index: Number(num[1]) });
        i += 2 + num[1]!.length;
        continue;
      }
      const own = /^(count\.index|each\.key)\]/.exec(rest);
      if (own) {
        // `x[count.index]` / `x[each.key]`: the instance with the referencing resource's own key.
        steps.push({ self: own[1] === "count.index" ? "count" : "each" });
        i += 2 + own[1]!.length;
        continue;
      }
      const str = /^("(?:[^"\\]|\\.)*")\]/.exec(rest);
      if (!str) break;
      try {
        steps.push({ index: JSON.parse(str[1]!) as string });
      } catch {
        break;
      }
      i += 2 + str[1]!.length;
    } else break;
  }
  return { root: m[0], steps };
}

const attrOf = (s: RefStep | undefined): string | undefined => (s && "attr" in s ? s.attr : undefined);
const indexOf = (s: RefStep | undefined, own?: string | number): string | number | undefined => {
  if (!s) return undefined;
  if ("index" in s) return s.index;
  if ("self" in s && own !== undefined && (s.self === "count") === (typeof own === "number")) return own;
  return undefined;
};
/** A key step (literal or the referencing instance's own count.index / each.key). */
const isKeyStep = (s: RefStep | undefined): boolean => s !== undefined && !("attr" in s);

/** Distinct things an expression's references point at. */
function targetsOf(
  refs: readonly string[],
  dynamic: readonly DynamicScope[] = [],
  ownKey?: string | number,
): Target[] {
  const out = new Map<string, Target>();
  for (const ref of refs) {
    const t = parseTraversal(ref);
    if (!t) continue;
    const { root, steps } = t;
    const dyn = [...dynamic].reverse().find((d) => d.iterator === root);
    if (dyn) {
      out.set(`dyn:${dyn.label}:${dyn.iterator}`, { kind: "dynamic", scope: dyn });
      continue;
    }
    if (root === "var" || root === "local") {
      const name = attrOf(steps[0]);
      if (name) out.set(`${root}:${name}`, { kind: root, name });
    } else if (root === "each" || root === "count") {
      out.set(root, { kind: root });
    } else if (root === "module") {
      const call = attrOf(steps[0]);
      if (!call) continue;
      const key = indexOf(steps[1]);
      const output = attrOf(steps[key === undefined ? 1 : 2]);
      const id = `module:${call}:${output ?? ""}`;
      const prev = out.get(id);
      if (!prev || (prev.kind === "module" && prev.key === undefined && key !== undefined)) {
        out.set(id, { kind: "module", call, ...(key !== undefined && { key }), ...(output && { output }) });
      }
    } else if (root === "data") {
      const type = attrOf(steps[0]);
      const name = attrOf(steps[1]);
      if (type && name) out.set(`data:${type}.${name}`, { kind: "data", type, name });
    } else if (root.includes("_") && !["self", "path", "terraform"].includes(root)) {
      const name = attrOf(steps[0]);
      if (!name) continue;
      const id = `res:${root}.${name}`;
      const prev = out.get(id);
      const target =
        prev?.kind === "resource"
          ? prev
          : { kind: "resource" as const, type: root, name, keys: [], attrs: [], whole: false };
      const keyed = isKeyStep(steps[1]);
      const key = indexOf(steps[1], ownKey);
      if (key !== undefined && !target.keys.includes(key)) target.keys.push(key);
      const attr = attrOf(steps[keyed ? 2 : 1]);
      if (attr && !target.attrs.includes(attr)) target.attrs.push(attr);
      if (steps.length === (keyed ? 2 : 1) && refs.every((r) => !r.startsWith(`${ref}.`)))
        target.whole = true;
      out.set(id, target);
    }
  }
  // `module.m` alone is implied by `module.m.out`.
  for (const [id, t] of out) {
    if (t.kind === "module" && t.output === undefined) {
      const hasOutput = [...out.values()].some((o) => o.kind === "module" && o.call === t.call && o.output);
      if (hasOutput) out.delete(id);
    }
  }
  return [...out.values()];
}

function topLevel(paths: readonly AttrPath[]): Set<string> {
  const out = new Set<string>();
  for (const p of paths) if (typeof p[0] === "string") out.add(p[0]);
  return out;
}

/** Masked values (sensitive or redacted) cannot be compared with what the repo says. */
function hasPlaceholder(v: unknown, depth = 0): boolean {
  if (v === SENSITIVE_PLACEHOLDER || (typeof v === "string" && v.includes("[REDACTED:"))) return true;
  if (depth > 32 || v === null || typeof v !== "object") return false;
  return Object.values(v).some((x) => hasPlaceholder(x, depth + 1));
}

/**
 * Whether a value written in the repo equals the plan's (typed) value: numbers and bools may be
 * written as strings, object attributes the type adds are null, sets may be reordered.
 */
export function looseEqual(repo: unknown, plan: unknown, depth = 0): boolean {
  if (deepEqual(repo, plan)) return true;
  if (depth > 32) return false;
  if (typeof repo === "string" && (typeof plan === "number" || typeof plan === "boolean"))
    return repo.trim() === String(plan);
  if (typeof plan === "string" && (typeof repo === "number" || typeof repo === "boolean"))
    return plan === String(repo);
  if (Array.isArray(repo) && Array.isArray(plan)) {
    if (repo.length !== plan.length) return false;
    if (repo.every((x, i) => looseEqual(x, plan[i], depth + 1))) return true;
    const rest = [...plan];
    return repo.every((x) => {
      const k = rest.findIndex((y) => looseEqual(x, y, depth + 1));
      if (k < 0) return false;
      rest.splice(k, 1);
      return true;
    });
  }
  if (repo && plan && typeof repo === "object" && typeof plan === "object" && !Array.isArray(repo)) {
    if (Array.isArray(plan)) return false;
    const r = repo as Record<string, unknown>;
    const p = plan as Record<string, unknown>;
    for (const k of new Set([...Object.keys(r), ...Object.keys(p)])) {
      if (!(k in r)) {
        if (p[k] !== null && p[k] !== undefined) return false;
      } else if (!looseEqual(r[k], p[k], depth + 1)) return false;
    }
    return true;
  }
  return false;
}

function providerLocalName(providerName: string): string {
  const last = providerName.split("/").pop() ?? providerName;
  return last.replace(/^terraform-provider-/, "");
}

// ───────────────────────────── tracer ─────────────────────────────

class Tracer {
  private readonly steps: Step[] = [];
  private readonly notes = new Set<string>();
  private readonly seen = new Set<string>();
  /** Steps a shared target's first trace added at its own level, by its `seen` key. */
  private readonly heads = new Map<string, Step[]>();
  private readonly stepKeys = new Set<string>();
  private readonly chain = new Set<string>();
  private readonly visitedModules = new Map<string, string[]>();
  private readonly maxDepth: number;
  private external = false;
  private upstream = false;
  private upstreamLevel = 0;
  private stepBudgetNoted = false;
  private changesIndex: Map<string, ResourceChange[]> | null = null;

  constructor(
    private readonly ctx: TraceContext,
    private readonly root: ResourceChange,
  ) {
    this.maxDepth = Math.max(1, ctx.maxDepth ?? DEFAULT_MAX_DEPTH);
  }

  private get source(): SourceIndex {
    return this.ctx.source;
  }

  async run(attribute?: AttrPath | readonly AttrPath[]): Promise<Lineage> {
    this.chain.add(this.root.address);
    if (this.root.deposed !== undefined) {
      // Not the configured instance: what the code says about that instance does not decide this.
      this.note(
        `${this.root.address} (deposed ${this.root.deposed}) is a leftover object from an earlier create_before_destroy replacement that failed or was interrupted; Terraform destroys it whatever the code says.`,
      );
      this.external = true;
      return this.finish(isPathList(attribute) ? attribute[0]! : ((attribute as AttrPath | undefined) ?? []));
    }
    if (this.root.action === "delete" && isDestroyPlan(this.ctx.plan)) {
      // terraform plan -destroy: no line of code causes the delete, and the instance still exists
      // in the configuration (review.ts does not trace these; the agent's trace_cause tool may).
      this.note(
        `${this.root.address} is deleted because this is a destroy plan (terraform plan -destroy or terraform destroy): Terraform destroys every resource it manages, whatever the code says.`,
      );
      this.external = true;
      return this.finish(isPathList(attribute) ? attribute[0]! : ((attribute as AttrPath | undefined) ?? []));
    }
    if (isPathList(attribute)) {
      // Several attributes of one change (e.g. every risk signal's path), traced side by side.
      const scope = this.scopeOf(this.root);
      for (const p of attribute) await this.traceAttribute(this.root, p, scope, 0);
      if (!this.hasRootCause()) await this.fallbacks(this.root);
      return this.finish(attribute[0]!);
    }
    const single = attribute as AttrPath | undefined;
    const traced = await this.traceChangeBody(this.root, 0, single);
    if (!this.hasRootCause()) await this.fallbacks(this.root);
    return this.finish(single ?? traced);
  }

  // ───────────── steps ─────────────

  private note(text: string): void {
    this.notes.add(text);
  }

  /**
   * Whether the PR changes a location: an added line inside it, or a removal strictly between two of
   * its lines. Stricter than DiffIndex.touches, whose removal anchors also mark the line before a
   * deletion (which would make an untouched neighbouring assignment look like a root cause).
   */
  private touches(loc: SourceLocation): boolean {
    if (loc.side === "base") return true;
    try {
      const fd = this.ctx.diff.files.get(normalizePath(loc.file));
      if (!fd) return this.ctx.diff.touches(loc.file, loc.startLine, loc.endLine);
      if (fd.status === "added") return true;
      for (let l = loc.startLine; l <= loc.endLine; l++) if (fd.addedLines.has(l)) return true;
      for (let l = loc.startLine; l < loc.endLine; l++) {
        if (fd.removalAnchors.has(l) && fd.removalAnchors.has(l + 1)) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * A changed multi-line span (a map in a .tfvars file, a data block) narrowed to the lines the PR
   * added in it, so links and causes point at the edited line rather than the whole assignment.
   */
  private narrow(loc: SourceLocation): SourceLocation {
    if (loc.side === "base" || loc.endLine <= loc.startLine) return loc;
    const fd = this.ctx.diff.files.get(normalizePath(loc.file));
    if (!fd || fd.status === "added") return loc;
    const added: number[] = [];
    for (let l = loc.startLine; l <= loc.endLine; l++) if (fd.addedLines.has(l)) added.push(l);
    if (!added.length || added.length === loc.endLine - loc.startLine + 1) return loc;
    return { ...loc, startLine: added[0]!, endLine: added[added.length - 1]! };
  }

  private addsLines(loc: SourceLocation): boolean {
    if (loc.side === "base") return true;
    const fd = this.ctx.diff.files.get(normalizePath(loc.file));
    if (!fd) return false;
    if (fd.status === "added") return true;
    for (let l = loc.startLine; l <= loc.endLine; l++) if (fd.addedLines.has(l)) return true;
    return false;
  }

  private addStep(input: StepInput, depth: number): Step | null {
    const location = input.location ?? input.hit?.location;
    const key = location
      ? `${input.kind}|${location.side ?? "head"}|${location.file}|${location.startLine}|${location.endLine}`
      : `${input.kind}|${input.modulePath.join(".")}|${input.label}`;
    if (this.stepKeys.has(key)) return null;
    if (this.steps.length >= MAX_STEPS) {
      if (!this.stepBudgetNoted) this.note(`Tracing stopped after ${MAX_STEPS} steps.`);
      this.stepBudgetNoted = true;
      return null;
    }
    this.stepKeys.add(key);
    const snippet = input.snippet ?? input.hit?.snippet;
    // Depth-first: the parent is the latest step one level up (the expression that read this one).
    const parent = this.parentAt(depth);
    const step: Step = {
      id: `s${this.steps.length}`,
      kind: input.kind,
      modulePath: [...input.modulePath],
      label: input.label,
      ...(snippet !== undefined && snippet !== "" && { snippet }),
      references: [...(input.references ?? input.hit?.references ?? [])],
      ...(location && { location: { ...location } }),
      changedInDiff: input.changed ?? (location ? this.touches(location) : false),
      ...(input.upstreamAddress !== undefined && { upstreamAddress: input.upstreamAddress }),
      ...(parent && { parentId: parent.id }),
      ...(input.path && { path: [...input.path] }),
      depth,
      eligible: input.eligible ?? true,
      added: location ? this.addsLines(location) : false,
    };
    this.steps.push(step);
    this.visitedModules.set(input.modulePath.join("."), input.modulePath);
    return step;
  }

  private hasRootCause(): boolean {
    return this.steps.some((s) => s.changedInDiff && s.eligible);
  }

  private async finish(attribute: AttrPath): Promise<Lineage> {
    for (const path of this.visitedModules.values()) {
      if ((await this.source.moduleDir(path)) === null) continue;
      for (const n of await this.source.moduleNotes(path)) this.note(n);
    }
    const causes = this.steps
      .filter((s) => s.changedInDiff && s.eligible)
      .sort((a, b) => b.depth - a.depth || Number(b.added) - Number(a.added) || idNum(a) - idNum(b));
    const rootCauseIds = causes.map((s) => s.id);
    const explanation: Lineage["explanation"] = rootCauseIds.length
      ? "diff"
      : this.upstream
        ? "upstream"
        : this.external
          ? "external"
          : "unknown";
    if (explanation === "unknown") {
      if (this.ctx.diffText === null && this.ctx.diff.files.size === 0)
        this.note("No PR diff was available, so the changed lines are unknown.");
      else if (this.steps.length) this.note("No line of this PR's diff touches the traced code.");
    }
    return {
      address: this.root.address,
      attribute: [...attribute],
      steps: this.steps.map(({ depth: _d, eligible: _e, added: _a, ...step }) =>
        step.changedInDiff && step.location ? { ...step, location: this.narrow(step.location) } : step,
      ),
      rootCauseIds,
      explanation,
      notes: [...this.notes],
      ...(this.root.deposed !== undefined && { deposed: this.root.deposed }),
    };
  }

  // ───────────── changes ─────────────

  private configResource(path: readonly string[], ref: ResourceRef): ConfigResource | undefined {
    return this.ctx.plan.modules[path.join(".")]?.resources[configAddress(ref)];
  }

  private scopeOf(change: ResourceChange): Scope {
    return {
      modulePath: [...change.configModulePath],
      moduleInstance: change.moduleAddress,
      resource: refOf(change),
      ...(change.index !== undefined && { index: change.index }),
    };
  }

  /** Returns the attribute traced first ([] for block-level traces). */
  private async traceChangeBody(
    change: ResourceChange,
    depth: number,
    attribute?: AttrPath,
  ): Promise<AttrPath> {
    const scope = this.scopeOf(change);
    if (attribute) {
      if (attribute.length === 0) {
        if (change.action === "delete") await this.traceDelete(change, scope, depth);
        else await this.traceCreate(change, scope, depth);
      } else await this.traceAttribute(change, attribute, scope, depth);
      return attribute;
    }
    switch (change.action) {
      case "replace": {
        const reason = change.actionReason;
        if (reason === "replace_because_tainted") {
          this.note(
            "The object is tainted (a previous apply failed or it was marked with terraform taint): Terraform replaces it whatever the code says.",
          );
          this.external = true;
        } else if (reason === "replace_by_request") {
          this.note("Replacement was requested with -replace on the command line, not by the code.");
          this.external = true;
        }
        let paths = change.replacePaths.slice(0, MAX_PATHS);
        if (!paths.length && reason === "replace_by_triggers")
          paths = [["lifecycle", "replace_triggered_by"]];
        if (!paths.length && !this.external) paths = this.pickPaths(change);
        if (!paths.length) {
          await this.traceCreate(change, scope, depth);
          return [];
        }
        for (const p of paths) await this.traceAttribute(change, p, scope, depth);
        return paths[0]!;
      }
      case "update":
      case "import": {
        const paths = this.pickPaths(change);
        if (!paths.length) {
          await this.traceCreate(change, scope, depth);
          return [];
        }
        for (const p of paths) await this.traceAttribute(change, p, scope, depth);
        return paths[0]!;
      }
      case "delete":
        await this.traceDelete(change, scope, depth);
        return [];
      case "forget":
      case "move": {
        const [type, attr] =
          change.action === "forget" ? (["removed", "from"] as const) : (["moved", "to"] as const);
        const rel = change.address.slice(change.moduleAddress ? change.moduleAddress.length + 1 : 0);
        const hit = await this.source.findConfigBlockFor(change.configModulePath, type, attr, rel);
        if (hit)
          this.addStep(
            { kind: "resource_block", modulePath: scope.modulePath, label: `${type} block for ${rel}`, hit },
            depth,
          );
        else await this.traceCreate(change, scope, depth);
        return [];
      }
      default:
        if (
          change.actionReason === "read_because_config_unknown" ||
          change.actionReason === "read_because_dependency_pending"
        )
          this.note("The data source is read during apply because its arguments are only known after apply.");
        await this.traceCreate(change, scope, depth);
        return [];
    }
  }

  /** Changed paths worth tracing: configured attributes first, tags_all last, at most MAX_PATHS. */
  private pickPaths(change: ResourceChange): AttrPath[] {
    const seen = new Set<string>();
    const all: AttrPath[] = [];
    for (const p of [...change.changedPaths, ...change.sensitiveChangedPaths]) {
      const k = JSON.stringify(p);
      if (!seen.has(k) && p.length) {
        seen.add(k);
        all.push(p);
      }
    }
    if (!all.length) all.push(...change.unknownPaths.filter((p) => p.length));
    const config = this.configResource(change.configModulePath, refOf(change));
    const rank = (p: AttrPath): number => {
      if (p[0] === "tags_all") return 2;
      return config && typeof p[0] === "string" && p[0] in config.expressions ? 0 : 1;
    };
    // One group per attribute or nested block instance (`ingress[1]`), taken round-robin so a set
    // whose elements moved gets each element traced, not four leaves of the first one.
    const groups = new Map<string, { r: number; paths: AttrPath[] }>();
    for (const p of all) {
      const idx = p.findIndex((s) => typeof s === "number");
      const key = JSON.stringify(idx >= 0 ? p.slice(0, idx + 1) : p.slice(0, 1));
      const g = groups.get(key) ?? { r: rank(p), paths: [] };
      g.paths.push(p);
      groups.set(key, g);
    }
    const ordered = [...groups.values()].sort((a, b) => a.r - b.r);
    const out: AttrPath[] = [];
    for (let round = 0; out.length < MAX_PATHS; round++) {
      const before = out.length;
      for (const g of ordered) {
        const p = g.paths[round];
        if (p && out.length < MAX_PATHS) out.push(p);
      }
      if (out.length === before) break;
    }
    return out;
  }

  private indexChanges(): Map<string, ResourceChange[]> {
    if (!this.changesIndex) {
      this.changesIndex = new Map();
      for (const c of this.ctx.changesByAddress.values()) {
        const k = `${c.configModulePath.join(".")}|${c.mode}|${c.type}|${c.name}`;
        const list = this.changesIndex.get(k) ?? [];
        list.push(c);
        this.changesIndex.set(k, list);
      }
    }
    return this.changesIndex;
  }

  private findChanges(scope: Scope, ref: ResourceRef, keys: readonly (string | number)[]): ResourceChange[] {
    const list =
      this.indexChanges().get(`${scope.modulePath.join(".")}|${ref.mode}|${ref.type}|${ref.name}`) ?? [];
    return list.filter(
      (c) =>
        (scope.moduleInstance === undefined || (c.moduleAddress ?? null) === scope.moduleInstance) &&
        (!keys.length || (c.index !== undefined && keys.includes(c.index))),
    );
  }

  // ───────────── attributes ─────────────

  private async traceAttribute(
    change: ResourceChange,
    path: AttrPath,
    scope: Scope,
    depth: number,
  ): Promise<void> {
    const ref = refOf(change);
    const config = this.configResource(scope.modulePath, ref);
    const top = path[0];
    if (top === "tags_all" && !(config && "tags_all" in config.expressions)) {
      await this.traceDefaultTags(change, path.slice(1), scope, depth);
      return;
    }
    const firstIndex = path.findIndex((s) => typeof s === "number");
    const hints =
      firstIndex >= 0
        ? [
            getAtPath(
              change.action === "delete" ? change.before : change.after,
              path.slice(0, firstIndex + 1),
            ),
          ]
        : [];
    // A whole nested block element that is gone after the change (removed from a set of blocks):
    // the blocks still in the code are other elements, so only the base side can hold it.
    const gone =
      change.action !== "delete" &&
      typeof path[path.length - 1] === "number" &&
      getAtPath(change.after, path) == null;
    const hit = gone ? null : await this.source.findResourceAttribute(scope.modulePath, ref, path, hints);
    const label = `${configAddress(ref)} ${describePath(change.action === "delete" || gone ? change.before : change.after, path)}`;
    if (!hit) {
      if ((await this.source.moduleDir(scope.modulePath)) === null) {
        await this.remoteModule(scope.modulePath, depth);
        return;
      }
      const removed = await this.findRemovedAttribute(scope.modulePath, ref, path);
      if (removed) {
        this.removedStep(removed, scope.modulePath, `${label} removed by this PR`, depth);
        this.note(
          gone
            ? `This PR deletes ${label}.`
            : `This PR deletes ${label}: the provider default (or computed value) applies instead.`,
        );
        return;
      }
      if (config && typeof top === "string" && !(top in config.expressions)) {
        this.note(
          `${label} is not set in the configuration: the provider computes or defaults it, so no line of code sets it directly.`,
        );
      } else this.note(`Could not locate ${label} in the module's .tf files.`);
      if (depth === 0 && !this.steps.length) await this.traceCreate(change, scope, depth);
      return;
    }
    const step = this.addStep(
      { kind: "resource_attribute", modulePath: scope.modulePath, label, hit, path },
      depth,
    );
    if (!step) return;
    await this.fileSteps(hit, scope.modulePath, depth + 1);
    await this.expand(hit.references, { ...scope, dynamic: hit.dynamic ?? [] }, depth + 1);
  }

  /**
   * Files the expression reads (file(), templatefile(), …): one step each, located at the lines the
   * PR changed in that file (the first line when it did not change), so a policy JSON or a user-data
   * template edited by the PR is the root cause instead of the unchanged attribute that reads it.
   */
  private async fileSteps(hit: SourceHit, modulePath: string[], depth: number): Promise<void> {
    for (const file of hit.files ?? []) {
      const fd = this.ctx.diff.files.get(normalizePath(file));
      const lines = fd ? (fd.addedLines.size ? [...fd.addedLines] : [...fd.removalAnchors]) : [];
      const location: SourceLocation = lines.length
        ? { file, startLine: Math.min(...lines), endLine: Math.max(...lines) }
        : { file, startLine: 1, endLine: 1 };
      const snippet = (await this.source.snippetAt(location)) ?? undefined;
      this.addStep(
        {
          kind: "file_content",
          modulePath,
          label: `content of ${file}`,
          location,
          ...(snippet !== undefined && { snippet }),
          references: [],
        },
        depth,
      );
    }
  }

  /** Whether the PR changes a hit's own lines or a file it reads. */
  private hitTouched(hit: SourceHit): boolean {
    if (this.touches(hit.location)) return true;
    return (hit.files ?? []).some((f) => {
      const fd = this.ctx.diff.files.get(normalizePath(f));
      return (
        fd !== undefined && (fd.addedLines.size > 0 || fd.removedLines.size > 0 || fd.status !== "modified")
      );
    });
  }

  /** tags_all = provider default_tags merged with the resource's tags. */
  private async traceDefaultTags(
    change: ResourceChange,
    keyPath: AttrPath,
    scope: Scope,
    depth: number,
  ): Promise<void> {
    const local = providerLocalName(change.providerName);
    const hit =
      (await this.source.findProviderAttribute(local, ["default_tags", "tags", ...keyPath])) ??
      (await this.source.findProvider(local));
    if (hit) {
      const step = this.addStep(
        {
          kind: "provider_config",
          modulePath: [],
          label: `provider "${local}" default_tags${keyPath.length ? ` ${formatPath(keyPath)}` : ""}`,
          hit,
        },
        depth,
      );
      if (step) await this.expand(hit.references, { modulePath: [], moduleInstance: null }, depth + 1);
    }
    const ref = refOf(change);
    const tags = await this.source.findResourceAttribute(scope.modulePath, ref, ["tags", ...keyPath]);
    if (tags) {
      const step = this.addStep(
        {
          kind: "resource_attribute",
          modulePath: scope.modulePath,
          label: `${configAddress(ref)} ${formatPath(["tags", ...keyPath])}`,
          hit: tags,
        },
        depth,
      );
      if (step) await this.expand(tags.references, scope, depth + 1);
    }
    if (!hit && !tags)
      this.note(
        `tags_all changes, but neither the resource's tags nor a provider "${local}" default_tags block was found.`,
      );
  }

  // ───────────── references ─────────────

  private async expand(refs: readonly string[], scope: Scope, depth: number): Promise<void> {
    const targets = targetsOf(
      refs,
      scope.dynamic ?? [],
      scope.resource || scope.moduleCall ? scope.index : undefined,
    );
    if (!targets.length) return;
    if (depth > this.maxDepth) {
      this.note(`Tracing stopped after ${this.maxDepth} reference hops.`);
      return;
    }
    for (const t of targets) {
      switch (t.kind) {
        case "var":
          await this.traceVar(t.name, scope, depth);
          break;
        case "local":
          await this.traceLocal(t.name, scope, depth);
          break;
        case "module":
          await this.traceModuleOutput(t, scope, depth);
          break;
        case "data":
          await this.traceData(t.type, t.name, scope, depth);
          break;
        case "resource":
          await this.traceUpstream(t, scope, depth);
          break;
        case "each":
        case "count":
          await this.traceRepetition(t.kind === "each" ? "for_each" : "count", scope, depth);
          break;
        case "dynamic":
          await this.traceDynamic(t.scope, scope, depth);
          break;
      }
    }
  }

  private once(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  /**
   * A target several expressions read (a variable or local shared by two risky attributes) is
   * traced once; a later reader is linked to the steps the first trace added at its level, so its
   * branch reaches the same root causes instead of ending at the attribute.
   */
  private async shared(key: string, depth: number, trace: () => Promise<void>): Promise<void> {
    if (this.seen.has(key)) {
      const parent = this.parentAt(depth);
      if (!parent) return;
      const top = this.topOf(parent);
      for (const head of this.heads.get(key) ?? []) {
        // Within one traced attribute the first branch already explains it (no repeated paths).
        const readers = [head.parentId, ...(head.alsoParentIds ?? [])];
        if (readers.some((id) => id !== undefined && this.topOf(this.stepById(id)) === top)) continue;
        if (head.id === parent.id || this.descends(parent, head)) continue; // no cycles
        head.alsoParentIds = [...(head.alsoParentIds ?? []), parent.id];
      }
      return;
    }
    this.seen.add(key);
    const start = this.steps.length;
    await trace();
    this.heads.set(
      key,
      this.steps.slice(start).filter((s) => s.depth === depth),
    );
  }

  /** The step a new step at `depth` hangs under: the latest step one level up. */
  private parentAt(depth: number): Step | undefined {
    if (depth <= 0) return undefined;
    for (let i = this.steps.length - 1; i >= 0; i--) {
      const s = this.steps[i]!;
      if (s.depth === depth - 1) return s;
      if (s.depth < depth - 1) return undefined;
    }
    return undefined;
  }

  /** Step ids are `s<index into this.steps>`. */
  private stepById(id: string): Step | undefined {
    return this.steps[Number(id.slice(1))];
  }

  /** The traced attribute a step's primary branch starts from. */
  private topOf(step: Step | undefined): Step | undefined {
    let cur = step;
    for (let i = 0; cur?.parentId !== undefined && i <= this.steps.length; i++)
      cur = this.stepById(cur.parentId);
    return cur;
  }

  /** Whether `step` sits below `ancestor` through any parent link. */
  private descends(step: Step, ancestor: Step): boolean {
    const todo = [step];
    const seen = new Set<string>();
    while (todo.length) {
      const cur = todo.pop()!;
      if (cur.id === ancestor.id) return true;
      if (seen.has(cur.id)) continue;
      seen.add(cur.id);
      for (const id of [cur.parentId, ...(cur.alsoParentIds ?? [])]) {
        const p = id === undefined ? undefined : this.stepById(id);
        if (p) todo.push(p);
      }
    }
    return false;
  }

  private async traceVar(name: string, scope: Scope, depth: number): Promise<void> {
    await this.shared(`var:${scope.modulePath.join(".")}:${name}`, depth, () =>
      this.traceVarOnce(name, scope, depth),
    );
  }

  private async traceVarOnce(name: string, scope: Scope, depth: number): Promise<void> {
    if (scope.modulePath.length === 0) {
      await this.traceRootVar(name, depth);
      return;
    }
    const callPath = scope.modulePath;
    const parent = callPath.slice(0, -1);
    const callName = callPath[callPath.length - 1]!;
    if ((await this.source.moduleDir(callPath)) === null) {
      await this.remoteModule(callPath, depth);
      return;
    }
    const arg = await this.source.findModuleArgument(callPath, name);
    if (arg) {
      const step = this.addStep(
        {
          kind: "module_input",
          modulePath: parent,
          label: `module "${callName}" argument ${name}`,
          hit: arg,
        },
        depth,
      );
      if (step) {
        await this.fileSteps(arg, parent, depth + 1);
        // `x[each.key]` / `x[count.index]` in the argument: the key of this module instance.
        const key = instanceKey(scope.moduleInstance);
        await this.expand(
          arg.references,
          {
            modulePath: parent,
            moduleInstance: parentInstance(scope.moduleInstance),
            moduleCall: callPath,
            ...(key !== undefined && { index: key }),
          },
          depth + 1,
        );
      }
      return;
    }
    const setInPlan =
      this.ctx.plan.modules[parent.join(".")]?.moduleCalls[callName]?.expressions[name] !== undefined;
    if (setInPlan)
      this.note(`module "${callName}" sets ${name}, but the argument was not found in the source.`);
    const removed = setInPlan ? null : await this.findRemovedModuleArgument(callPath, name);
    if (removed) {
      const masked = this.sensitiveVar(callPath, name) ? name : undefined;
      this.removedStep(
        removed,
        parent,
        `module "${callName}" argument ${name} removed by this PR`,
        depth,
        masked,
      );
      this.note(
        `This PR deletes the ${name} argument of module "${callName}": the variable's default applies instead.`,
      );
    }
    const def = await this.source.findVariableDefault(callPath, name);
    if (def) {
      this.addStep(
        {
          kind: "variable_default",
          modulePath: callPath,
          label: `variable "${name}" default (module "${callName}" does not set it)`,
          hit: def,
          references: [],
        },
        depth,
      );
    } else if (!setInPlan) this.note(`variable "${name}" of module "${callName}" was not found.`);
  }

  private async traceRootVar(name: string, depth: number): Promise<void> {
    const def = await this.source.findVariableDefault([], name);
    const decl = def ? null : await this.source.findVariable([], name);
    const tfvars = await this.source.findTfvars(name);
    const planVar = this.ctx.plan.variables[name];
    const declared = this.ctx.plan.modules[""]?.variables[name];

    // Candidates in precedence order; the last one wins unless the plan's value says otherwise.
    const cands: { hit: SourceHit | null; value?: { v: unknown }; isDefault: boolean }[] = [];
    if (def || (declared && "default" in declared)) {
      const value = def?.literal
        ? { v: def.literal.value }
        : declared && "default" in declared
          ? { v: declared.default }
          : undefined;
      cands.push({ hit: def, ...(value && { value }), isDefault: true });
    }
    for (const t of tfvars)
      cands.push({ hit: t, ...(t.literal && { value: { v: t.literal.value } }), isDefault: false });

    const comparable = planVar !== undefined && !planVar.sensitive && !hasPlaceholder(planVar.value);
    let winner: number | null = cands.length ? cands.length - 1 : null;
    let external = false;
    if (comparable) {
      const last = cands[cands.length - 1];
      if (!last) external = true;
      else if (last.value && !hasPlaceholder(last.value.v) && !looseEqual(last.value.v, planVar.value))
        external = true;
    }
    // A value no auto-loaded file sets may come from a var file in the repo (-var-file=envs/prod.tfvars).
    let varFiles: SourceHit[] = [];
    if (external) {
      winner = null;
      varFiles = await this.varFileMatches(name, planVar!.value);
      if (varFiles.length) {
        const where = varFiles.map((h) => `${h.location.file}:${h.location.startLine}`).join(", ");
        this.note(
          `The plan's value of var.${name} is set in ${where}, which Terraform does not load automatically: the plan was made with -var-file.`,
        );
      } else {
        this.external = true;
        this.note(
          `The plan's value of var.${name} matches no default or .tfvars value in the repository: it was set outside the repo (-var, -var-file, TF_VAR_${name} or CI).`,
        );
      }
    }

    if (def) {
      this.addStep(
        {
          kind: "variable_default",
          modulePath: [],
          label: `variable "${name}" default`,
          hit: def,
          references: [],
          eligible: winner === 0 && cands[0]?.isDefault === true,
        },
        depth,
      );
    } else if (decl) {
      this.addStep(
        {
          kind: "variable_default",
          modulePath: [],
          label: `variable "${name}" (no default)`,
          hit: decl,
          references: [],
          eligible: false,
        },
        depth,
      );
    } else this.note(`variable "${name}" was not found in the root module's .tf files.`);

    const winnerHit = winner !== null ? cands[winner]?.hit : null;
    cands.forEach((c, i) => {
      if (c.isDefault || !c.hit) return;
      const file = posix.basename(c.hit.location.file);
      const step = this.addStep(
        {
          kind: "variable_value",
          modulePath: [],
          label: `${name} in ${file}`,
          hit: c.hit,
          references: [],
          eligible: winner === i,
        },
        depth,
      );
      if (step?.changedInDiff && winner !== i && winnerHit) {
        this.note(
          `${c.hit.location.file}:${c.hit.location.startLine} changes ${name}, but ${winnerHit.location.file}:${winnerHit.location.startLine} sets the value that applies.`,
        );
      }
    });
    for (const hit of varFiles) {
      this.addStep(
        {
          kind: "variable_value",
          modulePath: [],
          label: `${name} in ${posix.basename(hit.location.file)} (loaded with -var-file)`,
          hit,
          references: [],
        },
        depth,
      );
    }

    // The default applies: the PR may have deleted the assignment that used to override it.
    if (winner !== null && cands[winner]?.isDefault) {
      const removed = await this.findRemovedTfvars(name);
      if (removed) {
        const file = removed.patch.oldPath!;
        const masked = this.sensitiveVar([], name) ? name : undefined;
        this.removedStep(removed, [], `${name} in ${file} removed by this PR`, depth, masked);
        this.note(`This PR deletes ${name} from ${file}: the variable's default applies instead.`);
      }
    }
  }

  /**
   * Assignments of a root variable in var files (not auto-loaded) that hold the plan's value: those
   * the PR changes when any do, else the other var files of the root module's directory.
   */
  private async varFileMatches(name: string, value: unknown): Promise<SourceHit[]> {
    const changed = [...this.ctx.diff.files.entries()]
      .filter(([f, fd]) => fd.status !== "deleted" && /\.tfvars(\.json)?$/.test(f))
      .map(([f]) => f);
    const hits = (await this.source.findVarFileAssignments(name, changed)).filter(
      (h) => h.literal && !hasPlaceholder(h.literal.value) && looseEqual(h.literal.value, value),
    );
    const inDiff = hits.filter((h) => this.touches(h.location));
    return (inDiff.length ? inDiff : hits).slice(0, 3);
  }

  /** An assignment of a root variable that the PR deleted from a .tfvars file (auto-loaded files first). */
  private async findRemovedTfvars(
    name: string,
  ): Promise<{ patch: Patch; block: { startLine: number; endLine: number }; text: string } | null> {
    const cache = this.patchCache();
    if (!cache) return null;
    const auto = new Set(await this.source.tfvarsFiles());
    const patches = cache.patches
      .filter((p) => p.oldPath && /\.tfvars(\.json)?$/.test(p.oldPath) && p.removed.size)
      .sort((a, b) => Number(auto.has(b.oldPath!)) - Number(auto.has(a.oldPath!)));
    for (const patch of patches) {
      const base = await this.baseText(cache, patch);
      if (base === null) continue;
      let span: { startLine: number; endLine: number } | null = null;
      if (patch.oldPath!.endsWith(".json")) {
        const s = jsonKeySpan(base.text, name);
        if (s) span = { startLine: s[0], endLine: s[1] };
      } else {
        span = [...base.body.attributes].reverse().find((a) => a.name === name) ?? null;
      }
      if (!span || !patch.removed.has(span.startLine)) continue;
      // Still assigned in the head file: an edit, which the head-side candidates already cover.
      const head = patch.newPath ? await this.source.workspace.readFile(patch.newPath) : null;
      if (head !== null && assigns(head, name, patch.newPath!.endsWith(".json"))) continue;
      return { patch, block: span, text: base.text };
    }
    return null;
  }

  private async traceLocal(name: string, scope: Scope, depth: number): Promise<void> {
    await this.shared(`local:${scope.modulePath.join(".")}:${name}`, depth, () =>
      this.traceLocalOnce(name, scope, depth),
    );
  }

  private async traceLocalOnce(name: string, scope: Scope, depth: number): Promise<void> {
    const hit = await this.source.findLocal(scope.modulePath, name);
    if (!hit) {
      if ((await this.source.moduleDir(scope.modulePath)) === null)
        await this.remoteModule(scope.modulePath, depth);
      else this.note(`local.${name} was not found in the module's .tf files.`);
      return;
    }
    const step = this.addStep(
      { kind: "local", modulePath: scope.modulePath, label: `local.${name}`, hit },
      depth,
    );
    if (step) await this.fileSteps(hit, scope.modulePath, depth + 1);
    if (step)
      await this.expand(
        hit.references,
        { modulePath: scope.modulePath, moduleInstance: scope.moduleInstance },
        depth + 1,
      );
  }

  private async traceModuleOutput(
    t: { call: string; key?: string | number; output?: string },
    scope: Scope,
    depth: number,
  ): Promise<void> {
    if (t.output === undefined) return;
    const output = t.output;
    const childPath = [...scope.modulePath, t.call];
    await this.shared(`output:${childPath.join(".")}:${output}`, depth, () =>
      this.traceModuleOutputOnce({ ...t, output }, childPath, scope, depth),
    );
  }

  private async traceModuleOutputOnce(
    t: { call: string; key?: string | number; output: string },
    childPath: string[],
    scope: Scope,
    depth: number,
  ): Promise<void> {
    const call = this.ctx.plan.modules[scope.modulePath.join(".")]?.moduleCalls[t.call];
    const repeated = Boolean(call?.countExpression || call?.forEachExpression);
    let childInstance: string | null | undefined;
    if (scope.moduleInstance === undefined || (repeated && t.key === undefined)) childInstance = undefined;
    else {
      const prefix = scope.moduleInstance ? `${scope.moduleInstance}.` : "";
      childInstance = `${prefix}module.${t.call}${t.key === undefined ? "" : formatKey(t.key)}`;
    }
    if ((await this.source.moduleDir(childPath)) === null) {
      await this.remoteModule(childPath, depth);
      return;
    }
    const hit = await this.source.findOutput(childPath, t.output);
    if (!hit) {
      this.note(`output "${t.output}" of module "${t.call}" was not found.`);
      return;
    }
    const step = this.addStep(
      { kind: "module_output", modulePath: childPath, label: `module "${t.call}" output ${t.output}`, hit },
      depth,
    );
    if (step) await this.fileSteps(hit, childPath, depth + 1);
    if (step)
      await this.expand(hit.references, { modulePath: childPath, moduleInstance: childInstance }, depth + 1);
  }

  /** A data source: its block, then the arguments the PR touched (or, when none, all of them). */
  private async traceData(type: string, name: string, scope: Scope, depth: number): Promise<void> {
    if (!this.once(`data:${scope.modulePath.join(".")}:${type}.${name}`)) return;
    const ref: ResourceRef = { mode: "data", type, name };
    const block = await this.source.findResource(scope.modulePath, ref);
    if (!block) {
      if ((await this.source.moduleDir(scope.modulePath)) === null)
        await this.remoteModule(scope.modulePath, depth);
      else this.note(`data.${type}.${name} was not found in the module's .tf files.`);
      return;
    }
    const read = this.findChanges(scope, ref, []).find((c) => c.action !== "no-op");
    const step = this.addStep(
      {
        kind: "upstream_resource",
        modulePath: scope.modulePath,
        label: `data.${type}.${name}`,
        hit: block,
        ...(read && { upstreamAddress: read.address }),
      },
      depth,
    );
    if (!step) return;
    const attrs = (await this.source.findResourceAttributes(scope.modulePath, ref)).slice(
      0,
      MAX_DATA_ATTRIBUTES,
    );
    const touched = attrs.filter((a) => this.hitTouched(a.hit));
    const inner: Scope = {
      modulePath: scope.modulePath,
      moduleInstance: scope.moduleInstance,
      resource: ref,
    };
    if (touched.length) {
      for (const a of touched) {
        const s = this.addStep(
          {
            kind: "resource_attribute",
            modulePath: scope.modulePath,
            label: `data.${type}.${name} ${a.path.join(".")}`,
            hit: a.hit,
          },
          depth + 1,
        );
        if (s) await this.fileSteps(a.hit, scope.modulePath, depth + 2);
        if (s) await this.expand(a.hit.references, { ...inner, dynamic: a.hit.dynamic ?? [] }, depth + 2);
      }
    } else {
      for (const a of attrs)
        await this.expand(a.hit.references, { ...inner, dynamic: a.hit.dynamic ?? [] }, depth + 1);
    }
  }

  /** Another resource the expression reads, when the plan also changes it in a way that flows here. */
  private async traceUpstream(
    t: { type: string; name: string; keys: (string | number)[]; attrs: string[]; whole: boolean },
    scope: Scope,
    depth: number,
  ): Promise<void> {
    const ref: ResourceRef = { mode: "managed", type: t.type, name: t.name };
    const relevant = this.findChanges(scope, ref, t.keys).filter((c) => {
      if (c.action === "replace" || c.action === "create") return true;
      if (c.action !== "update" && c.action !== "import") return false;
      if (t.whole || !t.attrs.length) return true;
      const changed = topLevel([...c.changedPaths, ...c.unknownPaths, ...c.sensitiveChangedPaths]);
      return t.attrs.some((a) => changed.has(a));
    });
    if (!relevant.length) return;
    if (relevant.length > MAX_UPSTREAM_INSTANCES) {
      this.note(
        `This value can come from ${relevant.length} changing instances of ${t.type}.${t.name}; the first ${MAX_UPSTREAM_INSTANCES} were traced.`,
      );
    }
    for (const up of relevant.slice(0, MAX_UPSTREAM_INSTANCES)) {
      if (this.chain.has(up.address) || !this.once(`up:${up.address}`)) continue;
      const block = await this.source.findResource(up.configModulePath, ref);
      const header = block ? { ...block.location, endLine: block.location.startLine } : undefined;
      const snippet = header ? ((await this.source.snippetAt(header)) ?? undefined) : undefined;
      const step = this.addStep(
        {
          kind: "upstream_resource",
          modulePath: up.configModulePath,
          label: `${up.address} (${up.action})`,
          ...(header && { location: header }),
          ...(snippet !== undefined && { snippet }),
          references: [],
          upstreamAddress: up.address,
        },
        depth,
      );
      if (!step) continue;
      this.upstream = true;
      if (this.upstreamLevel >= MAX_UPSTREAM_LEVELS || depth >= this.maxDepth) {
        this.note(`Stopped following upstream changes at ${up.address}.`);
        continue;
      }
      this.chain.add(up.address);
      this.upstreamLevel++;
      try {
        let attribute: AttrPath | undefined;
        if (up.action === "update" || up.action === "import") {
          // The attribute read here, when the configuration sets it; a computed one (id, arn, output)
          // changes because of the upstream's configured changes, which its own trace picks.
          const changed = topLevel([...up.changedPaths, ...up.unknownPaths, ...up.sensitiveChangedPaths]);
          const configured = this.configResource(up.configModulePath, refOf(up))?.expressions ?? {};
          const attr = t.attrs.find((a) => changed.has(a) && a in configured);
          if (attr) attribute = [attr];
        }
        await this.traceChangeBody(up, depth + 1, attribute);
      } finally {
        this.upstreamLevel--;
      }
    }
  }

  /** each.* / count.index → the for_each / count of the resource or of the module call. */
  private async traceRepetition(attr: "for_each" | "count", scope: Scope, depth: number): Promise<void> {
    if (scope.moduleCall) {
      const callPath = scope.moduleCall;
      if (!this.once(`rep:module:${callPath.join(".")}:${attr}`)) return;
      const hit = await this.source.findModuleArgument(callPath, attr);
      const name = callPath[callPath.length - 1]!;
      if (!hit) {
        this.note(`The ${attr} of module "${name}" was not found.`);
        return;
      }
      const parent = callPath.slice(0, -1);
      const step = this.addStep(
        { kind: "count_for_each", modulePath: parent, label: `module "${name}" ${attr}`, hit },
        depth,
      );
      // scope.moduleInstance is already the instance of `parent`, where the call is written.
      if (step)
        await this.expand(
          hit.references,
          { modulePath: parent, moduleInstance: scope.moduleInstance },
          depth + 1,
        );
      return;
    }
    if (!scope.resource) return;
    const ref = scope.resource;
    if (!this.once(`rep:res:${scope.modulePath.join(".")}:${configAddress(ref)}:${attr}`)) return;
    const hit = await this.source.findResourceAttribute(scope.modulePath, ref, [attr]);
    if (!hit) {
      this.note(`The ${attr} of ${configAddress(ref)} was not found.`);
      return;
    }
    const step = this.addStep(
      { kind: "count_for_each", modulePath: scope.modulePath, label: `${configAddress(ref)} ${attr}`, hit },
      depth,
    );
    if (step)
      await this.expand(
        hit.references,
        { modulePath: scope.modulePath, moduleInstance: scope.moduleInstance },
        depth + 1,
      );
  }

  /** The `enabled` meta-argument (OpenTofu: `lifecycle { enabled = … }`) of a resource it turned off. */
  private async traceEnabled(ref: ResourceRef, scope: Scope, depth: number): Promise<void> {
    if (!this.once(`enabled:${scope.modulePath.join(".")}:${configAddress(ref)}`)) return;
    const hit =
      (await this.source.findResourceAttribute(scope.modulePath, ref, ["lifecycle", "enabled"])) ??
      (await this.source.findResourceAttribute(scope.modulePath, ref, ["enabled"]));
    if (!hit) {
      this.note(`The enabled argument of ${configAddress(ref)} was not found.`);
      return;
    }
    const step = this.addStep(
      {
        kind: "resource_attribute",
        modulePath: scope.modulePath,
        label: `${configAddress(ref)} enabled`,
        hit,
      },
      depth,
    );
    if (step)
      await this.expand(
        hit.references,
        { modulePath: scope.modulePath, moduleInstance: scope.moduleInstance },
        depth + 1,
      );
  }

  private async traceDynamic(dyn: DynamicScope, scope: Scope, depth: number): Promise<void> {
    if (!dyn.forEach) return;
    const loc = dyn.forEach.location;
    if (!this.once(`dyn:${loc.file}:${loc.startLine}`)) return;
    const step = this.addStep(
      {
        kind: "count_for_each",
        modulePath: scope.modulePath,
        label: `dynamic "${dyn.label}" for_each`,
        hit: dyn.forEach,
      },
      depth,
    );
    const outer = (scope.dynamic ?? []).filter((d) => d !== dyn);
    if (step) await this.expand(dyn.forEach.references, { ...scope, dynamic: outer }, depth + 1);
  }

  /** A module whose code is not in the repository: its call's version / source lines, then a dead end. */
  private async remoteModule(path: readonly string[], depth: number): Promise<void> {
    // The innermost module call whose directory is unknown but whose parent is known.
    let callPath = [...path];
    while (callPath.length > 1 && (await this.source.moduleDir(callPath.slice(0, -1))) === null)
      callPath = callPath.slice(0, -1);
    if (!this.once(`remote:${callPath.join(".")}`)) return;
    const parent = callPath.slice(0, -1);
    const name = callPath[callPath.length - 1] ?? "";
    for (const attr of ["version", "source"]) {
      const hit = await this.source.findModuleArgument(callPath, attr);
      if (hit)
        this.addStep(
          {
            kind: "module_source",
            modulePath: parent,
            label: `module "${name}" ${attr}`,
            hit,
            references: [],
            changed: await this.moduleArgChanged(callPath, attr, hit),
          },
          depth,
        );
    }
    const source = this.ctx.plan.modules[parent.join(".")]?.moduleCalls[name]?.source;
    this.addStep(
      {
        kind: "unresolved",
        modulePath: callPath,
        label: `module "${name}" comes from ${source ? `"${source}"` : "a source"} outside the repository`,
        references: [],
      },
      depth,
    );
    for (const n of await this.source.moduleNotes(callPath)) this.note(n);
  }

  // ───────────── creates and deletes ─────────────

  private async traceCreate(change: ResourceChange, scope: Scope, depth: number): Promise<void> {
    const ref = refOf(change);
    const block = await this.source.findResource(scope.modulePath, ref);
    let isNew = false;
    if (block) {
      const header = { ...block.location, endLine: block.location.startLine };
      const step = this.addStep(
        {
          kind: "resource_block",
          modulePath: scope.modulePath,
          label: `${ref.mode === "data" ? "data" : "resource"} "${ref.type}" "${ref.name}"`,
          hit: block,
          location: header,
        },
        depth,
      );
      isNew = step?.changedInDiff ?? false;
    } else if ((await this.source.moduleDir(scope.modulePath)) === null) {
      await this.remoteModule(scope.modulePath, depth);
    } else {
      this.note(`${configAddress(ref)} was not found in the module's .tf files.`);
    }
    if (isNew) return;
    const config = this.configResource(scope.modulePath, ref);
    const repetition = config?.forEachExpression
      ? "for_each"
      : config?.countExpression
        ? "count"
        : change.index === undefined
          ? null
          : typeof change.index === "string"
            ? "for_each"
            : "count";
    if (repetition) await this.traceRepetition(repetition, { ...scope, moduleCall: undefined }, depth + 1);
    await this.traceModuleChain(change, depth + 1);
  }

  /** Enclosing module calls: a call the PR added explains everything inside; else their count / for_each. */
  private async traceModuleChain(change: ResourceChange, depth: number): Promise<void> {
    const path = change.configModulePath;
    const segments = change.moduleAddress ? splitModuleInstance(change.moduleAddress) : [];
    for (let level = path.length; level >= 1; level--) {
      const callPath = path.slice(0, level);
      const parent = callPath.slice(0, -1);
      const name = callPath[callPath.length - 1]!;
      const source = await this.source.findModuleArgument(callPath, "source");
      if (source && (await this.moduleArgChanged(callPath, "source", source))) {
        this.addStep(
          {
            kind: this.localModuleSource(callPath, source) ? "module_input" : "module_source",
            modulePath: parent,
            label: `module "${name}" source`,
            hit: source,
            references: [],
          },
          depth,
        );
        return;
      }
      const call = this.ctx.plan.modules[parent.join(".")]?.moduleCalls[name];
      const keyed = /\[[^\]]*\]$/.test(segments[level - 1] ?? "");
      const attr = call?.forEachExpression ? "for_each" : call?.countExpression ? "count" : null;
      if (!attr && !keyed) continue;
      const callerInstance =
        level === 1
          ? null
          : segments.length >= level - 1
            ? segments.slice(0, level - 1).join(".")
            : undefined;
      await this.traceRepetition(
        attr ?? "for_each",
        { modulePath: parent, moduleInstance: callerInstance, moduleCall: callPath },
        depth,
      );
    }
  }

  private async traceDelete(change: ResourceChange, scope: Scope, depth: number): Promise<void> {
    const path = change.configModulePath;
    for (let i = 1; i <= path.length; i++) {
      const callPath = path.slice(0, i);
      if (!this.ctx.plan.modules[callPath.join(".")]) {
        // The plan's configuration lacks the call; the repository may still have it (a plan JSON
        // without its configuration section).
        if (await this.source.findModuleCall(callPath)) continue;
        await this.traceRemovedModule(change, callPath, depth);
        return;
      }
    }
    const ref = refOf(change);
    const config = this.configResource(path, ref);
    const configured = config ? null : await this.source.findResource(path, ref);
    if (configured) {
      this.note(
        `${configAddress(ref)} is missing from the plan's configuration but is still in ${configured.location.file}:${configured.location.startLine}.`,
      );
    }
    if (config || configured) {
      const repetition =
        config?.forEachExpression || typeof change.index === "string"
          ? "for_each"
          : config?.countExpression || typeof change.index === "number"
            ? "count"
            : null;
      const before = this.steps.length;
      const block = await this.source.findResource(path, ref);
      // OpenTofu's `enabled` meta-argument turned the resource off: that argument is the cause.
      const disabled = change.actionReason === "delete_because_enabled_false";
      if (block) {
        const gone = disabled
          ? "enabled = false"
          : change.index !== undefined
            ? `instance ${formatKey(change.index)} no longer exists`
            : change.moduleAddress && /\]$/.test(change.moduleAddress)
              ? `module instance ${change.moduleAddress} no longer exists`
              : "still configured";
        this.addStep(
          {
            kind: "resource_block",
            modulePath: path,
            label: `${ref.mode === "data" ? "data" : "resource"} "${ref.type}" "${ref.name}" (${gone})`,
            hit: block,
            location: { ...block.location, endLine: block.location.startLine },
            references: [],
          },
          depth,
        );
      }
      if (disabled) await this.traceEnabled(ref, scope, depth + 1);
      else if (repetition && change.index !== undefined)
        await this.traceRepetition(repetition, scope, depth + 1);
      await this.traceModuleChain(change, depth + 1);
      if (this.steps.length - before <= 1)
        this.note(
          `${change.address} is still configured; Terraform deletes it (${change.actionReason ?? "no reason given"}).`,
        );
      return;
    }
    await this.traceRemovedResource(change, depth);
  }

  private patchCache(): PatchCache | null {
    const text = this.ctx.diffText;
    if (!text) return null;
    let cache = patchCaches.get(this.ctx);
    if (!cache || cache.text !== text) {
      cache = { text, patches: parsePatches(text), base: new Map() };
      patchCaches.set(this.ctx, cache);
    }
    return cache;
  }

  /** The base version of a patched file and its parse, cached per diff. */
  private baseText(cache: PatchCache, patch: Patch): Promise<{ text: string; body: HclBody } | null> {
    let base = cache.base.get(patch);
    if (!base) {
      base = (async () => {
        const head = patch.newPath ? await this.source.workspace.readFile(patch.newPath) : null;
        const text = reconstructBase(patch, head);
        return { text, body: parseHcl(text) };
      })().catch(() => null);
      cache.base.set(patch, base);
    }
    return base;
  }

  /** A block the PR removed (its first line is a removed line) in the base version of a dir's .tf files. */
  private async findRemovedBlock(
    dir: string | null,
    match: (b: HclBlock) => boolean,
  ): Promise<{ patch: Patch; block: HclBlock; text: string } | null> {
    const cache = this.patchCache();
    if (!cache) return null;
    for (const patch of cache.patches) {
      const old = patch.oldPath;
      if (!old || !old.endsWith(".tf")) continue;
      if (dir !== null && normalizePath(posix.dirname(old)).replace(/^\.$/, "") !== dir) continue;
      const base = await this.baseText(cache, patch);
      if (base === null) continue;
      for (const block of base.body.blocks) {
        if (match(block) && patch.removed.has(block.startLine)) return { patch, block, text: base.text };
      }
    }
    return null;
  }

  /** An attribute (top-level or in nested blocks) of a resource that the PR deleted, in the base file. */
  private async findRemovedAttribute(
    modulePath: readonly string[],
    ref: ResourceRef,
    path: AttrPath,
  ): Promise<{ patch: Patch; block: { startLine: number; endLine: number }; text: string } | null> {
    const cache = this.patchCache();
    if (!cache) return null;
    const dir = await this.source.moduleDir(modulePath);
    const kind = ref.mode === "data" ? "data" : "resource";
    const names = path.filter((s): s is string => typeof s === "string");
    for (const patch of cache.patches) {
      const old = patch.oldPath;
      if (!old || !old.endsWith(".tf") || !patch.removed.size) continue;
      if (dir !== null && normalizePath(posix.dirname(old)).replace(/^\.$/, "") !== dir) continue;
      const base = await this.baseText(cache, patch);
      if (base === null) continue;
      const text = base.text;
      for (const block of base.body.blocks) {
        if (block.type !== kind || block.labels[0] !== ref.type || block.labels[1] !== ref.name) continue;
        // Walk the string steps through nested blocks; the first matching attribute that was removed
        // wins (or, for a path ending at a block element, the removed nested block).
        const element = typeof path[path.length - 1] === "number";
        let bodies = [block.body];
        for (let i = 0; i < names.length && bodies.length; i++) {
          for (const body of bodies) {
            const attr = body.attributes.find((a) => a.name === names[i]);
            if (attr && patch.removed.has(attr.startLine)) return { patch, block: attr, text };
            if (element && i === names.length - 1) {
              const nb = body.blocks.find((b) => b.type === names[i] && patch.removed.has(b.startLine));
              if (nb) return { patch, block: nb, text };
            }
          }
          bodies = bodies.flatMap((b) => b.blocks.filter((nb) => nb.type === names[i]).map((nb) => nb.body));
        }
      }
    }
    return null;
  }

  /** An argument of a module call that the PR deleted, in the base version of the parent's .tf files. */
  private async findRemovedModuleArgument(
    callPath: readonly string[],
    name: string,
  ): Promise<{ patch: Patch; block: { startLine: number; endLine: number }; text: string } | null> {
    const cache = this.patchCache();
    if (!cache) return null;
    const dir = await this.source.moduleDir(callPath.slice(0, -1));
    const call = callPath[callPath.length - 1];
    for (const patch of cache.patches) {
      const old = patch.oldPath;
      if (!old || !old.endsWith(".tf") || !patch.removed.size) continue;
      if (dir !== null && normalizePath(posix.dirname(old)).replace(/^\.$/, "") !== dir) continue;
      const base = await this.baseText(cache, patch);
      if (base === null) continue;
      for (const block of base.body.blocks) {
        if (block.type !== "module" || block.labels[0] !== call) continue;
        const attr = block.body.attributes.find((a) => a.name === name);
        if (attr && patch.removed.has(attr.startLine)) return { patch, block: attr, text: base.text };
      }
    }
    return null;
  }

  /**
   * Whether the PR changes the value of a module call argument (`source`, `version`): the call or
   * the argument is new, or its value differs from the base version. Realigning the line (terraform
   * fmt after another argument was added) is not a change.
   */
  private async moduleArgChanged(
    callPath: readonly string[],
    attr: string,
    hit: SourceHit,
  ): Promise<boolean> {
    if (!this.touches(hit.location) || !this.addsLines(hit.location)) return false;
    const cache = this.patchCache();
    const file = normalizePath(hit.location.file);
    const patch = cache?.patches.find((p) => p.newPath === file);
    if (!cache || !patch) return true;
    const base = await this.baseText(cache, patch);
    if (base === null) return true;
    const call = callPath[callPath.length - 1];
    const block = base.body.blocks.find((b) => b.type === "module" && b.labels[0] === call);
    const old = block?.body.attributes.find((a) => a.name === attr);
    if (!old) return true;
    const head = await this.source.workspace.readFile(file);
    const now = head === null ? undefined : moduleArgText(head, call, attr);
    if (now === undefined) return true;
    const a = evaluateLiteral(old.exprText);
    const b = evaluateLiteral(now);
    if (a.ok && b.ok) return !deepEqual(a.value, b.value);
    return old.exprText.replace(/\s+/g, "") !== now.replace(/\s+/g, "");
  }

  /**
   * Whether a module call's source is a local path (`./…`, `../…`) at head: such a module has no
   * version, and changing its source is a code change in the repo, never a version bump.
   */
  private localModuleSource(callPath: readonly string[], source: SourceHit | null): boolean {
    const name = callPath[callPath.length - 1]!;
    const call = this.ctx.plan.modules[callPath.slice(0, -1).join(".")]?.moduleCalls[name];
    const literal = call?.source ?? source?.literal?.value;
    return typeof literal === "string" && /^\.\.?[\\/]/.test(literal);
  }

  /** Whether a variable of a module is declared sensitive (its values are never shown). */
  private sensitiveVar(path: readonly string[], name: string): boolean {
    if (this.ctx.plan.modules[path.join(".")]?.variables[name]?.sensitive) return true;
    return path.length === 0 && this.ctx.plan.variables[name]?.sensitive === true;
  }

  /** `maskedName`: the removed code assigns a sensitive variable; its snippet shows no value. */
  private removedStep(
    found: { patch: Patch; block: { startLine: number; endLine: number }; text: string },
    modulePath: string[],
    label: string,
    depth: number,
    maskedName?: string,
  ): Step | null {
    return this.addStep(
      {
        kind: "removed_code",
        modulePath,
        label,
        location: {
          file: found.patch.oldPath!,
          startLine: found.block.startLine,
          endLine: found.block.endLine,
          side: "base",
        },
        snippet:
          maskedName !== undefined
            ? `${maskedName} = ${SENSITIVE_PLACEHOLDER}`
            : makeSnippet(found.text, found.block.startLine, found.block.endLine),
        references: [],
      },
      depth,
    );
  }

  private noRemovedCode(what: string): void {
    if (!this.ctx.diffText) {
      this.note(`No PR diff was available to locate the removed ${what}.`);
      return;
    }
    this.note(
      `The ${what} is gone from the configuration, but this PR's diff does not remove it: it was removed before this PR, or in files outside the diff.`,
    );
    this.external = true;
  }

  private async traceRemovedResource(change: ResourceChange, depth: number): Promise<void> {
    const ref = refOf(change);
    const kind = ref.mode === "data" ? "data" : "resource";
    const dir = await this.source.moduleDir(change.configModulePath);
    const match = (b: HclBlock): boolean =>
      b.type === kind && b.labels[0] === ref.type && b.labels[1] === ref.name;
    const found = await this.findRemovedBlock(dir, match);
    if (!found) {
      this.noRemovedCode(`${kind} block ${configAddress(ref)}`);
      return;
    }
    const sibling = await this.addedSibling(found.patch, kind, ref);
    const renamed = sibling?.name ?? null;
    const { startLine } = found.block;
    if (sibling && Tracer.labelOnly(found)) {
      // Only the block's label line changed: a rename. Point at that line (base) and the new label
      // line (head), not the whole body, which the PR kept.
      const step = this.removedStep(
        { ...found, block: { startLine, endLine: startLine } },
        change.configModulePath,
        `renames ${kind} "${ref.type}" "${ref.name}" to "${sibling.name}" without a moved block`,
        depth,
      );
      if (step) {
        const location = { file: sibling.file, startLine: sibling.line, endLine: sibling.line };
        const snippet = (await this.source.snippetAt(location)) ?? undefined;
        this.addStep(
          {
            kind: "resource_block",
            modulePath: change.configModulePath,
            label: `${kind} "${ref.type}" "${sibling.name}" (the new name)`,
            location,
            ...(snippet !== undefined && { snippet }),
            references: [],
          },
          depth + 1,
        );
      }
      return;
    }
    this.removedStep(
      found,
      change.configModulePath,
      `${kind} "${ref.type}" "${ref.name}" removed by this PR`,
      depth,
    );
    if (renamed) {
      this.note(
        `This PR adds ${kind} "${ref.type}" "${renamed}" in ${found.patch.newPath}: if that is a rename, a moved block (moved { from = ${configAddress(ref)} to = ${configAddress({ ...ref, name: renamed })} }) keeps the existing object instead of destroying it.`,
      );
    }
  }

  /** A block of the same type the PR adds in the same file (a rename without a moved block). */
  private addedSibling(
    patch: Patch,
    kind: string,
    ref: ResourceRef,
  ): Promise<{ name: string; file: string; line: number } | null> {
    return this.addedBlockNamed(patch, (b) =>
      b.type === kind && b.labels[0] === ref.type && b.labels[1] !== ref.name ? b.labels[1] : undefined,
    );
  }

  /** The first block whose label line the PR adds in the patch's head file and `nameOf` names. */
  private async addedBlockNamed(
    patch: Patch,
    nameOf: (b: HclBlock) => string | undefined,
  ): Promise<{ name: string; file: string; line: number } | null> {
    if (!patch.newPath) return null;
    const head = await this.source.workspace.readFile(patch.newPath);
    const fd = this.ctx.diff.files.get(patch.newPath);
    if (head === null || !fd) return null;
    for (const b of parseHcl(head).blocks) {
      const name = nameOf(b);
      if (name !== undefined && fd.addedLines.has(b.startLine))
        return { name, file: patch.newPath, line: b.startLine };
    }
    return null;
  }

  /** Only the label line of a removed block changed (fewer than half its lines removed): a rename. */
  private static labelOnly(found: { patch: Patch; block: { startLine: number; endLine: number } }): boolean {
    const { startLine, endLine } = found.block;
    let removedInside = 0;
    for (let l = startLine; l <= endLine; l++) if (found.patch.removed.has(l)) removedInside++;
    return removedInside * 2 <= endLine - startLine + 1;
  }

  private async traceRemovedModule(change: ResourceChange, callPath: string[], depth: number): Promise<void> {
    const parent = callPath.slice(0, -1);
    const name = callPath[callPath.length - 1]!;
    const parentDir = await this.source.moduleDir(parent);
    const call = await this.findRemovedBlock(parentDir, (b) => b.type === "module" && b.labels[0] === name);
    if (!call) {
      this.noRemovedCode(`module "${name}" call`);
      return;
    }
    const sibling = await this.addedBlockNamed(call.patch, (b) =>
      b.type === "module" && b.labels[0] !== name ? b.labels[0] : undefined,
    );
    if (sibling && Tracer.labelOnly(call)) {
      // Only the call's label changed: a module rename without a moved block. Point at the label
      // line (base) and the new one (head), not the whole call, which the PR kept.
      const step = this.removedStep(
        { ...call, block: { startLine: call.block.startLine, endLine: call.block.startLine } },
        parent,
        `renames module "${name}" to "${sibling.name}" without a moved block`,
        depth,
      );
      if (step) {
        const location = { file: sibling.file, startLine: sibling.line, endLine: sibling.line };
        const snippet = (await this.source.snippetAt(location)) ?? undefined;
        this.addStep(
          {
            kind: "module_input",
            modulePath: parent,
            label: `module "${sibling.name}" (the new name)`,
            location,
            ...(snippet !== undefined && { snippet }),
            references: [],
          },
          depth + 1,
        );
      }
      this.note(
        `Renaming the module "${name}" call without a moved block destroys every resource in it and creates them again under module.${sibling.name}.`,
      );
      return;
    }
    let callDepth = depth;
    // The resource's own block, when it sits directly in the removed module's (deleted or kept) files.
    if (callPath.length === change.configModulePath.length && parentDir !== null) {
      const src = call.block.body.attributes.find((a) => a.name === "source");
      const lit = src ? evaluateLiteral(src.exprText) : null;
      const childDir =
        lit?.ok && typeof lit.value === "string" && /^\.\.?\//.test(lit.value)
          ? joinRepoPath(parentDir, lit.value)
          : null;
      if (childDir !== null) {
        const ref = refOf(change);
        const kind = ref.mode === "data" ? "data" : "resource";
        const res = await this.findRemovedBlock(
          childDir,
          (b) => b.type === kind && b.labels[0] === ref.type && b.labels[1] === ref.name,
        );
        if (
          res &&
          this.removedStep(
            res,
            callPath,
            `${kind} "${ref.type}" "${ref.name}" (file removed by this PR)`,
            depth,
          )
        )
          callDepth = depth + 1;
      }
    }
    this.removedStep(call, parent, `module "${name}" removed by this PR`, callDepth);
    this.note(`Removing the module "${name}" call destroys every resource in it.`);
  }

  // ───────────── fallbacks ─────────────

  /** When nothing traced so far is in the diff: module versions, provider versions, drift. */
  private async fallbacks(change: ResourceChange): Promise<void> {
    const path = change.configModulePath;
    for (let level = path.length; level >= 1; level--) {
      const callPath = path.slice(0, level);
      const name = callPath[level - 1]!;
      const source = await this.source.findModuleArgument(callPath, "source");
      // Only a remote module has a version to change (DESIGN.md); a local path is code in the repo, so
      // pointing the call at another local directory is an ordinary code change (module_input).
      const local = this.localModuleSource(callPath, source);
      for (const attr of local ? ["source"] : ["version", "source"]) {
        const hit = attr === "source" ? source : await this.source.findModuleArgument(callPath, attr);
        if (hit && (await this.moduleArgChanged(callPath, attr, hit))) {
          this.addStep(
            {
              kind: local ? "module_input" : "module_source",
              modulePath: callPath.slice(0, -1),
              label: `module "${name}" ${attr}`,
              hit,
              references: [],
            },
            1,
          );
        }
      }
    }
    const local = providerLocalName(change.providerName);
    const required = await this.source.findRequiredProvider(local);
    if (required && this.touches(required.location)) {
      this.addStep(
        {
          kind: "provider_config",
          modulePath: [],
          label: `required_providers ${local} version`,
          hit: required,
        },
        1,
      );
    }
    if (change.providerName.includes("/")) {
      const locked = await this.source.findLockedProvider(change.providerName);
      if (locked && this.touches(locked.location)) {
        this.addStep(
          {
            kind: "provider_config",
            modulePath: [],
            label: `${change.providerName} version in the lock file`,
            hit: locked,
          },
          1,
        );
      }
    }
    if (this.hasRootCause()) {
      this.note(
        "No code on the traced path changed; a module or provider version change in this PR is the likely cause.",
      );
      return;
    }
    if (this.ctx.plan.drift.some((d) => d.address === change.address)) {
      this.note(
        "Terraform detected changes made outside Terraform on this resource (drift); the plan reverts them.",
      );
      this.external = true;
    }
  }
}

/** The expression text of an argument of `module "call"` in a .tf file's text. */
function moduleArgText(text: string, call: string | undefined, attr: string): string | undefined {
  for (const b of parseHcl(text).blocks) {
    if (b.type !== "module" || b.labels[0] !== call) continue;
    const a = b.body.attributes.find((x) => x.name === attr);
    if (a) return a.exprText;
  }
  return undefined;
}

/** Whether a .tfvars (HCL or JSON) text assigns `name` at the top level. */
function assigns(text: string, name: string, json: boolean): boolean {
  if (!json) return parseHcl(text).attributes.some((a) => a.name === name);
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && name in parsed;
  } catch {
    return false;
  }
}

function idNum(s: LineageStep): number {
  return Number(s.id.slice(1));
}
