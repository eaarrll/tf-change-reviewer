/*
 * Locates configuration objects of a plan in the repository's .tf / .tfvars files: resource blocks
 * and their (nested, dynamic) attributes, module calls and arguments, variables and defaults,
 * locals, outputs, provider blocks and tfvars assignments. Module paths map to directories through
 * the plan's module sources (local paths) or `.terraform/modules/modules.json` (remote modules).
 *
 * Every finder returns null / [] when it cannot find the object and never throws. Snippets are
 * masked (maskSourceText); raw text stays inside this module except as `literal` values, which
 * callers only compare and never output.
 */
import { posix } from "node:path";
import { maskSourceText } from "../redact.js";
import { deepEqual } from "../plan/paths.js";
import { normalizeRepoPath } from "../workspace.js";
import { SENSITIVE_PLACEHOLDER } from "../types.js";
import type { AttrPath, PlanModel, SourceLocation, Workspace } from "../types.js";
import {
  evaluateLiteral,
  findReferences,
  locateObjectKey,
  parseHcl,
  type HclAttribute,
  type HclBlock,
  type HclBody,
} from "./hcl.js";

export const MAX_SNIPPET_CHARS = 300;

export interface SourceHit {
  location: SourceLocation;
  /** Masked source text, at most MAX_SNIPPET_CHARS. */
  snippet: string;
  /** References of the expression (attributes) or of every argument (blocks), Terraform style. */
  references: string[];
  /** Value of a literal expression. May be sensitive: compare it, never output it. */
  literal?: { value: unknown };
  /** Enclosing `dynamic` blocks of a nested attribute, innermost last. */
  dynamic?: DynamicScope[];
  /**
   * Repo paths of files the expression reads with file(), templatefile(), filebase64() … when the
   * path is a literal, optionally under `${path.module}` / `${path.root}` / `${path.cwd}`.
   */
  files?: string[];
}

export interface DynamicScope {
  /** Block type the dynamic block generates (its label). */
  label: string;
  /** Iterator name (`iterator = x`, default: the label). */
  iterator: string;
  /** The dynamic block's for_each argument. */
  forEach: SourceHit | null;
}

export interface ResourceRef {
  mode: "managed" | "data";
  type: string;
  name: string;
}

export interface NestedAttribute {
  /** Block types and attribute name from the resource body, e.g. ["statement", "actions"]. */
  path: string[];
  hit: SourceHit;
}

interface ParsedFile {
  path: string;
  /** Raw lines (CRLF normalized). Internal only. */
  lines: string[];
  /** maskSourceText applied to the whole file, same line numbering. */
  maskedLines: string[];
  body: HclBody;
}

interface FoundBlock {
  file: ParsedFile;
  block: HclBlock;
}

interface Candidate {
  file: ParsedFile;
  attr: HclAttribute;
  startLine: number;
  endLine: number;
  dynamic: DynamicScope[];
  /** Every numeric path step matched the ordinal of a static block. */
  ordinalMatch: boolean;
  /** The outermost matched nested block (span and body, for value hints), or null. */
  outer: { span: [number, number]; body: HclBody } | null;
  override: boolean;
  /** The path ends at a nested block element (`["ingress", 1]`): the block itself is the hit. */
  block?: HclBlock;
}

const TFVARS_SUFFIXES = [".tfvars", ".tfvars.json"] as const;
const MANIFEST = ".terraform/modules/modules.json";
const LOCK_FILE = ".terraform.lock.hcl";

/** Masked text of lines [start, end] of `text`, dedented and capped at MAX_SNIPPET_CHARS. */
export function makeSnippet(text: string, startLine: number, endLine: number): string {
  return snippetFromLines(maskSourceText(text).split(/\r?\n/), startLine, endLine);
}

function snippetFromLines(lines: string[], startLine: number, endLine: number): string {
  const slice = lines.slice(Math.max(0, startLine - 1), Math.max(startLine, endLine));
  const indents = slice.filter((l) => l.trim() !== "").map((l) => /^[ \t]*/.exec(l)![0].length);
  const indent = indents.length ? Math.min(...indents) : 0;
  const text = slice
    .map((l) => l.slice(Math.min(indent, /^[ \t]*/.exec(l)![0].length)).trimEnd())
    .join("\n")
    .trim();
  const chars = [...text];
  return chars.length <= MAX_SNIPPET_CHARS ? text : `${chars.slice(0, MAX_SNIPPET_CHARS - 1).join("")}…`;
}

function isOverrideFile(path: string): boolean {
  const base = posix.basename(path);
  return base === "override.tf" || base.endsWith("_override.tf");
}

function isLocalSource(source: string | undefined): source is string {
  return source !== undefined && /^\.\.?[\\/]/.test(source);
}

/** `dir` joined with a relative path, normalized; null when it escapes the repository. */
export function joinRepoPath(dir: string, rel: string): string | null {
  return normalizeRepoPath(posix.join(dir === "" ? "." : dir, rel.replace(/\\/g, "/")));
}

/** Functions whose first argument is a file path read at plan time. */
const FILE_FUNCTIONS =
  /\b(?:file|templatefile|filebase64|filemd5|filesha1|filesha256|filesha512|filebase64sha256|filebase64sha512)\s*\(\s*("(?:[^"\\\r\n]|\\.)*")/g;

/**
 * Repo paths of the files an expression reads: `file("x.json")`, `file("${path.module}/p.json")`,
 * `templatefile("${path.root}/t.tpl", …)`. Relative paths resolve from the root module directory
 * (Terraform's working directory); paths built from other values are skipped.
 */
export function filesRead(exprText: string, moduleDir: string, rootDir: string): string[] {
  if (!exprText.includes("file")) return [];
  const out = new Set<string>();
  for (const m of exprText.matchAll(FILE_FUNCTIONS)) {
    let raw: string;
    try {
      raw = JSON.parse(m[1]!) as string;
    } catch {
      continue;
    }
    let base = rootDir;
    const prefix = /^\$\{\s*path\.(module|root|cwd)\s*\}\/?/.exec(raw);
    if (prefix) {
      base = prefix[1] === "module" ? moduleDir : rootDir;
      raw = raw.slice(prefix[0].length);
    }
    if (raw === "" || /\$\{|%\{/.test(raw)) continue;
    const path = joinRepoPath(base, raw);
    if (path !== null && path !== "") out.add(path);
  }
  return [...out];
}

export class SourceIndex {
  private readonly parsed = new Map<string, Promise<ParsedFile | null>>();
  private readonly dirs = new Map<string, Promise<string | null>>();
  private readonly dirFiles = new Map<string, Promise<string[]>>();
  private readonly dirNotes = new Map<string, string[]>();
  private manifest: Promise<Map<string, string>> | null = null;
  /** Repo-relative root module directory ("" = repository root). */
  readonly rootDir: string;

  constructor(
    readonly workspace: Workspace,
    readonly plan: PlanModel,
  ) {
    this.rootDir = normalizeRepoPath(workspace.rootModuleDir) ?? "";
  }

  // ───────────────────────────── files and directories ─────────────────────────────

  /** Repo directory of a config module path; null for remote modules without a manifest entry. */
  moduleDir(path: readonly string[]): Promise<string | null> {
    const key = path.join(".");
    let dir = this.dirs.get(key);
    if (!dir) {
      dir = this.resolveModuleDir([...path]).catch(() => null);
      this.dirs.set(key, dir);
    }
    return dir;
  }

  private async resolveModuleDir(path: string[]): Promise<string | null> {
    if (path.length === 0) return this.rootDir;
    const parentPath = path.slice(0, -1);
    const name = path[path.length - 1]!;
    const call = this.plan.modules[parentPath.join(".")]?.moduleCalls[name];
    let source = call?.source ?? this.plan.modules[path.join(".")]?.source;
    if (source === undefined) {
      // A plan without that module's configuration (a slimmed plan): the call's literal source.
      const block = await this.moduleCallBlock(path);
      const attr = block?.block.body.attributes.find((a) => a.name === "source");
      const lit = attr ? evaluateLiteral(attr.exprText) : null;
      if (lit?.ok && typeof lit.value === "string") source = lit.value;
    }
    if (isLocalSource(source)) {
      const parent = await this.moduleDir(parentPath);
      if (parent !== null) return joinRepoPath(parent, source);
    }
    return (await this.loadManifest()).get(path.join(".")) ?? null;
  }

  private loadManifest(): Promise<Map<string, string>> {
    this.manifest ??= (async () => {
      const out = new Map<string, string>();
      const file = joinRepoPath(this.rootDir, MANIFEST);
      const text = file === null ? null : await this.workspace.readFile(file);
      if (!text) return out;
      try {
        const parsed = JSON.parse(text) as { Modules?: unknown };
        if (!Array.isArray(parsed.Modules)) return out;
        for (const entry of parsed.Modules as Array<Record<string, unknown>>) {
          if (typeof entry?.Key !== "string" || typeof entry.Dir !== "string") continue;
          if (entry.Dir.startsWith("/") || /^[A-Za-z]:/.test(entry.Dir)) continue;
          const dir = joinRepoPath(this.rootDir, entry.Dir);
          if (dir !== null) out.set(entry.Key, dir);
        }
      } catch {
        // A malformed manifest only means remote modules stay unresolved.
      }
      return out;
    })().catch(() => new Map<string, string>());
    return this.manifest;
  }

  /** The .tf files of a directory: regular files first, then override files (Terraform's merge order). */
  private configFilesIn(dir: string): Promise<string[]> {
    let files = this.dirFiles.get(dir);
    if (!files) {
      files = (async () => {
        const listed = await this.workspace.listFiles(dir, [".tf", ".tf.json"]).catch(() => [] as string[]);
        const json = listed.filter((f) => f.endsWith(".tf.json"));
        if (json.length) {
          this.dirNotes.set(dir, [
            `${json.join(", ")}: JSON configuration is not searched; lineage may miss code defined there.`,
          ]);
        }
        const tf = listed.filter((f) => f.endsWith(".tf"));
        return [...tf.filter((f) => !isOverrideFile(f)), ...tf.filter(isOverrideFile)];
      })();
      this.dirFiles.set(dir, files);
    }
    return files;
  }

  /** The .tf files of a config module, or [] when its directory is unknown. */
  async moduleFiles(path: readonly string[]): Promise<string[]> {
    const dir = await this.moduleDir(path);
    return dir === null ? [] : this.configFilesIn(dir);
  }

  /** Notes about a module's directory (unresolved remote source, skipped JSON files). */
  async moduleNotes(path: readonly string[]): Promise<string[]> {
    const dir = await this.moduleDir(path);
    if (dir === null) {
      const parent = this.plan.modules[path.slice(0, -1).join(".")];
      const source = parent?.moduleCalls[path[path.length - 1] ?? ""]?.source;
      return [
        `module.${path.join(".module.")} comes from ${source ? `"${source}"` : "an unknown source"}, which is not in the repository (run terraform init to resolve remote modules through ${MANIFEST}).`,
      ];
    }
    await this.configFilesIn(dir);
    return this.dirNotes.get(dir) ?? [];
  }

  private file(path: string): Promise<ParsedFile | null> {
    let file = this.parsed.get(path);
    if (!file) {
      file = (async () => {
        const text = await this.workspace.readFile(path);
        if (text === null) return null;
        return {
          path,
          lines: text.replace(/^﻿/, "").split(/\r?\n/),
          maskedLines: maskSourceText(text.replace(/^﻿/, "")).split(/\r?\n/),
          body: parseHcl(text),
        };
      })().catch(() => null);
      this.parsed.set(path, file);
    }
    return file;
  }

  /** Masked text of a repo file's line range (any file the workspace can read). */
  async snippetAt(location: SourceLocation): Promise<string | null> {
    const file = await this.file(location.file);
    return file ? snippetFromLines(file.maskedLines, location.startLine, location.endLine) : null;
  }

  private async blocksIn(
    path: readonly string[],
    match: (b: HclBlock) => boolean,
  ): Promise<{ found: FoundBlock; override: boolean }[]> {
    const out: { found: FoundBlock; override: boolean }[] = [];
    for (const f of await this.moduleFiles(path)) {
      const file = await this.file(f);
      if (!file) continue;
      for (const block of file.body.blocks) {
        if (match(block)) out.push({ found: { file, block }, override: isOverrideFile(f) });
      }
    }
    return out;
  }

  // ───────────────────────────── hits ─────────────────────────────

  private hit(
    file: ParsedFile,
    startLine: number,
    endLine: number,
    extra: Partial<SourceHit> = {},
  ): SourceHit {
    return {
      location: { file: file.path, startLine, endLine },
      snippet: snippetFromLines(file.maskedLines, startLine, endLine),
      references: [],
      ...extra,
    };
  }

  private attrHit(file: ParsedFile, attr: HclAttribute, extra: Partial<SourceHit> = {}): SourceHit {
    const literal = evaluateLiteral(attr.exprText);
    const iterators = (extra.dynamic ?? []).map((d) => d.iterator);
    const files = filesRead(attr.exprText, posix.dirname(file.path).replace(/^\.$/, ""), this.rootDir);
    return this.hit(file, attr.startLine, attr.endLine, {
      references: findReferences(attr.exprText, iterators),
      ...(literal.ok && { literal: { value: literal.value } }),
      ...(files.length > 0 && { files }),
      ...extra,
    });
  }

  private blockHit(file: ParsedFile, block: HclBlock): SourceHit {
    const refs = new Set<string>();
    const visit = (body: HclBody): void => {
      for (const a of body.attributes) for (const r of findReferences(a.exprText)) refs.add(r);
      for (const b of body.blocks) visit(b.body);
    };
    visit(block.body);
    return this.hit(file, block.startLine, block.endLine, { references: [...refs] });
  }

  private async safe<T>(fallback: T, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  }

  // ───────────────────────────── resources ─────────────────────────────

  private resourceBlocks(path: readonly string[], ref: ResourceRef) {
    const kind = ref.mode === "data" ? "data" : "resource";
    return this.blocksIn(
      path,
      (b) => b.type === kind && b.labels[0] === ref.type && b.labels[1] === ref.name,
    );
  }

  /** The `resource "type" "name"` (or `data`) block. */
  findResource(path: readonly string[], ref: ResourceRef): Promise<SourceHit | null> {
    return this.safe(null, async () => {
      const blocks = await this.resourceBlocks(path, ref);
      const base = blocks.find((b) => !b.override) ?? blocks[0];
      return base ? this.blockHit(base.found.file, base.found.block) : null;
    });
  }

  /**
   * An attribute of a resource, through nested and dynamic blocks: ["ingress", 0, "cidr_blocks"].
   * Set-typed blocks have no stable index, so every instance of the block type is a candidate; the
   * one whose text contains the most `hints` values (e.g. the planned block value) wins, then the
   * ordinal match. A path that continues into a map value (["tags", "Name"]) narrows to the key's
   * line when the map is written inline. Override files win over regular ones.
   */
  findResourceAttribute(
    path: readonly string[],
    ref: ResourceRef,
    attr: AttrPath,
    hints: readonly unknown[] = [],
  ): Promise<SourceHit | null> {
    return this.safe(null, async () => {
      const blocks = await this.resourceBlocks(path, ref);
      const candidates: Candidate[] = [];
      for (const { found, override } of blocks) {
        this.searchBody(found.file, found.block.body, attr, 0, [], true, null, override, candidates);
      }
      return this.pick(candidates, hints);
    });
  }

  /** Every attribute of a resource/data block, nested blocks included (for data sources). */
  findResourceAttributes(path: readonly string[], ref: ResourceRef): Promise<NestedAttribute[]> {
    return this.safe([], async () => {
      const blocks = await this.resourceBlocks(path, ref);
      const base = blocks.find((b) => !b.override) ?? blocks[0];
      if (!base) return [];
      const out: NestedAttribute[] = [];
      const visit = (body: HclBody, prefix: string[], dyn: DynamicScope[]): void => {
        for (const a of body.attributes) {
          out.push({ path: [...prefix, a.name], hit: this.attrHit(base.found.file, a, dynExtra(dyn)) });
        }
        for (const b of body.blocks) {
          if (b.type === "dynamic") {
            const scope = this.dynamicScope(base.found.file, b);
            const content = b.body.blocks.find((c) => c.type === "content");
            if (scope && content) visit(content.body, [...prefix, scope.label], [...dyn, scope]);
          } else visit(b.body, [...prefix, b.type], dyn);
        }
      };
      visit(base.found.block.body, [], []);
      return out;
    });
  }

  /** The scope of a `dynamic "label" { … }` block. */
  private dynamicScope(file: ParsedFile, block: HclBlock): DynamicScope | null {
    const label = block.labels[0];
    if (!label) return null;
    const iterAttr = block.body.attributes.find((a) => a.name === "iterator");
    const iterator =
      iterAttr && /^[\p{L}_][\p{L}\p{N}_-]*$/u.test(iterAttr.exprText) ? iterAttr.exprText : label;
    const forEach = block.body.attributes.find((a) => a.name === "for_each");
    return { label, iterator, forEach: forEach ? this.attrHit(file, forEach) : null };
  }

  private candidateHit(c: Candidate): SourceHit {
    if (c.block) return { ...this.blockHit(c.file, c.block), ...dynExtra(c.dynamic) };
    const hit = this.attrHit(c.file, c.attr, dynExtra(c.dynamic));
    if (c.startLine !== c.attr.startLine || c.endLine !== c.attr.endLine) {
      return {
        ...hit,
        location: { file: c.file.path, startLine: c.startLine, endLine: c.endLine },
        snippet: snippetFromLines(c.file.maskedLines, c.startLine, c.endLine),
      };
    }
    return hit;
  }

  /** Walks `path` from `i` in a body, pushing every matching attribute as a candidate. */
  private searchBody(
    file: ParsedFile,
    body: HclBody,
    path: AttrPath,
    i: number,
    dyn: DynamicScope[],
    ordinalMatch: boolean,
    outer: Candidate["outer"],
    override: boolean,
    out: Candidate[],
  ): void {
    const step = path[i];
    if (typeof step !== "string") return;
    for (const attr of body.attributes) {
      if (attr.name !== step) continue;
      let startLine = attr.startLine;
      let endLine = attr.endLine;
      const key = path[i + 1];
      if (typeof key === "string") {
        const span = locateObjectKey(attr.exprText, key);
        if (span) {
          startLine = attr.startLine + span.startLine - 1;
          endLine = attr.startLine + span.endLine - 1;
        }
      }
      out.push({ file, attr, startLine, endLine, dynamic: dyn, ordinalMatch, outer, override });
    }
    const next = path[i + 1];
    const rest = typeof next === "number" ? i + 2 : i + 1;
    if (rest >= path.length) {
      // A whole nested block element (one added to or removed from a set of blocks).
      if (typeof next === "number")
        this.pushBlocks(file, body, step, next, dyn, ordinalMatch, outer, override, out);
      return;
    }
    let ordinal = 0;
    for (const block of body.blocks) {
      if (block.type === step && block.labels.length === 0) {
        const matches = typeof next !== "number" || next === ordinal;
        ordinal++;
        this.searchBody(
          file,
          block.body,
          path,
          rest,
          dyn,
          ordinalMatch && matches,
          outer ?? { span: [block.startLine, block.endLine], body: block.body },
          override,
          out,
        );
      } else if (block.type === "dynamic" && block.labels[0] === step) {
        const scope = this.dynamicScope(file, block);
        const content = block.body.blocks.find((c) => c.type === "content");
        if (scope && content) {
          this.searchBody(
            file,
            content.body,
            path,
            rest,
            [...dyn, scope],
            false,
            outer ?? { span: [block.startLine, block.endLine], body: content.body },
            override,
            out,
          );
        }
      }
    }
  }

  /** The `type { … }` blocks (static or dynamic content) of a body as whole-element candidates. */
  private pushBlocks(
    file: ParsedFile,
    body: HclBody,
    type: string,
    index: number,
    dyn: DynamicScope[],
    ordinalMatch: boolean,
    outer: Candidate["outer"],
    override: boolean,
    out: Candidate[],
  ): void {
    let ordinal = 0;
    for (const block of body.blocks) {
      let target: HclBlock | null = null;
      let scopes = dyn;
      let content: HclBody | null = null;
      if (block.type === type && block.labels.length === 0) {
        target = block;
        content = block.body;
      } else if (block.type === "dynamic" && block.labels[0] === type) {
        const scope = this.dynamicScope(file, block);
        content = block.body.blocks.find((c) => c.type === "content")?.body ?? null;
        if (!scope || !content) continue;
        target = block;
        scopes = [...dyn, scope];
      }
      if (!target || !content) continue;
      const matches = target.type !== "dynamic" && index === ordinal;
      if (target.type !== "dynamic") ordinal++;
      out.push({
        file,
        attr: { name: type, startLine: target.startLine, endLine: target.endLine, exprText: "" },
        startLine: target.startLine,
        endLine: target.endLine,
        dynamic: scopes,
        ordinalMatch: ordinalMatch && matches,
        outer: outer ?? { span: [target.startLine, target.endLine], body: content },
        override,
        block: target,
      });
    }
  }

  private pick(candidates: Candidate[], hints: readonly unknown[]): SourceHit | null {
    if (!candidates.length) return null;
    const pool = candidates.some((c) => c.override) ? candidates.filter((c) => c.override) : candidates;
    const needles = hintNeedles(hints);
    const objects = hints.filter(
      (h): h is Record<string, unknown> => h !== null && typeof h === "object" && !Array.isArray(h),
    );
    const scored = pool.map((c, order) => {
      let score = 0;
      if (c.outer) {
        // Literal arguments that agree with the planned block value count most; disagreeing ones
        // rule a block out. Values that merely appear in the block's text are a weak signal.
        for (const h of objects) {
          for (const a of c.outer.body.attributes) {
            if (!(a.name in h)) continue;
            const lit = evaluateLiteral(a.exprText);
            if (lit.ok) score += literalMatches(lit.value, h[a.name]) ? 3 : -4;
          }
        }
        const text = c.file.lines.slice(c.outer.span[0] - 1, c.outer.span[1]).join("\n");
        for (const n of needles) if (text.includes(n)) score++;
      }
      return { c, score, order };
    });
    scored.sort(
      (a, b) => b.score - a.score || Number(b.c.ordinalMatch) - Number(a.c.ordinalMatch) || a.order - b.order,
    );
    return this.candidateHit(scored[0]!.c);
  }

  // ───────────────────────────── modules ─────────────────────────────

  private async moduleCallBlock(path: readonly string[]): Promise<FoundBlock | null> {
    if (path.length === 0) return null;
    const name = path[path.length - 1];
    const blocks = await this.blocksIn(path.slice(0, -1), (b) => b.type === "module" && b.labels[0] === name);
    return (blocks.find((b) => !b.override) ?? blocks[0])?.found ?? null;
  }

  /** The `module "name"` block calling the module at `path` (located in the parent's directory). */
  findModuleCall(path: readonly string[]): Promise<SourceHit | null> {
    return this.safe(null, async () => {
      const call = await this.moduleCallBlock(path);
      return call ? this.blockHit(call.file, call.block) : null;
    });
  }

  /**
   * An argument of a module call (also `count` / `for_each`). Override files win. An argument that
   * feeds a sensitive variable of the child module has its snippet masked (its references and
   * literal stay, for tracing and comparison).
   */
  findModuleArgument(path: readonly string[], name: string): Promise<SourceHit | null> {
    return this.safe(null, async () => {
      if (path.length === 0) return null;
      const callName = path[path.length - 1];
      const blocks = await this.blocksIn(
        path.slice(0, -1),
        (b) => b.type === "module" && b.labels[0] === callName,
      );
      let found: SourceHit | null = null;
      for (const { found: fb, override } of blocks) {
        const attr = fb.block.body.attributes.find((a) => a.name === name);
        if (attr && (found === null || override)) found = this.attrHit(fb.file, attr);
      }
      if (found && this.isSensitiveVariable(path, name)) {
        const { literal, files } = found;
        return {
          ...this.sensitiveHit(found, name),
          references: found.references,
          ...(literal && { literal }),
          ...(files && { files }),
        };
      }
      return found;
    });
  }

  /** The `source` and `version` lines of a module call (version first when present). */
  findModuleSource(path: readonly string[]): Promise<SourceHit[]> {
    return this.safe([], async () => {
      const out: SourceHit[] = [];
      for (const name of ["version", "source"]) {
        const hit = await this.findModuleArgument(path, name);
        if (hit) out.push(hit);
      }
      return out;
    });
  }

  // ───────────────────────────── variables, locals, outputs ─────────────────────────────

  private isSensitiveVariable(path: readonly string[], name: string): boolean {
    const mod = this.plan.modules[path.join(".")];
    if (mod?.variables[name]?.sensitive) return true;
    return path.length === 0 && this.plan.variables[name]?.sensitive === true;
  }

  private sensitiveHit(hit: SourceHit, name: string): SourceHit {
    const { literal: _literal, ...rest } = hit;
    return { ...rest, snippet: `${name} = ${SENSITIVE_PLACEHOLDER}`, references: [] };
  }

  /** The `variable "name"` block. */
  findVariable(path: readonly string[], name: string): Promise<SourceHit | null> {
    return this.safe(null, async () => {
      const blocks = await this.blocksIn(path, (b) => b.type === "variable" && b.labels[0] === name);
      const base = blocks.find((b) => !b.override) ?? blocks[0];
      return base ? this.blockHit(base.found.file, base.found.block) : null;
    });
  }

  /** The `default = …` line of a variable (null when it has none). Sensitive defaults are masked. */
  findVariableDefault(path: readonly string[], name: string): Promise<SourceHit | null> {
    return this.safe(null, async () => {
      const blocks = await this.blocksIn(path, (b) => b.type === "variable" && b.labels[0] === name);
      let found: SourceHit | null = null;
      for (const { found: fb, override } of blocks) {
        const attr = fb.block.body.attributes.find((a) => a.name === "default");
        if (attr && (found === null || override)) found = this.attrHit(fb.file, attr);
      }
      if (found && this.isSensitiveVariable(path, name)) {
        // Keep the literal for comparison; only the snippet is hidden.
        return { ...this.sensitiveHit(found, "default"), ...(found.literal && { literal: found.literal }) };
      }
      return found;
    });
  }

  /** A `locals { name = … }` entry in any file of the module. */
  findLocal(path: readonly string[], name: string): Promise<SourceHit | null> {
    return this.safe(null, async () => {
      let found: SourceHit | null = null;
      for (const { found: fb, override } of await this.blocksIn(path, (b) => b.type === "locals")) {
        const attr = fb.block.body.attributes.find((a) => a.name === name);
        if (attr && (found === null || override)) found = this.attrHit(fb.file, attr);
      }
      return found;
    });
  }

  /** The `value = …` of an `output "name"` block (the block when it has no value). */
  findOutput(path: readonly string[], name: string): Promise<SourceHit | null> {
    return this.safe(null, async () => {
      const blocks = await this.blocksIn(path, (b) => b.type === "output" && b.labels[0] === name);
      const base = blocks.find((b) => !b.override) ?? blocks[0];
      if (!base) return null;
      const value = base.found.block.body.attributes.find((a) => a.name === "value");
      return value ? this.attrHit(base.found.file, value) : this.blockHit(base.found.file, base.found.block);
    });
  }

  // ───────────────────────────── providers ─────────────────────────────

  private async providerBlocks(name: string): Promise<FoundBlock[]> {
    const blocks = await this.blocksIn([], (b) => b.type === "provider" && b.labels[0] === name);
    const isDefault = (b: FoundBlock): boolean => !b.block.body.attributes.some((a) => a.name === "alias");
    const found = blocks.map((b) => b.found);
    return [...found.filter(isDefault), ...found.filter((b) => !isDefault(b))];
  }

  /** The root module's `provider "name"` block (the default, un-aliased one first). */
  findProvider(name: string): Promise<SourceHit | null> {
    return this.safe(null, async () => {
      const [first] = await this.providerBlocks(name);
      return first ? this.blockHit(first.file, first.block) : null;
    });
  }

  /** An attribute of the root provider block, e.g. ["default_tags", "tags", "Team"]. */
  findProviderAttribute(name: string, attr: AttrPath): Promise<SourceHit | null> {
    return this.safe(null, async () => {
      const [first] = await this.providerBlocks(name);
      if (!first) return null;
      const candidates: Candidate[] = [];
      this.searchBody(first.file, first.block.body, attr, 0, [], true, null, false, candidates);
      return this.pick(candidates, []);
    });
  }

  /** `terraform { required_providers { name = { version = … } } }` in the root (the version line when inline). */
  findRequiredProvider(name: string): Promise<SourceHit | null> {
    return this.safe(null, async () => {
      for (const { found } of await this.blocksIn([], (b) => b.type === "terraform")) {
        for (const rp of found.block.body.blocks.filter((b) => b.type === "required_providers")) {
          const attr = rp.body.attributes.find((a) => a.name === name);
          if (!attr) continue;
          const key = locateObjectKey(attr.exprText, "version");
          if (key) {
            return this.hit(
              found.file,
              attr.startLine + key.startLine - 1,
              attr.startLine + key.endLine - 1,
              {
                references: [],
              },
            );
          }
          return this.attrHit(found.file, attr);
        }
      }
      return null;
    });
  }

  /** The locked version of a provider in the root's .terraform.lock.hcl, e.g. "registry.terraform.io/hashicorp/aws". */
  findLockedProvider(source: string): Promise<SourceHit | null> {
    return this.safe(null, async () => {
      const path = joinRepoPath(this.rootDir, LOCK_FILE);
      const file = path === null ? null : await this.file(path);
      if (!file) return null;
      const block = file.body.blocks.find((b) => b.type === "provider" && b.labels[0] === source);
      if (!block) return null;
      const version = block.body.attributes.find((a) => a.name === "version");
      return version ? this.attrHit(file, version) : this.blockHit(file, block);
    });
  }

  // ───────────────────────────── tfvars ─────────────────────────────

  /** Files Terraform loads automatically, in precedence order (later wins). */
  async tfvarsFiles(): Promise<string[]> {
    const listed = await this.workspace.listFiles(this.rootDir, TFVARS_SUFFIXES).catch(() => [] as string[]);
    const name = (f: string): string => posix.basename(f);
    const first = ["terraform.tfvars", "terraform.tfvars.json"]
      .map((n) => listed.find((f) => name(f) === n))
      .filter((f): f is string => f !== undefined);
    const auto = listed
      .filter((f) => /\.auto\.tfvars(\.json)?$/.test(name(f)))
      .sort((a, b) => (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0));
    return [...first, ...auto];
  }

  /**
   * Assignments of a root variable in terraform.tfvars, terraform.tfvars.json and *.auto.tfvars(.json),
   * in precedence order (the last one wins). Values of sensitive variables are masked in snippets.
   */
  findTfvars(name: string): Promise<SourceHit[]> {
    return this.safe([], async () => {
      const out: SourceHit[] = [];
      for (const path of await this.tfvarsFiles()) {
        const hit = await this.tfvarsAssignment(path, name);
        if (hit) out.push(hit);
      }
      return out;
    });
  }

  /**
   * Assignments of a root variable in .tfvars / .tfvars.json files Terraform does not load on its own
   * (`-var-file=envs/prod.tfvars`): the given files first (e.g. those the PR changes), then the other
   * ones in the root module's directory. Auto-loaded files are skipped. Sensitive values are masked.
   */
  findVarFileAssignments(name: string, preferred: readonly string[] = []): Promise<SourceHit[]> {
    return this.safe([], async () => {
      const auto = new Set(await this.tfvarsFiles());
      const listed = await this.workspace
        .listFiles(this.rootDir, TFVARS_SUFFIXES)
        .catch(() => [] as string[]);
      const files = [...new Set([...preferred, ...listed])].filter(
        (f) => TFVARS_SUFFIXES.some((s) => f.endsWith(s)) && !auto.has(f),
      );
      const out: SourceHit[] = [];
      for (const path of files) {
        const hit = await this.tfvarsAssignment(path, name);
        if (hit) out.push(hit);
      }
      return out;
    });
  }

  /** The assignment of `name` in one .tfvars / .tfvars.json file (the last one in the file wins). */
  private async tfvarsAssignment(path: string, name: string): Promise<SourceHit | null> {
    const file = await this.file(path);
    if (!file) return null;
    let hit: SourceHit | null = null;
    if (path.endsWith(".json")) hit = this.jsonAssignment(file, name);
    else {
      const attr = [...file.body.attributes].reverse().find((a) => a.name === name);
      if (attr) hit = this.attrHit(file, attr);
    }
    if (!hit) return null;
    return this.isSensitiveVariable([], name)
      ? { ...this.sensitiveHit(hit, name), ...(hit.literal && { literal: hit.literal }) }
      : hit;
  }

  /** A top-level key of a .tfvars.json file: its lines and parsed value. */
  private jsonAssignment(file: ParsedFile, name: string): SourceHit | null {
    const text = file.lines.join("\n");
    let value: unknown;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !(name in parsed)) return null;
      value = (parsed as Record<string, unknown>)[name];
    } catch {
      return null;
    }
    const span = jsonKeySpan(text, name);
    if (!span) return null;
    return this.hit(file, span[0], span[1], { literal: { value } });
  }

  // ───────────────────────────── moved / removed / import ─────────────────────────────

  /**
   * A `moved`, `removed` or `import` block of the module whose `attr` (from / to) names `address`
   * (module-relative, instance key optional).
   */
  findConfigBlockFor(
    path: readonly string[],
    type: "moved" | "removed" | "import",
    attr: "from" | "to",
    address: string,
  ): Promise<SourceHit | null> {
    return this.safe(null, async () => {
      const want = address.replace(/\s+/g, "");
      const unkeyed = want.replace(/\[[^\]]*\]$/, "");
      for (const { found } of await this.blocksIn(path, (b) => b.type === type)) {
        const a = found.block.body.attributes.find((x) => x.name === attr);
        const got = a?.exprText.replace(/\s+/g, "");
        if (got && (got === want || got === unkeyed)) return this.blockHit(found.file, found.block);
      }
      return null;
    });
  }
}

function dynExtra(dyn: DynamicScope[]): Partial<SourceHit> {
  return dyn.length ? { dynamic: dyn } : {};
}

/** A literal from the source against a planned value (numbers / bools may be written as strings). */
function literalMatches(lit: unknown, value: unknown): boolean {
  if (deepEqual(lit, value)) return true;
  if (typeof lit === "string" && (typeof value === "number" || typeof value === "boolean"))
    return lit === String(value);
  if (Array.isArray(lit) && Array.isArray(value))
    return lit.length === value.length && lit.every((x, i) => literalMatches(x, value[i]));
  return false;
}

/** Distinctive scalar strings of hint values, to recognize which block instance holds them. */
function hintNeedles(hints: readonly unknown[]): string[] {
  const out = new Set<string>();
  const visit = (v: unknown, depth: number): void => {
    if (depth > 8 || out.size > 64) return;
    if (typeof v === "string") {
      if (v.length >= 2 && v !== SENSITIVE_PLACEHOLDER) out.add(v);
    } else if (typeof v === "number" && Number.isFinite(v)) out.add(String(v));
    else if (Array.isArray(v)) for (const x of v) visit(x, depth + 1);
    else if (v && typeof v === "object") for (const x of Object.values(v)) visit(x, depth + 1);
  };
  for (const h of hints) visit(h, 0);
  return [...out];
}

/** 1-based line span of a top-level key's member in a JSON document. */
export function jsonKeySpan(text: string, key: string): [number, number] | null {
  let depth = 0;
  let line = 1;
  let i = 0;
  const n = text.length;
  const readString = (): string | null => {
    let j = i + 1;
    let raw = "";
    while (j < n && text[j] !== '"') {
      if (text[j] === "\\") {
        raw += text.slice(j, j + 2);
        j += 2;
        continue;
      }
      if (text[j] === "\n") return null;
      raw += text[j];
      j++;
    }
    i = j + 1;
    try {
      return JSON.parse(`"${raw}"`) as string;
    } catch {
      return raw;
    }
  };
  while (i < n) {
    const ch = text[i]!;
    if (ch === "\n") {
      line++;
      i++;
    } else if (ch === '"') {
      const keyLine = line;
      const s = readString();
      if (s === null) return null;
      if (depth === 1 && s === key && /^\s*:/.test(text.slice(i, i + 64))) {
        // Scan the value to its end at depth 1.
        let d = 0;
        let inStr = false;
        let endLine = line;
        for (; i < n; i++) {
          const c = text[i]!;
          if (c === "\n") {
            line++;
            continue;
          }
          if (inStr) {
            if (c === "\\") i++;
            else if (c === '"') inStr = false;
            endLine = line;
            continue;
          }
          if (c === '"') inStr = true;
          else if (c === "{" || c === "[") d++;
          else if (c === "}" || c === "]") {
            if (d === 0) break;
            d--;
          } else if (c === "," && d === 0) break;
          if (!/\s/.test(c)) endLine = line;
        }
        return [keyLine, endLine];
      }
    } else {
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") depth--;
      i++;
    }
  }
  return null;
}
