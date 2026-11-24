/*
 * Markdown safety for everything that reaches a PR comment, a job summary or a terminal.
 *
 * Two kinds of text arrive here:
 * - model-written prose (agent summary, titles, impact, cause): may echo prompt-injected repo or
 *   plan text, so nothing it writes may notify anyone, be clickable, hide content, render raw HTML,
 *   embed media or spoof our hidden markers (sanitizeModelText / sanitizeInline);
 * - plan-derived values (addresses with quotes and brackets, attribute paths, rule ids, file paths,
 *   snippets): shown verbatim in code spans (codeSpan) or escaped as plain text (escapeText).
 *
 * Ported from ci-triage-agent's report sanitizer; the guarantees hold for how GitHub parses the
 * *output*: every backtick left outside a code span is escaped, so GitHub pairs code delimiters
 * exactly as this module did.
 */

export const ZWSP = "\u200b";

/** C0/C1 controls (except tab and newline) and bidi overrides, which can disguise text or drive a terminal. */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
/** Anything that could pass for one of our hidden markers: the comment marker, run stamp, data marker or a checkbox key. */
const MARKER_LOOKALIKE = /<!--(?=\s*(?:tf-change-reviewer|finding:))/gi;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const IMAGE = /!\[([^[\]\n]*)\]\(([^()\n]*(?:\([^()\n]*\)[^()\n]*)*)\)/g;
const LINK = /\[([^[\]\n]*)\]\(([^()\n]*(?:\([^()\n]*\)[^()\n]*)*)\)/g;
/** URL schemes and the www. prefix that GitHub's autolinker turns into links. */
const BARE_URL = /(?:https?|ftp):\/\/[^\s<>`\u0000]+|www\.[^\s<>`\u0000]+/gi;
/**
 * `@name` or `@org/team`, but not the `@` inside an email address or `hashicorp/aws@6.0`.
 * Mentions are found per rendered text node, so neither `_` (`_@x_` becomes `<em>@x</em>`)
 * nor an email autolinked right before the `@` (`a@b.example@x`) protects one.
 */
const MENTION = /(?:(?<![A-Za-z0-9])|(?<=@[A-Za-z0-9.+_-]*))@(?=[A-Za-z0-9])/g;
/** `#123` and `owner/repo#123` create cross-references (timeline events) in the target. */
const ISSUE_REFERENCE = /#(?=\d)/g;
/** Brackets form links, images, footnotes and task-list boxes; `$` forms GitHub math. */
const BRACKET_OR_DOLLAR = /(\\*)([[\]$])/g;
const BLOCKQUOTE_PREFIX = /^(?:[ \t]*&gt;)+/;
const TABLE_DELIMITER_ROW = /^((?:[ \t]*>)*[ \t]*)([|:-][|: \t-]*)$/;
const TILDE_FENCE_OPEN = /^((?:[ \t]*>)*[ \t]*)(~{3})/;
const PLACEHOLDER = /\u0000(\d+)\u0000/g;
const FENCE_OPEN = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`+|~+)[ \t]*$/;
/** Fence languages GitHub renders as diagrams, maps, 3D models or math instead of code. */
const RENDERED_LANGUAGES = new Set(["mermaid", "geojson", "topojson", "stl", "math"]);

/** A protected stretch of output: its final markdown, and the original text for use inside a URL. */
interface Piece {
  markdown: string;
  raw: string;
}

type Hold = (piece: Piece) => string;

interface Fence {
  char: "`" | "~";
  length: number;
  indent: number;
  info: string;
}

// ───────────────────────────── public API ─────────────────────────────

/** CRLF → LF and strip control/bidi characters. Also the whole of terminal sanitizing (no ESC survives). */
export function normalize(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(CONTROL_CHARS, "");
}

/**
 * Make model-written (multi-line) text safe to embed in a GitHub comment. Code spans and fenced
 * blocks keep their content verbatim; every link becomes inert text showing its target.
 */
export function sanitizeModelText(text: string): string {
  const lines = normalize(text).split("\n");
  const out: string[] = [];
  let prose: string[] = [];
  const flushProse = (): void => {
    if (prose.length > 0) out.push(sanitizeProse(prose.join("\n"), false));
    prose = [];
  };

  for (let i = 0; i < lines.length;) {
    const line = lines[i] ?? "";
    const fence = parseFenceOpen(line);
    if (!fence) {
      prose.push(line);
      i++;
      continue;
    }
    flushProse();
    const { block, next } = readFence(lines, i, fence);
    out.push(block);
    i = next;
  }
  flushProse();
  return out.join("\n");
}

/** Single-line variant (headings, list items, table-free inline spots): whitespace collapsed, no block structure. */
export function sanitizeInline(text: string, maxChars = Infinity): string {
  return sanitizeProse(truncate(normalize(text).replace(/\s+/g, " ").trim(), maxChars), true);
}

/**
 * Escape a short single-line plain value (rule reason, step label, model name, warning) for inline
 * markdown: no emphasis, code, links, tables, HTML, mentions, issue references or autolinks.
 */
export function escapeText(text: string, maxChars = Infinity): string {
  return truncate(normalize(text).replace(/\s+/g, " ").trim(), maxChars)
    .replace(/[\\`*_[\]|~$]/g, "\\$&")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[@#]/g, `$&${ZWSP}`)
    .replace(/:\/\//g, `:${ZWSP}//`)
    .replace(/(www)\./gi, `$1${ZWSP}.`);
}

/**
 * Inline code that shows `text` verbatim, whatever backticks, quotes, brackets or HTML it contains:
 * the way to show plan-derived values such as `module.a["x.y"].aws_s3_bucket.this[0]`.
 * Newlines become spaces; "" for empty input.
 */
export function codeSpan(text: string, maxChars = Infinity): string {
  const content = defuseMarkers(truncate(normalize(text).replace(/\n/g, " "), maxChars));
  if (content === "") return "";
  const delimiter = "`".repeat(longestRun(content, "`") + 1);
  // CommonMark strips one space from each end, and content may not touch the delimiter with a backtick.
  const pad = /^[ `]|[ `]$/.test(content) ? " " : "";
  return `${delimiter}${pad}${content}${pad}${delimiter}`;
}

/** A code span that is also safe inside a GFM table cell ("—" for empty). */
export function tableCode(text: string, maxChars = Infinity): string {
  return (codeSpan(text, maxChars) || "—").replace(/\|/g, "\\|");
}

/** Backtick fence longer than any backtick run in `content`, so no content line can close it. */
export function codeFence(content: string): string {
  return "`".repeat(Math.max(3, longestRun(content, "`") + 1));
}

/** Break anything that could be mistaken for one of our hidden markers, even inside code. */
export function defuseMarkers(text: string): string {
  return text.replace(MARKER_LOOKALIKE, `<!-${ZWSP}-`);
}

/** Cut to `maxChars` (ellipsis included), never splitting a surrogate pair. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let end = Math.max(0, maxChars - 1);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
}

/** Only plain https URLs (our own GitHub data) become link targets. */
export function safeUrl(url: string | undefined | null): string | null {
  if (typeof url !== "string") return null;
  return /^https:\/\/[^\s<>()[\]`"'\\]+$/.test(url) ? url : null;
}

/** encodeURIComponent leaves parentheses alone, but they end a markdown link destination. */
export function encodeUrlSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[()!'*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * A plain repository-relative path, or null for traversal, absolute or Windows paths, URLs and
 * other schemes, control characters, and anything over `maxChars`. Leading `./` is dropped.
 */
export function repoRelativePath(raw: string, maxChars = 500): string | null {
  const path = raw.trim().replace(/^(?:\.\/)+/, "");
  if (path === "" || path.length > maxChars) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) return null; // https:, javascript:, C:
  if (path.startsWith("/") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) return null;
  const segments = path.split("/");
  return segments.some((segment) => segment === "" || segment === "." || segment === "..") ? null : path;
}

// ───────────────────────────── prose internals ─────────────────────────────

/**
 * Sanitize text outside fenced code. Code spans are swapped for placeholders first so the
 * rewrites below never touch them, then restored at the end.
 */
function sanitizeProse(text: string, inline: boolean): string {
  const pieces: Piece[] = [];
  const hold: Hold = (piece) => `\u0000${pieces.push(piece) - 1}\u0000`;

  let s = text
    .split("\n")
    .map((line) => protectCodeSpans(line, hold))
    .join("\n");
  s = s.replace(HTML_COMMENT, "");
  s = s.replace(IMAGE, (_match, alt: string) => `${alt.trim()} (image removed)`.trimStart());
  s = s.replace(LINK, (_match, label: string, target: string) => unlink(label, target, pieces, hold));
  s = s.replace(BARE_URL, (url: string) => {
    const [link, trailing] = splitTrailingPunctuation(url);
    return hold(codePiece(link)) + trailing;
  });
  s = escapeProse(s);
  if (!inline) {
    s = s
      .split("\n")
      .map((line) =>
        neutralizeTildeFence(
          neutralizeTableDelimiter(line.replace(BLOCKQUOTE_PREFIX, (m) => m.replaceAll("&gt;", ">"))),
        ),
      )
      .join("\n");
  }
  return restorePieces(s, pieces);
}

/**
 * Replace code spans on one line with placeholders, following CommonMark's pairing rules
 * (a run of N backticks closes at the next run of exactly N; backslashes do not escape
 * inside a span). Unpaired and backslash-escaped backticks become escaped literals. Spans never
 * cross lines here: a multi-line span is treated as text, which is only ever over-escaped.
 */
function protectCodeSpans(line: string, hold: Hold): string {
  let out = "";
  let pos = 0;
  while (pos < line.length) {
    const tick = line.indexOf("`", pos);
    if (tick === -1) return out + line.slice(pos);
    if (isBackslashEscaped(line, tick)) {
      out += line.slice(pos, tick - 1) + hold(literalBackticks(1));
      pos = tick + 1;
      continue;
    }
    const run = runLength(line, tick);
    const close = findClosingRun(line, tick + run, run);
    if (close === -1) {
      out += line.slice(pos, tick) + hold(literalBackticks(run));
      pos = tick + run;
    } else {
      const span = line.slice(tick, close + run);
      out += line.slice(pos, tick) + hold({ markdown: defuseMarkers(span), raw: span });
      pos = close + run;
    }
  }
  return out;
}

function findClosingRun(line: string, from: number, length: number): number {
  for (let i = line.indexOf("`", from); i !== -1;) {
    const run = runLength(line, i);
    if (run === length) return i;
    i = line.indexOf("`", i + run);
  }
  return -1;
}

function isBackslashEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
  return slashes % 2 === 1;
}

function runLength(text: string, start: number): number {
  let end = start;
  while (text[end] === text[start]) end++;
  return end - start;
}

function literalBackticks(count: number): Piece {
  return { markdown: "\\`".repeat(count), raw: "`".repeat(count) };
}

function codePiece(text: string): Piece {
  const markdown = codeSpan(text);
  return { markdown, raw: markdown };
}

/** `[label](url)` → `label (`url`)`: the reader sees where it pointed but cannot click it. */
function unlink(label: string, target: string, pieces: readonly Piece[], hold: Hold): string {
  const url = linkDestination(restoreRaw(target, pieces));
  const text = label.trim();
  if (!url) return text;
  const code = hold(codePiece(url));
  return text && restoreRaw(text, pieces) !== url ? `${text} (${code})` : code;
}

function linkDestination(target: string): string {
  const trimmed = target.trim();
  if (trimmed.startsWith("<")) {
    const end = trimmed.indexOf(">");
    return end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);
  }
  return trimmed.split(/\s+/)[0] ?? "";
}

/** Keep sentence punctuation (and an unbalanced closing paren) out of a wrapped URL, like GitHub's autolinker. */
function splitTrailingPunctuation(url: string): [string, string] {
  let end = url.length;
  while (end > 1) {
    const ch = url[end - 1] ?? "";
    const head = url.slice(0, end);
    const unbalancedParen = ch === ")" && count(head, "(") < count(head, ")");
    if (!(".,:;!?'\"*_~]".includes(ch) || unbalancedParen)) break;
    end--;
  }
  return [url.slice(0, end), url.slice(end)];
}

function escapeProse(text: string): string {
  return (
    text
      // Escape every bracket and dollar sign that is not already escaped, so no link, image,
      // reference definition, footnote, task-list box or math can form, whatever they were nested in.
      .replace(BRACKET_OR_DOLLAR, (match, slashes: string, char: string) =>
        slashes.length % 2 === 1 ? match : `${slashes}\\${char}`,
      )
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(MENTION, `@${ZWSP}`)
      .replace(ISSUE_REFERENCE, `#${ZWSP}`)
  );
}

/**
 * GFM splits table cells on `|` before it parses code spans, which would let a cell split one of
 * our protected spans and expose its content as HTML. Breaking every delimiter row stops tables.
 */
function neutralizeTableDelimiter(line: string): string {
  const match = TABLE_DELIMITER_ROW.exec(line);
  const row = match?.[2];
  if (row === undefined || !row.includes("-") || !/[|:]/.test(row)) return line;
  return `${match?.[1] ?? ""}\\${row}`;
}

/**
 * Removing a comment or an empty link can leave a prose line starting with `~~~`; GitHub would
 * open a fence there and close it on one of our verbatim fences, rendering that fence as markdown.
 */
function neutralizeTildeFence(line: string): string {
  return line.replace(TILDE_FENCE_OPEN, "$1\\$2");
}

function restorePieces(text: string, pieces: readonly Piece[]): string {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    out += text.slice(last, match.index);
    const markdown = pieces[Number(match[1])]?.markdown ?? "";
    // A backslash or backtick right before a delimiter would escape or lengthen it.
    if (isEscapeOrTick(out.at(-1)) && isEscapeOrTick(markdown[0])) out += ZWSP;
    out += markdown;
    last = match.index + match[0].length;
  }
  return out + text.slice(last);
}

function isEscapeOrTick(char: string | undefined): boolean {
  return char === "\\" || char === "`";
}

function restoreRaw(text: string, pieces: readonly Piece[]): string {
  return text.replace(PLACEHOLDER, (_match, index: string) => pieces[Number(index)]?.raw ?? "");
}

// ───────────────────────────── fence internals ─────────────────────────────

function parseFenceOpen(line: string): Fence | null {
  const match = FENCE_OPEN.exec(line);
  const indent = match?.[1];
  const run = match?.[2];
  const info = match?.[3] ?? "";
  if (indent === undefined || run === undefined) return null;
  const char = run.startsWith("`") ? "`" : "~";
  if (char === "`" && info.includes("`")) return null;
  return { char, length: run.length, indent: indent.length, info };
}

/**
 * Copy a fenced block verbatim, re-emitted at column 0 with a guaranteed closing fence, so GitHub
 * sees a top-level fence wherever the model nested it, and an unclosed fence cannot swallow the
 * rest of our comment.
 */
function readFence(lines: readonly string[], start: number, fence: Fence): { block: string; next: number } {
  const delimiter = fence.char.repeat(fence.length);
  const body = [delimiter + fenceLanguage(fence.info)];
  let next = start + 1;
  for (; next < lines.length; next++) {
    const line = dedent(lines[next] ?? "", fence.indent);
    if (closesFence(line, fence)) {
      next++;
      break;
    }
    body.push(defuseMarkers(line));
  }
  body.push(delimiter);
  return { block: body.join("\n"), next };
}

function closesFence(line: string, fence: Fence): boolean {
  const run = FENCE_CLOSE.exec(line)?.[1];
  return run !== undefined && run.startsWith(fence.char) && run.length >= fence.length;
}

function fenceLanguage(info: string): string {
  const language = info.trim().split(/\s+/)[0] ?? "";
  if (!/^[\w+#.-]{1,32}$/.test(language)) return "";
  return RENDERED_LANGUAGES.has(language.toLowerCase()) ? "text" : language;
}

function dedent(line: string, columns: number): string {
  let i = 0;
  while (i < columns && (line[i] === " " || line[i] === "\t")) i++;
  return line.slice(i);
}

function longestRun(text: string, char: string): number {
  let longest = 0;
  let current = 0;
  for (const ch of text) {
    current = ch === char ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

function count(text: string, char: string): number {
  return text.split(char).length - 1;
}
