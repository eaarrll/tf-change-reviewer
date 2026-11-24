import { posix } from "node:path";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { z } from "zod";
import { normalizePath, parseUnifiedDiff } from "../git/diff.js";
import { formatPath, pathKey } from "../plan/paths.js";
import { SEVERITY_ORDER } from "../types.js";
import type {
  Action,
  AgentToolContext,
  AttrPath,
  Lineage,
  Logger,
  ResourceChange,
  ScoredChange,
  Severity,
} from "../types.js";
import {
  attributeNames,
  maskText,
  oneLine,
  renderChangeDetail,
  renderChangeLine,
  renderLineage,
  sliceCodePoints,
} from "./digest.js";
import { isPlanOrStateText } from "../workspace.js";

// Every tool is read-only and every result is masked (secret formats, credential-looking
// assignments) and capped. Situations the model can correct (unknown address, missing file,
// line out of range) come back as plain text. Only real failures throw: the tool runner turns
// a thrown error into an `is_error` tool_result reading "Error: <message>".

/** Default cap for one tool result; every turn re-sends all earlier results. */
export const MAX_TOOL_RESULT_CHARS = 12_000;
/** Source files and diffs are denser in useful detail, so they get a larger cap. */
export const MAX_FILE_RESULT_CHARS = 24_000;
export const MAX_LINES_PER_READ = 300;
const MAX_FILE_LINE_CHARS = 500;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DETAIL_ROWS = 150;
const DETAIL_VALUE_CHARS = 1_000;
const LINEAGE_SNIPPET_CHARS = 300;
export const MAX_SEARCH_HITS = 60;
const MAX_SEARCH_FILES = 500;
const MAX_SEARCH_DIRS = 100;
const MAX_SEARCH_LINE_CHARS = 300;
/** Only this much of a line is tested against a regular expression (bounds backtracking). */
const MAX_REGEX_LINE_CHARS = 500;
const MAX_PATTERN_CHARS = 200;
const MAX_SUGGESTIONS = 10;
const MAX_LISTED_DIRS = 10;

/** Files search_repo walks: Terraform configuration, variable files and HCL (lock file included). */
export const SEARCH_SUFFIXES = [".tf", ".tf.json", ".tfvars", ".tfvars.json", ".hcl"] as const;

/**
 * Files the tools refuse even inside the repository (read_file, search_repo, and get_diff hunks):
 * state and saved plans hold every secret in clear text, and the rest are credentials by
 * convention. A plan or state JSON under any other name is refused by its content
 * (isPlanOrStateText). State names cover the backups and copies Terraform and people make
 * (`terraform.tfstate.backup`, `x.tfstate.1700000000.backup`, `x.tfstate.json`), but not
 * configuration that merely has `.tfstate` in its name (`remote.tfstate.tf`: SEARCH_SUFFIXES).
 */
export const DENIED_FILES: readonly RegExp[] = [
  /(^|\/)\.git(\/|$)/,
  /\.tfstate(\.(?!(?:[^/]*\.)?(?:tf|tfvars|hcl)(?:\.json)?$)[^/]*)?$/i,
  /(^|\/)[^/]*\.tfplan(\.json)?$/i,
  /(^|\/)\.env(\.[^/]*)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /(^|\/)(\.terraformrc|terraform\.rc|credentials\.tfrc\.json)$/i,
];

const OFF_LIMITS = "state, plans, keys and credential files are off limits";

/** Whether a repo path is one of DENIED_FILES (shared with review.ts for the agent's cause refs). */
export function isDeniedPath(path: string): boolean {
  return DENIED_FILES.some((re) => re.test(path));
}

function notReadable(path: string): string {
  return `${path} is not readable by this reviewer (${OFF_LIMITS}).`;
}

export interface ToolCallTrace {
  /** Model turn that asked for the call (1-based). */
  turn: number;
  name: string;
  input: unknown;
  ok: boolean;
  resultChars: number;
  durationMs: number;
}

export interface ToolDeps {
  ctx: AgentToolContext;
  /** Lineage already traced for the candidates (primary attribute), keyed by address. */
  knownLineage?: ReadonlyMap<string, Lineage | null>;
  logger?: Logger;
  onCall?: (call: Omit<ToolCallTrace, "turn">) => void;
  /** Checked before every call: a reason to refuse it (for example a per-turn cap), or null. */
  admit?: (toolName: string) => string | null;
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const ACTIONS = [
  "create",
  "update",
  "delete",
  "replace",
  "read",
  "forget",
  "import",
  "move",
] as const satisfies readonly Action[];
const SEVERITIES = ["critical", "high", "medium", "low", "noise"] as const satisfies readonly Severity[];

const address = z
  .string()
  .describe("Exact resource instance address, as shown in the digest or list_changes.");

const ListChangesInput = z.object({
  action: z.enum(ACTIONS).optional().describe("Only changes with this action."),
  type: z
    .string()
    .optional()
    .describe('Resource type, e.g. "aws_db_instance". A trailing * matches a prefix, e.g. "aws_iam_*".'),
  module: z
    .string()
    .optional()
    .describe(
      'Module address, e.g. "module.orders_db" (nested modules and instances included); "root" for the root module only.',
    ),
  min_severity: z
    .enum(SEVERITIES)
    .optional()
    .describe("Only changes at least this severe (deterministic rules)."),
  attribute: z
    .string()
    .optional()
    .describe('Only changes touching this attribute or path prefix, e.g. "tags_all" or "ingress".'),
  offset: z.int().optional().describe("Matches to skip. Default 0."),
  limit: z
    .int()
    .optional()
    .describe(`Matches to show. Default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}.`),
});

const GetChangeInput = z.object({ address });

const TraceCauseInput = z.object({
  address,
  attribute: z
    .string()
    .optional()
    .describe(
      'Attribute path to trace, e.g. "storage_encrypted" or "ingress[0].cidr_blocks". Default: the attribute ' +
        "that forces replacement or carries the risk signal (the whole resource for creates and deletes).",
    ),
});

const ReadFileInput = z.object({
  path: z.string().describe("Repository-relative file path, e.g. main.tf or modules/db/main.tf."),
  start_line: z.int().optional().describe("First line (1-based). Default 1."),
  end_line: z
    .int()
    .optional()
    .describe(`Last line (inclusive). At most ${MAX_LINES_PER_READ} lines per call.`),
});

const SearchRepoInput = z.object({
  pattern: z.string().describe("Text to find, case-insensitive. A literal substring unless regex is true."),
  regex: z
    .boolean()
    .optional()
    .describe("Treat pattern as a JavaScript regular expression (case-insensitive). Default false."),
  path_glob: z
    .string()
    .optional()
    .describe(
      'Only files matching this glob, e.g. "*.tfvars" (matched against the file name) or "modules/**/*.tf".',
    ),
});

const GetDiffInput = z.object({
  path: z.string().optional().describe("A changed file. Omit for the whole diff (capped)."),
});

export type ReviewTool =
  | BetaRunnableTool<z.infer<typeof ListChangesInput>>
  | BetaRunnableTool<z.infer<typeof GetChangeInput>>
  | BetaRunnableTool<z.infer<typeof TraceCauseInput>>
  | BetaRunnableTool<z.infer<typeof ReadFileInput>>
  | BetaRunnableTool<z.infer<typeof SearchRepoInput>>
  | BetaRunnableTool<z.infer<typeof GetDiffInput>>;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function createTools(deps: ToolDeps): ReviewTool[] {
  const { ctx } = deps;
  const lineages = createLineageStore(ctx, deps.knownLineage);
  const repo = createRepoStore(ctx);

  return [
    defineTool(deps, {
      name: "list_changes",
      description:
        "List the plan's non-no-op changes, highest risk first, one line each: address | action | changed attributes | " +
        "severity [rule ids]. Filters combine. Use it to find changes the digest only summarized or left out.",
      input: ListChangesInput,
      run: async (input) => renderList(ctx, input),
    }),

    defineTool(deps, {
      name: "get_change",
      description:
        "Full detail of one change: action and reason, every changed attribute with masked before → after values, " +
        "attributes known only after apply, and the risk signals with rule ids.",
      input: GetChangeInput,
      run: async (input) => renderChange(ctx, input.address),
    }),

    defineTool(deps, {
      name: "trace_cause",
      description:
        "Trace a change (or one attribute of it) back through the Terraform code: the attribute's expression, module " +
        "inputs, variables, locals and tfvars, with file:line locations and whether the PR changed each step.",
      input: TraceCauseInput,
      run: async (input) => {
        const wanted = input.address.trim();
        const scored = findScored(ctx, wanted);
        if (!scored) return unknownAddress(ctx, wanted);
        const attribute = input.attribute === undefined ? undefined : parseAttrPath(input.attribute);
        if (attribute === null) {
          return `Could not read the attribute path "${oneLine(input.attribute ?? "")}". Write it like storage_encrypted, tags.Name or ingress[0].cidr_blocks.`;
        }
        const lineage = await lineages.get(scored.change.address, attribute);
        if (!lineage) return `No lineage could be traced for ${oneLine(scored.change.address)}.`;
        return [
          oneLine(scored.change.address),
          ...renderLineage(lineage, LINEAGE_SNIPPET_CHARS),
          "Locations are repo-relative file:line at the PR head; (base) marks lines the PR deleted.",
        ].join("\n");
      },
    }),

    defineTool(deps, {
      name: "read_file",
      description:
        `Read a repository file at the PR head as numbered lines (at most ${MAX_LINES_PER_READ} per call). ` +
        "Use it to check the code a lineage step points at before citing a line.",
      input: ReadFileInput,
      maxChars: MAX_FILE_RESULT_CHARS,
      run: async (input) => {
        const path = normalizeRepoPath(input.path);
        if (path === null || path === "")
          return `"${oneLine(input.path)}" is not a repository-relative file path.`;
        if (isDeniedPath(path)) return notReadable(path);
        const lines = await repo.lines(path);
        if (lines === "denied") return notReadable(path);
        if (lines === null) {
          const similar = await repo.similarFiles(path);
          const hint = similar.length > 0 ? ` Files with the same name: ${similar.join(", ")}.` : "";
          return `File not found or not readable at the PR head: ${path}.${hint} search_repo finds Terraform files.`;
        }
        if (lines === "binary") return `${path} looks like a binary file; not shown.`;
        return renderFile(path, lines, input.start_line, input.end_line);
      },
    }),

    defineTool(deps, {
      name: "search_repo",
      description:
        "Search the Terraform files (.tf, .tf.json, .tfvars, .tfvars.json, .hcl) of the root module and its local " +
        "modules for a case-insensitive substring (or regular expression); returns file:line matches. Use it to find " +
        "where a variable, local, module argument or value is set.",
      input: SearchRepoInput,
      run: async (input) => searchRepo(repo, input),
    }),

    defineTool(deps, {
      name: "get_diff",
      description:
        "The PR's unified diff, for one file or (capped) for all. Use it to see exactly which lines the PR changed.",
      input: GetDiffInput,
      maxChars: MAX_FILE_RESULT_CHARS,
      run: async (input) => renderDiff(ctx.diffText, input.path),
    }),
  ];
}

// ---------------------------------------------------------------------------
// Tool plumbing: validation, tracing, masking, result caps
// ---------------------------------------------------------------------------

interface ToolSpec<Schema extends z.ZodObject> {
  name: string;
  description: string;
  input: Schema;
  maxChars?: number;
  run: (input: z.infer<Schema>) => Promise<string>;
}

function defineTool<Schema extends z.ZodObject>(
  deps: ToolDeps,
  spec: ToolSpec<Schema>,
): BetaRunnableTool<z.infer<Schema>> {
  const maxChars = spec.maxChars ?? MAX_TOOL_RESULT_CHARS;
  const tool = betaZodTool({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.input,
    run: async (input: z.infer<Schema>) => {
      const started = performance.now();
      const refused = deps.admit?.(spec.name) ?? null;
      if (refused !== null) {
        record(deps, { name: spec.name, input, ok: false, resultChars: refused.length, durationMs: 0 });
        throw new Error(refused);
      }
      try {
        // Masked last, whatever the tool rendered: nothing unmasked reaches the model.
        const result = capResult(maskText(await spec.run(input)), maxChars);
        record(deps, {
          name: spec.name,
          input,
          ok: true,
          resultChars: result.length,
          durationMs: since(started),
        });
        return result;
      } catch (error) {
        const message = capResult(
          maskText(`${spec.name} failed: ${errorMessage(error)}`),
          MAX_TOOL_RESULT_CHARS,
        );
        record(deps, {
          name: spec.name,
          input,
          ok: false,
          resultChars: message.length,
          durationMs: since(started),
        });
        throw new Error(message, { cause: error });
      }
    },
  });

  return {
    ...tool,
    // The runner validates input before run(); wrapping parse() keeps malformed calls in the trace too.
    parse: (raw: unknown) => {
      const parsed = spec.input.safeParse(raw);
      if (parsed.success) return parsed.data;
      const message = `invalid input for ${spec.name}:\n${z.prettifyError(parsed.error)}`;
      record(deps, { name: spec.name, input: raw, ok: false, resultChars: message.length, durationMs: 0 });
      throw new Error(maskText(message));
    },
  };
}

function record(deps: ToolDeps, call: Omit<ToolCallTrace, "turn">): void {
  deps.onCall?.(call);
  deps.logger?.debug?.(
    `tool ${call.name} ${maskText(safeJson(call.input))} -> ${call.ok ? "ok" : "error"}, ` +
      `${call.resultChars} chars, ${call.durationMs} ms`,
  );
}

/** Cut an oversized result at a line boundary and say so, so the model narrows the request. */
export function capResult(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const note =
    `\n[truncated: the result exceeded ${maxChars} characters. ` +
    "Narrow the request (a smaller line range, a path, a filter or a more specific pattern).]";
  const room = Math.max(0, maxChars - note.length);
  const lineEnd = text.lastIndexOf("\n", room);
  return sliceCodePoints(text, lineEnd > room / 2 ? lineEnd : room) + note;
}

/**
 * Mask file text without changing its line count, so line numbers stay true. If masking a whole
 * text ever joins lines, fall back to line by line (with a local guard for private-key blocks).
 */
export function maskLines(lines: readonly string[]): string[] {
  const masked = maskText(lines.join("\n")).split("\n");
  if (masked.length === lines.length) return masked;
  let inKey = false;
  return lines.map((line) => {
    if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY/.test(line)) inKey = true;
    const out = inKey ? "[REDACTED:private-key]" : maskText(line);
    if (/-----END [A-Z0-9 ]*PRIVATE KEY/.test(line)) inKey = false;
    return out;
  });
}

function since(started: number): number {
  return Math.round(performance.now() - started);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

// ---------------------------------------------------------------------------
// Plan changes
// ---------------------------------------------------------------------------

function findScored(ctx: AgentToolContext, wanted: string): ScoredChange | undefined {
  return (
    ctx.scored.find((s) => s.change.address === wanted) ??
    ctx.scored.find((s) => s.change.previousAddress === wanted)
  );
}

function unknownAddress(ctx: AgentToolContext, wanted: string): string {
  const unchanged = ctx.plan.changes.find((c) => c.address === wanted);
  if (unchanged) return `${oneLine(wanted)} does not change in this plan (${unchanged.action}).`;
  const lower = wanted.toLowerCase();
  const tail = lower.split(".").slice(-2).join(".");
  const similar = ctx.scored
    .map((s) => s.change.address)
    .filter((a) => {
      const l = a.toLowerCase();
      return l.includes(lower) || lower.includes(l) || (tail.length > 2 && l.includes(tail));
    })
    .slice(0, MAX_SUGGESTIONS);
  const hint =
    similar.length > 0
      ? ` Similar addresses: ${similar.map(oneLine).join(", ")}.`
      : " list_changes shows every change.";
  return `No change with address ${oneLine(wanted)} in this plan.${hint}`;
}

function renderChange(ctx: AgentToolContext, wanted: string): string {
  const scored = findScored(ctx, wanted.trim());
  if (!scored) return unknownAddress(ctx, wanted.trim());
  const out = [oneLine(scored.change.address)];
  if (scored.change.address !== wanted.trim()) out.push(`(${oneLine(wanted)} moved to this address)`);
  out.push(...renderChangeDetail(scored, { maxRows: DETAIL_ROWS, maxValueChars: DETAIL_VALUE_CHARS }));
  const drift = ctx.plan.drift.find((d) => d.address === scored.change.address);
  if (drift) {
    const names = attributeNames(drift);
    out.push(
      `Drift: changed outside Terraform since the last apply${names.length > 0 ? ` (${names.map(oneLine).join(", ")})` : ""}; the plan may be reverting it.`,
    );
  }
  out.push("trace_cause shows the code behind it.");
  return out.join("\n");
}

function renderList(ctx: AgentToolContext, input: z.infer<typeof ListChangesInput>): string {
  const filters: string[] = [];
  let matches = ctx.scored.filter((s) => s.change.action !== "no-op");
  if (input.action) {
    filters.push(`action=${input.action}`);
    matches = matches.filter((s) => s.change.action === input.action);
  }
  const type = input.type?.trim();
  if (type) {
    filters.push(`type=${type}`);
    const prefix = type.endsWith("*") ? type.slice(0, -1) : null;
    matches = matches.filter((s) =>
      prefix !== null ? s.change.type.startsWith(prefix) : s.change.type === type,
    );
  }
  if (input.module !== undefined) {
    filters.push(`module=${input.module}`);
    matches = matches.filter((s) => moduleMatches(s.change, input.module ?? ""));
  }
  if (input.min_severity) {
    filters.push(`min_severity=${input.min_severity}`);
    const ceiling = SEVERITY_ORDER.indexOf(input.min_severity);
    matches = matches.filter((s) => SEVERITY_ORDER.indexOf(s.severity) <= ceiling);
  }
  const attribute = input.attribute?.trim();
  if (attribute) {
    filters.push(`attribute=${attribute}`);
    matches = matches.filter((s) => touchesAttribute(s.change, attribute));
  }

  const total = matches.length;
  const described = filters.length > 0 ? ` (${filters.map(oneLine).join(", ")})` : "";
  if (total === 0) return `No changes match${described}. ${ctx.scored.length} changes in the plan.`;
  const offset = Math.max(0, Math.trunc(input.offset ?? 0));
  if (offset >= total) return `${total} changes match${described}; offset ${offset} is past the end.`;
  const limit = clamp(input.limit ?? DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
  const page = matches.slice(offset, offset + limit);
  const end = offset + page.length;
  const out = [`${total} of ${ctx.scored.length} changes match${described}; showing ${offset + 1}-${end}:`];
  page.forEach((s, i) => out.push(`${offset + i + 1}. ${renderChangeLine(s)}`));
  if (end < total) out.push(`Call again with offset=${end} for more.`);
  return out.join("\n");
}

function moduleMatches(change: ResourceChange, wanted: string): boolean {
  const w = wanted.trim();
  if (w === "" || w === "root") return change.moduleAddress === null;
  const configForm = change.configModulePath.map((m) => `module.${m}`).join(".");
  return [change.moduleAddress ?? "", configForm].some(
    (m) => m !== "" && (m === w || m.startsWith(`${w}.`) || m.startsWith(`${w}[`)),
  );
}

function touchesAttribute(change: ResourceChange, wanted: string): boolean {
  const paths = [
    ...change.replacePaths,
    ...change.changedPaths,
    ...change.unknownPaths,
    ...change.sensitiveChangedPaths,
  ];
  return paths.some((p) => {
    const f = formatPath(p);
    return f === wanted || f.startsWith(`${wanted}.`) || f.startsWith(`${wanted}[`);
  });
}

const PATH_TOKEN =
  /\s*(?:\.?([A-Za-z_][A-Za-z0-9_-]*)|\.(\d+)|\[\s*(\d+)\s*\]|\[\s*("(?:[^"\\]|\\.)*")\s*\])/y;

/** `ingress[0].cidr_blocks`, `tags["Name"]` or `tags.Name` → AttrPath; null when it cannot be read. */
export function parseAttrPath(text: string): AttrPath | null {
  const s = text.trim();
  const path: AttrPath = [];
  let i = 0;
  while (i < s.length) {
    PATH_TOKEN.lastIndex = i;
    const m = PATH_TOKEN.exec(s);
    if (!m || PATH_TOKEN.lastIndex === i) return null;
    if (m[1] !== undefined) path.push(m[1]);
    else if (m[2] !== undefined) path.push(Number(m[2]));
    else if (m[3] !== undefined) path.push(Number(m[3]));
    else if (m[4] !== undefined) {
      try {
        path.push(JSON.parse(m[4]) as string);
      } catch {
        return null;
      }
    }
    i = PATH_TOKEN.lastIndex;
  }
  return path.length > 0 ? path : null;
}

interface LineageStore {
  get(address: string, attribute: AttrPath | undefined): Promise<Lineage | null>;
}

/** Lineage per (address, attribute), traced once; the candidates' primary lineage is reused as is. */
function createLineageStore(
  ctx: AgentToolContext,
  known: ReadonlyMap<string, Lineage | null> | undefined,
): LineageStore {
  const cache = new Map<string, Promise<Lineage | null>>();
  for (const [addr, lineage] of known ?? []) {
    if (lineage) cache.set(`${addr}\u0000*`, Promise.resolve(lineage));
  }
  return {
    get(addr, attribute) {
      const key = `${addr}\u0000${attribute === undefined ? "*" : pathKey(attribute)}`;
      let pending = cache.get(key);
      if (!pending) {
        pending = ctx.getLineage(addr, attribute);
        cache.set(key, pending);
        // A failed trace must not stay cached.
        pending.catch(() => {
          if (cache.get(key) === pending) cache.delete(key);
        });
      }
      return pending;
    },
  };
}

// ---------------------------------------------------------------------------
// Repository files
// ---------------------------------------------------------------------------

/** Strip "./" and slashes at the ends; null for anything that climbs out of the repository. */
export function normalizeRepoPath(path: string): string | null {
  const trimmed = normalizePath(path.trim())
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (trimmed === ".") return "";
  if (trimmed.split("/").some((segment) => segment === "..")) return null;
  return trimmed;
}

interface RepoStore {
  /** Masked lines of a file, "binary", "denied" (a plan or state JSON), or null when missing/unreadable. */
  lines(path: string): Promise<string[] | "binary" | "denied" | null>;
  /** Directories search_repo walks and the Terraform files in them. */
  files(): Promise<{ dirs: string[]; files: string[] }>;
  similarFiles(path: string): Promise<string[]>;
}

function createRepoStore(ctx: AgentToolContext): RepoStore {
  const texts = new Map<string, Promise<string[] | "binary" | "denied" | null>>();
  let listing: Promise<{ dirs: string[]; files: string[] }> | null = null;

  const store: RepoStore = {
    lines(path) {
      let pending = texts.get(path);
      if (!pending) {
        pending = ctx.workspace.readFile(path).then((text) => {
          if (text === null) return null;
          if (text.includes("\u0000")) return "binary";
          if (isPlanOrStateText(text)) return "denied";
          return maskLines(splitLines(text));
        });
        texts.set(path, pending);
        pending.catch(() => {
          if (texts.get(path) === pending) texts.delete(path);
        });
      }
      return pending;
    },
    files() {
      if (!listing) {
        const pending = listSearchFiles(ctx);
        listing = pending;
        pending.catch(() => {
          if (listing === pending) listing = null;
        });
      }
      return listing;
    },
    async similarFiles(path) {
      const name = posix.basename(path);
      const { files } = await store.files().catch(() => ({ files: [] as string[] }));
      return files.filter((f) => posix.basename(f) === name && f !== path).slice(0, MAX_SUGGESTIONS);
    },
  };
  return store;
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function renderFile(
  path: string,
  all: readonly string[],
  startLine: number | undefined,
  endLine: number | undefined,
): string {
  if (all.length === 0) return `${path} is empty.`;
  if ((startLine ?? 1) > all.length) return `${path} has only ${all.length} lines.`;
  if (endLine !== undefined && startLine !== undefined && endLine < startLine) {
    return "end_line must not be smaller than start_line.";
  }
  const start = clamp(startLine ?? 1, 1, all.length);
  const end = clamp(Math.min(endLine ?? all.length, start + MAX_LINES_PER_READ - 1), start, all.length);
  const width = String(end).length;
  const lines = all
    .slice(start - 1, end)
    .map((text, i) => `${String(start + i).padStart(width)} | ${clipLine(text, MAX_FILE_LINE_CHARS)}`);
  const more = end < all.length ? `; call again with start_line=${end + 1} for more` : "";
  return [`${path}, lines ${start}-${end} of ${all.length}${more}:`, ...lines].join("\n");
}

function clipLine(text: string, max: number): string {
  if (text.length <= max) return text;
  const kept = sliceCodePoints(text, max);
  return `${kept} [... ${text.length - kept.length} more chars]`;
}

/**
 * The directories search_repo walks. Workspace has no recursive listing, so they are gathered:
 * the root module dir, local module sources resolved through plan.configuration (parent first),
 * `.terraform/modules/modules.json` when `terraform init` left one, and the directories of
 * Terraform files the PR changed.
 */
export async function searchDirectories(ctx: AgentToolContext): Promise<string[]> {
  const root = normalizeRepoPath(ctx.workspace.rootModuleDir) ?? "";
  const dirs = new Set<string>([root]);

  const moduleDirs = new Map<string, string | null>([["", root]]);
  const keys = Object.keys(ctx.plan.modules).sort((a, b) => depth(a) - depth(b));
  for (const key of keys) {
    const mod = ctx.plan.modules[key];
    if (!mod || mod.path.length === 0) continue;
    const parent = moduleDirs.get(mod.path.slice(0, -1).join("."));
    const dir = parent === undefined || parent === null ? null : resolveLocalSource(parent, mod.source);
    moduleDirs.set(mod.path.join("."), dir);
    if (dir !== null) dirs.add(dir);
  }

  const manifest = await ctx.workspace
    .readFile(joinRepo(root, ".terraform/modules/modules.json"))
    .catch(() => null);
  if (manifest) {
    try {
      const parsed = JSON.parse(manifest) as { Modules?: Array<{ Dir?: unknown }> };
      for (const entry of parsed.Modules ?? []) {
        if (typeof entry.Dir !== "string") continue;
        const dir = normalizeRepoPath(joinRepo(root, entry.Dir));
        if (dir !== null) dirs.add(dir);
      }
    } catch {
      // A malformed manifest only means fewer directories.
    }
  }

  if (ctx.diffText) {
    for (const file of parseUnifiedDiff(ctx.diffText).files.keys()) {
      if (!hasSearchSuffix(file)) continue;
      const dir = normalizeRepoPath(posix.dirname(file));
      if (dir !== null) dirs.add(dir);
    }
  }
  return [...dirs].slice(0, MAX_SEARCH_DIRS);
}

async function listSearchFiles(ctx: AgentToolContext): Promise<{ dirs: string[]; files: string[] }> {
  const dirs = await searchDirectories(ctx);
  const files = new Set<string>();
  for (const dir of dirs) {
    const listed = await ctx.workspace.listFiles(dir, SEARCH_SUFFIXES).catch(() => [] as string[]);
    for (const file of listed) {
      const path = normalizeRepoPath(file);
      if (path && hasSearchSuffix(path) && !isDeniedPath(path)) files.add(path);
    }
  }
  return { dirs, files: [...files].sort().slice(0, MAX_SEARCH_FILES) };
}

function depth(key: string): number {
  return key === "" ? 0 : key.split(".").length;
}

/** "./x" and "../x" sources relative to the calling module's directory; null for remote sources. */
function resolveLocalSource(parentDir: string, source: string | undefined): string | null {
  if (!source || !(source.startsWith("./") || source.startsWith("../"))) return null;
  return normalizeRepoPath(joinRepo(parentDir, source));
}

function joinRepo(dir: string, rel: string): string {
  const joined = posix.normalize(posix.join(dir === "" ? "." : dir, rel));
  return joined === "." ? "" : joined;
}

function hasSearchSuffix(path: string): boolean {
  return SEARCH_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

/** A quantified group whose body holds a quantifier or an alternation: the classic catastrophic-backtracking shapes. */
const RISKY_REGEX = /\((?:[^()\\]|\\.)*[*+}|](?:[^()\\]|\\.)*\)\s*[*+?{]/;

function compilePattern(pattern: string, regex: boolean): ((line: string) => boolean) | string {
  if (pattern.trim() === "") return "The pattern is empty. Search for a variable, attribute or value.";
  if (pattern.length > MAX_PATTERN_CHARS)
    return `The pattern is longer than ${MAX_PATTERN_CHARS} characters.`;
  if (!regex) {
    const needle = pattern.toLowerCase();
    return (line) => line.toLowerCase().includes(needle);
  }
  if (RISKY_REGEX.test(pattern) || /\\[1-9]|\\k</.test(pattern)) {
    return "That regular expression could backtrack catastrophically (a repeated group containing a quantifier or an alternation, or a backreference). Simplify it or search for a literal.";
  }
  try {
    const re = new RegExp(pattern, "i");
    return (line) => re.test(line.slice(0, MAX_REGEX_LINE_CHARS));
  } catch (error) {
    return `Invalid regular expression: ${errorMessage(error)}`;
  }
}

function globMatcher(glob: string): (path: string) => boolean {
  const g = glob.trim().replace(/^(\.\/)+/, "");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const ch = g[i]!;
    if (ch === "*" && g[i + 1] === "*") {
      if (g[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const regex = new RegExp(`^${re}$`);
  const byName = !g.includes("/");
  return (path) => regex.test(byName ? posix.basename(path) : path);
}

async function searchRepo(repo: RepoStore, input: z.infer<typeof SearchRepoInput>): Promise<string> {
  const matcher = compilePattern(input.pattern, input.regex ?? false);
  if (typeof matcher === "string") return matcher;
  const { dirs, files } = await repo.files();
  const inGlob = input.path_glob?.trim() ? globMatcher(input.path_glob) : () => true;
  const candidates = files.filter(inGlob);

  const shown = new Map<string, string[]>();
  let total = 0;
  let shownCount = 0;
  let matchedFiles = 0;
  for (const file of candidates) {
    const lines = await repo.lines(file);
    if (lines === null || lines === "binary" || lines === "denied") continue;
    let fileHits = 0;
    // Matching runs on masked text, so a pattern cannot probe a secret's value.
    lines.forEach((line, i) => {
      if (!matcher(line)) return;
      total += 1;
      fileHits += 1;
      if (shownCount >= MAX_SEARCH_HITS) return;
      shownCount += 1;
      const entries = shown.get(file) ?? [];
      entries.push(`  ${i + 1} | ${clipLine(line.trim(), MAX_SEARCH_LINE_CHARS)}`);
      shown.set(file, entries);
    });
    if (fileHits > 0) matchedFiles += 1;
  }

  const listedDirs = dirs
    .slice(0, MAX_LISTED_DIRS)
    .map((d) => d || ".")
    .join(", ");
  const moreDirs = dirs.length > MAX_LISTED_DIRS ? ` and ${dirs.length - MAX_LISTED_DIRS} more` : "";
  const scope = `${candidates.length} files in ${listedDirs}${moreDirs}`;
  const what = `${input.regex ? "regex " : ""}${JSON.stringify(input.pattern)}`;
  if (total === 0) {
    return (
      `No matches for ${what} (searched ${scope}). Only Terraform files of the root module and its local modules ` +
      "are searched; read_file reads any other repository file."
    );
  }
  const capped = total > shownCount ? `; showing the first ${shownCount}` : "";
  const out = [`${total} matches in ${matchedFiles} files for ${what} (searched ${scope})${capped}:`];
  for (const [file, entries] of shown) out.push(file, ...entries);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

interface DiffSection {
  path: string;
  oldPath: string | null;
  lines: string[];
}

function splitDiff(text: string): DiffSection[] {
  const sections: DiffSection[] = [];
  let current: DiffSection | null = null;
  let inHunk = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      current = { path: m ? normalizePath(m[2]!) : "", oldPath: m ? normalizePath(m[1]!) : null, lines: [] };
      sections.push(current);
      inHunk = false;
    } else if (!current) {
      current = { path: "", oldPath: null, lines: [] };
      sections.push(current);
    }
    if (line.startsWith("@@")) inHunk = true;
    else if (!inHunk && line.startsWith("--- ")) {
      const old = diffPath(line.slice(4));
      if (old) current.oldPath = old;
    } else if (!inHunk && line.startsWith("+++ ")) {
      const path = diffPath(line.slice(4));
      current.path = path ?? current.oldPath ?? current.path;
    }
    current.lines.push(line);
  }
  // A trailing newline leaves an empty last line.
  const last = sections.at(-1);
  if (last && last.lines.at(-1) === "") last.lines.pop();
  return sections.filter((s) => s.lines.length > 0);
}

function diffPath(raw: string): string | null {
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

/** Mask hunk bodies as one text per section (prefix characters set aside), so multi-line secrets are caught. */
function maskDiffLines(lines: readonly string[]): string[] {
  const out = [...lines];
  const index: number[] = [];
  const contents: string[] = [];
  let inHunk = false;
  lines.forEach((line, i) => {
    if (line.startsWith("@@")) inHunk = true;
    else if (line.startsWith("diff --git ")) inHunk = false;
    else if (inHunk && /^[+\- ]/.test(line)) {
      index.push(i);
      contents.push(line.slice(1));
    }
  });
  const masked = maskLines(contents);
  index.forEach((lineIndex, k) => {
    out[lineIndex] = `${out[lineIndex]![0]}${masked[k] ?? ""}`;
  });
  return out;
}

function renderDiff(diffText: string | null, wanted: string | undefined): string {
  if (diffText === null) return "The PR diff is not available for this run.";
  const sections = splitDiff(diffText);
  if (sections.length === 0) return "The PR diff is empty.";
  const listing = sections.map((s) => {
    const index = parseUnifiedDiff(s.lines.join("\n"));
    const fd = index.files.get(s.path);
    const from = s.oldPath && s.oldPath !== s.path ? ` (from ${s.oldPath})` : "";
    return `- ${s.path || "(unknown path)"}${from}${fd ? ` (+${fd.addedLines.size} -${fd.removedLines.size})` : ""}`;
  });

  if (wanted === undefined || wanted.trim() === "") {
    return [`Changed files (${sections.length}):`, ...listing, "", ...sections.flatMap(sectionLines)].join(
      "\n",
    );
  }
  const path = normalizeRepoPath(wanted);
  const section =
    path === null
      ? undefined
      : (sections.find((s) => s.path === path) ?? sections.find((s) => s.oldPath === path));
  if (!section) {
    return `${oneLine(wanted)} is not changed in this PR. Changed files:\n${listing.join("\n")}`;
  }
  return sectionLines(section).join("\n");
}

/**
 * Plan and state keys that never occur in Terraform configuration: a hunk holding one is part of a
 * plan or state JSON even when it shows too little of it for isPlanOrStateText.
 */
const PLAN_STATE_KEYS =
  /"(before_sensitive|after_sensitive|after_unknown|sensitive_values|sensitive_attributes|planned_values|resource_changes|prior_state)"\s*:/;

/** A section's lines, masked; a denied file (by path or content) keeps its header, not its hunks. */
function sectionLines(section: DiffSection): string[] {
  const firstHunk = section.lines.findIndex((l) => l.startsWith("@@"));
  if (firstHunk < 0) return maskDiffLines(section.lines);
  const body = section.lines.slice(firstHunk).join("\n");
  const denied =
    isDeniedPath(section.path) ||
    (section.oldPath !== null && isDeniedPath(section.oldPath)) ||
    isPlanOrStateText(body) ||
    PLAN_STATE_KEYS.test(body);
  if (!denied) return maskDiffLines(section.lines);
  return [...maskDiffLines(section.lines.slice(0, firstHunk)), `[changed lines not shown: ${OFF_LIMITS}]`];
}
