/*
 * A tolerant, dependency-free scanner for HCL2 native syntax (.tf, .tfvars, .terraform.lock.hcl):
 * attributes and blocks with 1-based line spans, Terraform-style references of an expression, and
 * literal values. It never evaluates expressions and never throws: malformed or truncated input
 * yields a best-effort body.
 */

export interface HclAttribute {
  name: string;
  startLine: number;
  endLine: number;
  /** Source text of the expression, trimmed (CRLF normalized to LF). */
  exprText: string;
}

export interface HclBlock {
  type: string;
  labels: string[];
  startLine: number;
  endLine: number;
  body: HclBody;
}

export interface HclBody {
  attributes: HclAttribute[];
  blocks: HclBlock[];
}

// ───────────────────────────── lexer ─────────────────────────────

type TokenKind = "ident" | "number" | "string" | "heredoc" | "punct" | "newline" | "eof";

type TemplatePart = { kind: "literal"; text: string } | { kind: "interp" | "directive"; tokens: Token[] };

interface Token {
  kind: TokenKind;
  /** Identifier name, number text, operator, or the raw source of a string/heredoc. */
  text: string;
  start: number;
  end: number;
  line: number;
  endLine: number;
  /** Strings and heredocs: literal text and interpolations, in order. */
  parts?: TemplatePart[];
  /** Heredocs: `<<-` (indented) form. */
  indented?: boolean;
}

/** Template nesting deeper than this is kept as literal text (pathological input). */
const MAX_TEMPLATE_NESTING = 32;
/** Block nesting deeper than this is skipped (pathological input). */
const MAX_BLOCK_NESTING = 64;

const THREE_CHAR_OPS = new Set(["..."]);
const TWO_CHAR_OPS = new Set(["==", "!=", "<=", ">=", "=>", "&&", "||"]);
/** Operators after which (or before which) an expression continues on the next line. */
const CONTINUATION_OPS = new Set([
  "?",
  ":",
  "&&",
  "||",
  "+",
  "-",
  "*",
  "/",
  "%",
  "==",
  "!=",
  "<",
  ">",
  "<=",
  ">=",
  "=>",
  "!",
]);

function isIdentStart(ch: string): boolean {
  const c = ch.charCodeAt(0);
  if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) return true;
  return c > 127 && /\p{L}/u.test(ch);
}

function isIdentPart(ch: string): boolean {
  const c = ch.charCodeAt(0);
  if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 45)
    return true;
  return c > 127 && /[\p{L}\p{N}]/u.test(ch);
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

const NUMBER = /[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const HEREDOC_START = /<<(-?)([\p{L}_][\p{L}\p{N}_-]*)[ \t]*(?=\n|$)/uy;

class Lexer {
  pos = 0;
  line = 1;

  constructor(private readonly src: string) {}

  all(): Token[] {
    const { tokens } = this.lex(false, 0);
    tokens.push(this.token("eof", "", this.src.length, this.src.length));
    return tokens;
  }

  private token(kind: TokenKind, text: string, start: number, end: number, line = this.line): Token {
    return { kind, text, start, end, line, endLine: this.line };
  }

  /** Tokens until EOF, or (inside an interpolation) until the `}` that closes it. */
  private lex(inInterp: boolean, nesting: number): { tokens: Token[]; closed: boolean } {
    const src = this.src;
    const tokens: Token[] = [];
    let braces = 0;
    while (this.pos < src.length) {
      const ch = src[this.pos]!;
      const next = src[this.pos + 1];
      if (ch === "\n") {
        tokens.push(this.token("newline", "\n", this.pos, this.pos + 1));
        this.pos++;
        this.line++;
        continue;
      }
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\f" || ch === "\v" || ch === "﻿") {
        this.pos++;
        continue;
      }
      if (ch === "#" || (ch === "/" && next === "/")) {
        const nl = src.indexOf("\n", this.pos);
        this.pos = nl < 0 ? src.length : nl;
        continue;
      }
      if (ch === "/" && next === "*") {
        const close = src.indexOf("*/", this.pos + 2);
        const end = close < 0 ? src.length : close + 2;
        this.countLines(this.pos, end);
        this.pos = end;
        continue;
      }
      if (inInterp && ch === "}" && braces === 0) {
        this.pos++;
        return { tokens, closed: true };
      }
      if (ch === '"') {
        tokens.push(this.lexString(nesting));
        continue;
      }
      if (ch === "<" && next === "<") {
        const heredoc = this.lexHeredoc(nesting);
        if (heredoc) {
          tokens.push(heredoc);
          continue;
        }
      }
      if (isIdentStart(ch)) {
        const start = this.pos;
        this.pos++;
        while (this.pos < src.length && isIdentPart(src[this.pos]!)) this.pos++;
        tokens.push(this.token("ident", src.slice(start, this.pos), start, this.pos));
        continue;
      }
      if (isDigit(ch)) {
        NUMBER.lastIndex = this.pos;
        const m = NUMBER.exec(src);
        const end = m ? this.pos + m[0].length : this.pos + 1;
        tokens.push(this.token("number", src.slice(this.pos, end), this.pos, end));
        this.pos = end;
        continue;
      }
      const three = src.slice(this.pos, this.pos + 3);
      const two = src.slice(this.pos, this.pos + 2);
      const op = THREE_CHAR_OPS.has(three) ? three : TWO_CHAR_OPS.has(two) ? two : ch;
      if (inInterp) {
        if (op === "{") braces++;
        else if (op === "}") braces--;
      }
      tokens.push(this.token("punct", op, this.pos, this.pos + op.length));
      this.pos += op.length;
    }
    return { tokens, closed: false };
  }

  private countLines(from: number, to: number): void {
    for (let i = from; i < to; i++) if (this.src.charCodeAt(i) === 10) this.line++;
  }

  /** A quoted template. An unescaped newline outside an interpolation ends an unterminated string. */
  private lexString(nesting: number): Token {
    const src = this.src;
    const start = this.pos;
    const line = this.line;
    const parts: TemplatePart[] = [];
    let literal = "";
    this.pos++;
    while (this.pos < src.length) {
      const ch = src[this.pos]!;
      const next = src[this.pos + 1];
      if (ch === "\n") break;
      if (ch === '"') {
        this.pos++;
        break;
      }
      if (ch === "\\") {
        const { text, length } = decodeEscape(src, this.pos);
        literal += text;
        this.pos += length;
        continue;
      }
      if ((ch === "$" || ch === "%") && next === ch && src[this.pos + 2] === "{") {
        literal += `${ch}{`;
        this.pos += 3;
        continue;
      }
      if ((ch === "$" || ch === "%") && next === "{" && nesting < MAX_TEMPLATE_NESTING) {
        if (literal) parts.push({ kind: "literal", text: literal });
        literal = "";
        this.pos += 2;
        const { tokens } = this.lex(true, nesting + 1);
        parts.push({ kind: ch === "$" ? "interp" : "directive", tokens });
        continue;
      }
      literal += ch;
      this.pos++;
    }
    if (literal) parts.push({ kind: "literal", text: literal });
    const tok = this.token("string", src.slice(start, this.pos), start, this.pos, line);
    tok.parts = parts;
    return tok;
  }

  /** `<<EOF` / `<<-EOF` … terminator line (indentation tolerated for both forms). */
  private lexHeredoc(nesting: number): Token | null {
    const src = this.src;
    HEREDOC_START.lastIndex = this.pos;
    const m = HEREDOC_START.exec(src);
    if (!m) return null;
    const start = this.pos;
    const line = this.line;
    const marker = m[2]!;
    const nl = this.pos + m[0].length;
    let bodyStart = nl < src.length ? nl + 1 : nl;
    // Find the terminator line.
    let lineStart = bodyStart;
    let bodyEnd = src.length;
    let after = src.length;
    while (lineStart < src.length) {
      const lineEnd = src.indexOf("\n", lineStart);
      const end = lineEnd < 0 ? src.length : lineEnd;
      if (src.slice(lineStart, end).trim() === marker) {
        bodyEnd = lineStart;
        after = lineStart + src.slice(lineStart, end).indexOf(marker) + marker.length;
        break;
      }
      if (lineEnd < 0) break;
      lineStart = lineEnd + 1;
    }
    if (bodyStart > src.length) bodyStart = src.length;
    this.countLines(this.pos, bodyStart);
    this.pos = bodyStart;
    const parts = this.lexTemplateBody(bodyEnd, nesting);
    // An interpolation that ran past the terminator (malformed input) ends the heredoc where it stopped.
    if (this.pos <= after) {
      this.countLines(this.pos, after);
      this.pos = after;
    } else after = this.pos;
    const tok = this.token("heredoc", src.slice(start, after), start, after, line);
    tok.parts = parts;
    tok.indented = m[1] === "-";
    return tok;
  }

  /** Heredoc body: literal text with interpolations; no backslash escapes. */
  private lexTemplateBody(end: number, nesting: number): TemplatePart[] {
    const src = this.src;
    const parts: TemplatePart[] = [];
    let literal = "";
    while (this.pos < end) {
      const ch = src[this.pos]!;
      const next = src[this.pos + 1];
      if ((ch === "$" || ch === "%") && next === ch && src[this.pos + 2] === "{") {
        literal += `${ch}{`;
        this.pos += 3;
        continue;
      }
      if ((ch === "$" || ch === "%") && next === "{" && nesting < MAX_TEMPLATE_NESTING) {
        if (literal) parts.push({ kind: "literal", text: literal });
        literal = "";
        this.pos += 2;
        const { tokens } = this.lex(true, nesting + 1);
        parts.push({ kind: ch === "$" ? "interp" : "directive", tokens });
        if (this.pos > end) return parts;
        continue;
      }
      if (ch === "\n") this.line++;
      literal += ch;
      this.pos++;
    }
    if (literal) parts.push({ kind: "literal", text: literal });
    return parts;
  }
}

function decodeEscape(src: string, pos: number): { text: string; length: number } {
  const c = src[pos + 1];
  switch (c) {
    case "n":
      return { text: "\n", length: 2 };
    case "t":
      return { text: "\t", length: 2 };
    case "r":
      return { text: "\r", length: 2 };
    case '"':
      return { text: '"', length: 2 };
    case "\\":
      return { text: "\\", length: 2 };
    case "u":
    case "U": {
      const digits = c === "u" ? 4 : 8;
      const hex = src.slice(pos + 2, pos + 2 + digits);
      if (hex.length === digits && /^[0-9a-fA-F]+$/.test(hex)) {
        const code = parseInt(hex, 16);
        if (code <= 0x10ffff) return { text: String.fromCodePoint(code), length: 2 + digits };
      }
      return { text: `\\${c}`, length: 2 };
    }
    case undefined:
    case "\n":
      return { text: "\\", length: 1 };
    default:
      return { text: `\\${c}`, length: 2 };
  }
}

function normalizeSource(text: string): string {
  return text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
}

function lexText(text: string): { src: string; tokens: Token[] } {
  const src = normalizeSource(text);
  return { src, tokens: new Lexer(src).all() };
}

function isPunct(t: Token | undefined, text: string): boolean {
  return t !== undefined && t.kind === "punct" && t.text === text;
}

/** The literal text of a string token without interpolations, else null. */
function stringValue(t: Token): string | null {
  if (t.kind !== "string" && t.kind !== "heredoc") return null;
  const parts = t.parts ?? [];
  if (parts.some((p) => p.kind !== "literal")) return null;
  const text = parts.map((p) => (p.kind === "literal" ? p.text : "")).join("");
  return t.kind === "heredoc" && t.indented ? dedent(text) : text;
}

function dedent(text: string): string {
  const lines = text.split("\n");
  const indents = lines.filter((l) => l.trim() !== "").map((l) => /^[ \t]*/.exec(l)![0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(Math.min(min, /^[ \t]*/.exec(l)![0].length))).join("\n");
}

// ───────────────────────────── body parser ─────────────────────────────

/** Parse HCL native syntax into attributes and blocks with 1-based line spans. Never throws. */
export function parseHcl(text: string): HclBody {
  try {
    const { src, tokens } = lexText(text);
    return new BodyParser(src, tokens).parseBody(0, true).body;
  } catch {
    return { attributes: [], blocks: [] };
  }
}

class BodyParser {
  private i = 0;

  constructor(
    private readonly src: string,
    private readonly tokens: Token[],
  ) {}

  private at(i: number): Token {
    return this.tokens[Math.min(i, this.tokens.length - 1)]!;
  }

  parseBody(depth: number, top: boolean): { body: HclBody; closed: boolean } {
    const body: HclBody = { attributes: [], blocks: [] };
    for (;;) {
      const t = this.at(this.i);
      if (t.kind === "eof") return { body, closed: false };
      if (t.kind === "newline" || isPunct(t, ";") || isPunct(t, ",")) {
        this.i++;
        continue;
      }
      if (isPunct(t, "}")) {
        if (!top) return { body, closed: true };
        this.i++;
        continue;
      }
      if (t.kind === "ident") {
        if (isPunct(this.at(this.i + 1), "=")) {
          body.attributes.push(this.parseAttribute());
          continue;
        }
        const labels: string[] = [];
        let j = this.i + 1;
        for (;;) {
          const l = this.at(j);
          if (l.kind === "ident") labels.push(l.text);
          else if (l.kind === "string") labels.push(stringValue(l) ?? l.text.replace(/^"|"$/g, ""));
          else break;
          j++;
        }
        if (isPunct(this.at(j), "{")) {
          if (depth >= MAX_BLOCK_NESTING) {
            this.i = j;
            this.skipStatement();
            continue;
          }
          this.i = j + 1;
          const inner = this.parseBody(depth + 1, false);
          let endLine: number;
          if (inner.closed) {
            endLine = this.at(this.i).line;
            this.i++;
          } else {
            endLine = this.lastLine(this.i);
          }
          body.blocks.push({ type: t.text, labels, startLine: t.line, endLine, body: inner.body });
          continue;
        }
      }
      this.skipStatement();
    }
  }

  private parseAttribute(): HclAttribute {
    const nameTok = this.at(this.i);
    const exprStart = this.i + 2;
    const end = scanExpression(this.tokens, exprStart);
    this.i = end;
    let last = end - 1;
    while (last >= exprStart && this.at(last).kind === "newline") last--;
    if (last < exprStart) {
      return { name: nameTok.text, startLine: nameTok.line, endLine: nameTok.line, exprText: "" };
    }
    const first = this.at(exprStart);
    const lastTok = this.at(last);
    return {
      name: nameTok.text,
      startLine: nameTok.line,
      endLine: Math.max(nameTok.line, lastTok.endLine),
      exprText: this.src.slice(first.start, lastTok.end).trim(),
    };
  }

  /** Last line with a token before index `i` (for unterminated blocks). */
  private lastLine(i: number): number {
    for (let k = Math.min(i, this.tokens.length - 1); k >= 0; k--) {
      const t = this.at(k);
      if (t.kind !== "eof" && t.kind !== "newline") return t.endLine;
    }
    return 1;
  }

  /** Error recovery: skip to the end of the line (balancing brackets), never past a closing `}`. */
  private skipStatement(): void {
    let depth = 0;
    for (;;) {
      const t = this.at(this.i);
      if (t.kind === "eof") return;
      if (t.kind === "newline" && depth === 0) return;
      if (t.kind === "punct") {
        if (t.text === "(" || t.text === "[" || t.text === "{") depth++;
        else if (t.text === ")" || t.text === "]" || t.text === "}") {
          if (depth === 0) {
            if (t.text === "}") return;
          } else depth--;
        }
      }
      this.i++;
    }
  }
}

/**
 * Index of the token that ends the expression starting at `k`: a newline outside brackets (unless
 * the expression continues with an operator), a `}` closing the enclosing block, `;`, or EOF.
 */
function scanExpression(tokens: Token[], k: number): number {
  let depth = 0;
  let lastSig: Token | null = null;
  const n = tokens.length;
  for (; k < n; k++) {
    const t = tokens[k]!;
    if (t.kind === "eof") return k;
    if (t.kind === "newline") {
      if (depth > 0) continue;
      if (lastSig === null) return k;
      if (lastSig.kind === "punct" && CONTINUATION_OPS.has(lastSig.text)) continue;
      let j = k + 1;
      while (j < n && tokens[j]!.kind === "newline") j++;
      const nx = tokens[j];
      if (nx && nx.kind === "punct" && CONTINUATION_OPS.has(nx.text)) continue;
      return k;
    }
    if (t.kind === "punct") {
      if (t.text === "(" || t.text === "[" || t.text === "{") depth++;
      else if (t.text === ")" || t.text === "]" || t.text === "}") {
        if (depth === 0) {
          if (t.text === "}") return k;
        } else depth--;
      } else if (t.text === ";" && depth === 0) return k;
    }
    lastSig = t;
  }
  return k;
}

// ───────────────────────────── references ─────────────────────────────

const KEYWORDS = new Set(["for", "in", "if", "true", "false", "null", "endfor", "else", "endif"]);
const SIMPLE_ROOTS = new Set(["var", "local", "each", "count", "path", "terraform"]);

/** `own`: `[count.index]` / `[each.key]`, the referencing instance's own key. */
type TraversalStep = { attr: string } | { index: string | number } | { own: "count.index" | "each.key" };

interface Frame {
  open: string;
  /** Next token is in key position of an object constructor. */
  keyPos: boolean;
  forVars: Set<string>;
}

/**
 * Terraform-style references made by an expression, as `terraform show -json` lists them: the full
 * static traversal first, then each shorter prefix down to the referenced object, then the keyless
 * resource / module call (`aws_x.y["k"].id`, `aws_x.y["k"]`, `aws_x.y`; `module.m.out`, `module.m`).
 * Text in string literals is ignored except inside `${…}` / `%{…}`; object keys, function names
 * and for-expression iterator variables are not references. Resource references need an
 * underscore in the type (`aws_instance.web`), which keeps iterator-like traversals out.
 * `iterators` are extra roots referenced like `var` (e.g. a dynamic block's `ingress.value`).
 */
export function findReferences(exprText: string, iterators: readonly string[] = []): string[] {
  try {
    const { tokens } = lexText(exprText);
    const out = new Set<string>();
    collectReferences(tokens, new Set(), new Set(iterators), out);
    return [...out];
  } catch {
    return [];
  }
}

function collectReferences(
  tokens: Token[],
  excluded: Set<string>,
  roots: ReadonlySet<string>,
  out: Set<string>,
): void {
  const stack: Frame[] = [];
  const isExcluded = (name: string): boolean => excluded.has(name) || stack.some((f) => f.forVars.has(name));
  const prevSig = (i: number): Token | undefined => {
    for (let k = i - 1; k >= 0; k--) if (tokens[k]!.kind !== "newline") return tokens[k];
    return undefined;
  };
  const nextSig = (i: number): number => {
    let k = i + 1;
    while (k < tokens.length && tokens[k]!.kind === "newline") k++;
    return k;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const frame = stack[stack.length - 1];
    if (t.kind === "newline") {
      if (frame && frame.open === "{") frame.keyPos = true;
      continue;
    }
    const keyPos = frame?.keyPos ?? false;
    if (frame) frame.keyPos = false;

    if (t.kind === "punct") {
      if (t.text === "{" || t.text === "[" || t.text === "(") {
        const f: Frame = { open: t.text, keyPos: t.text === "{", forVars: new Set() };
        stack.push(f);
        const k = nextSig(i);
        if ((t.text === "{" || t.text === "[") && tokens[k]?.kind === "ident" && tokens[k]!.text === "for") {
          // for-expression: iterator names up to `in` are local to this bracket.
          f.keyPos = false;
          let j = k + 1;
          while (j < tokens.length && !(tokens[j]!.kind === "ident" && tokens[j]!.text === "in")) {
            if (tokens[j]!.kind === "ident") f.forVars.add(tokens[j]!.text);
            else if (!isPunct(tokens[j], ",") && tokens[j]!.kind !== "newline") break;
            j++;
          }
          i = j;
        }
      } else if (t.text === "}" || t.text === "]" || t.text === ")") {
        stack.pop();
      } else if (t.text === "," && frame && frame.open === "{") {
        frame.keyPos = true;
      }
      continue;
    }

    if (t.kind === "string" || t.kind === "heredoc") {
      collectTemplate(
        t.parts ?? [],
        new Set([...excluded, ...stack.flatMap((f) => [...f.forVars])]),
        roots,
        out,
      );
      continue;
    }

    if (t.kind !== "ident") continue;
    const next = tokens[i + 1];
    if (isPunct(prevSig(i), ".")) continue; // attribute of something else, e.g. f(x).name
    if (isPunct(next, "(")) continue; // function call
    if (isPunct(next, ":") && isPunct(tokens[i + 2], ":")) continue; // provider::ns::fn
    if (keyPos && (isPunct(next, "=") || isPunct(next, ":"))) continue; // object key
    if (!isPunct(next, ".") && !isPunct(next, "[")) continue; // a bare identifier is never a reference
    if (KEYWORDS.has(t.text) && !isPunct(next, ".")) continue;

    const { steps, end } = readTraversal(tokens, i + 1);
    if (!isExcluded(t.text)) for (const ref of formatReferences(t.text, steps, roots)) out.add(ref);
    // `x[count.index]` reads count.index too (the scan resumes after the bracket it consumed).
    for (const s of steps) if ("own" in s && !isExcluded(s.own.split(".")[0]!)) out.add(s.own);
    // Continue after the static part; a dynamic index is scanned as an ordinary bracket.
    i = end - 1;
  }
}

function collectTemplate(
  parts: TemplatePart[],
  excluded: Set<string>,
  roots: ReadonlySet<string>,
  out: Set<string>,
): void {
  const scope = new Set(excluded);
  for (const part of parts) {
    if (part.kind === "literal") continue;
    const toks = part.tokens.filter((t) => t.kind !== "newline");
    if (part.kind === "directive" && toks[0]?.kind === "ident" && toks[0].text === "for") {
      let j = 1;
      while (j < toks.length && !(toks[j]!.kind === "ident" && toks[j]!.text === "in")) {
        if (toks[j]!.kind === "ident") scope.add(toks[j]!.text);
        j++;
      }
      collectReferences(toks.slice(j + 1), scope, roots, out);
      continue;
    }
    collectReferences(part.tokens, scope, roots, out);
  }
}

/** Static attribute / index steps after a root identifier; stops at a splat or a dynamic index. */
function readTraversal(tokens: Token[], i: number): { steps: TraversalStep[]; end: number } {
  const steps: TraversalStep[] = [];
  for (;;) {
    const t = tokens[i];
    if (isPunct(t, ".")) {
      const n = tokens[i + 1];
      if (n?.kind === "ident") {
        steps.push({ attr: n.text });
        i += 2;
        continue;
      }
      if (n?.kind === "number" && /^\d+$/.test(n.text)) {
        steps.push({ index: Number(n.text) });
        i += 2;
        continue;
      }
      return { steps, end: i };
    }
    if (isPunct(t, "[")) {
      const own = ownIndex(tokens, i);
      if (own) {
        steps.push({ own });
        i += 5;
        continue;
      }
      const k = tokens[i + 1];
      const close = tokens[i + 2];
      if (k && isPunct(close, "]")) {
        if (k.kind === "number" && /^\d+$/.test(k.text)) {
          steps.push({ index: Number(k.text) });
          i += 3;
          continue;
        }
        const s = k.kind === "string" ? stringValue(k) : null;
        if (s !== null) {
          steps.push({ index: s });
          i += 3;
          continue;
        }
      }
    }
    return { steps, end: i };
  }
}

/** `[count.index]` or `[each.key]` starting at tokens[i] (the `[`). */
function ownIndex(tokens: Token[], i: number): "count.index" | "each.key" | null {
  const [a, dot, b, close] = [tokens[i + 1], tokens[i + 2], tokens[i + 3], tokens[i + 4]];
  if (a?.kind !== "ident" || !isPunct(dot, ".") || b?.kind !== "ident" || !isPunct(close, "]")) return null;
  if (a.text === "count" && b.text === "index") return "count.index";
  if (a.text === "each" && b.text === "key") return "each.key";
  return null;
}

function formatStep(step: TraversalStep): string {
  if ("attr" in step) return `.${step.attr}`;
  if ("own" in step) return `[${step.own}]`;
  return typeof step.index === "number" ? `[${step.index}]` : `[${JSON.stringify(step.index)}]`;
}

function formatReferences(root: string, all: TraversalStep[], roots: ReadonlySet<string>): string[] {
  // An own-key index (`[count.index]`) is kept only on managed resources, where the tracer resolves
  // it to the referencing instance's key; elsewhere the traversal ends before it, as Terraform's do.
  const resource =
    root !== "self" && !SIMPLE_ROOTS.has(root) && !roots.has(root) && root !== "module" && root !== "data";
  const own = all.findIndex((s) => "own" in s);
  const steps = !resource && own >= 0 ? all.slice(0, own) : all;
  const attrAt = (k: number): string | undefined => {
    const s = steps[k];
    return s && "attr" in s ? s.attr : undefined;
  };
  const hasIndexAt = (k: number): boolean => {
    const s = steps[k];
    return s !== undefined && ("index" in s || "own" in s);
  };
  // Subject length (in steps after the root) and the keyless form, per root kind.
  let subject: number;
  const extras: string[] = [];
  if (root === "self") {
    subject = 0;
  } else if (SIMPLE_ROOTS.has(root) || roots.has(root)) {
    if (!attrAt(0)) return [];
    if (root === "each" && attrAt(0) !== "key" && attrAt(0) !== "value") return [];
    subject = 1;
  } else if (root === "module") {
    if (!attrAt(0)) return [];
    subject = 1;
    if (hasIndexAt(subject)) subject++;
    if (attrAt(subject)) subject++;
    if (subject > 1) extras.push(`module.${attrAt(0)}`);
  } else if (root === "data") {
    if (!attrAt(0) || !attrAt(1)) return [];
    subject = 2;
    if (hasIndexAt(2)) {
      subject = 3;
      extras.push(`data.${attrAt(0)}.${attrAt(1)}`);
    }
  } else {
    if (!root.includes("_") || !attrAt(0)) return [];
    subject = 1;
    if (hasIndexAt(1)) {
      subject = 2;
      extras.push(`${root}.${attrAt(0)}`);
    }
  }
  const out: string[] = [];
  for (let n = steps.length; n >= subject; n--) out.push(root + steps.slice(0, n).map(formatStep).join(""));
  out.push(...extras);
  return out;
}

// ───────────────────────────── literals ─────────────────────────────

export type LiteralResult = { ok: true; value: unknown } | { ok: false };

/**
 * The value of a literal expression (strings without interpolation, numbers, bools, null, lists,
 * objects, heredocs without interpolation), as in .tfvars files. Anything else → `{ ok: false }`.
 */
export function evaluateLiteral(exprText: string): LiteralResult {
  try {
    const { tokens } = lexText(exprText);
    const sig = tokens.filter((t) => t.kind !== "newline");
    const p = { i: 0 };
    const value = parseLiteralValue(sig, p, 0);
    if (value === NOT_LITERAL || sig[p.i]?.kind !== "eof") return { ok: false };
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

const NOT_LITERAL = Symbol("not-literal");

function parseLiteralValue(tokens: Token[], p: { i: number }, depth: number): unknown {
  if (depth > 64) return NOT_LITERAL;
  const t = tokens[p.i];
  if (!t) return NOT_LITERAL;
  if (t.kind === "string" || t.kind === "heredoc") {
    const s = stringValue(t);
    p.i++;
    return s === null ? NOT_LITERAL : s;
  }
  if (t.kind === "number") {
    p.i++;
    return Number(t.text);
  }
  if (isPunct(t, "-") && tokens[p.i + 1]?.kind === "number") {
    p.i += 2;
    return -Number(tokens[p.i - 1]!.text);
  }
  if (t.kind === "ident") {
    if (isPunct(tokens[p.i + 1], ".") || isPunct(tokens[p.i + 1], "(") || isPunct(tokens[p.i + 1], "["))
      return NOT_LITERAL;
    p.i++;
    if (t.text === "true") return true;
    if (t.text === "false") return false;
    if (t.text === "null") return null;
    return NOT_LITERAL;
  }
  if (isPunct(t, "[")) {
    p.i++;
    const list: unknown[] = [];
    while (!isPunct(tokens[p.i], "]")) {
      if (tokens[p.i]?.kind === "eof" || !tokens[p.i]) return NOT_LITERAL;
      const v = parseLiteralValue(tokens, p, depth + 1);
      if (v === NOT_LITERAL) return NOT_LITERAL;
      list.push(v);
      if (isPunct(tokens[p.i], ",")) p.i++;
      else if (!isPunct(tokens[p.i], "]")) return NOT_LITERAL;
    }
    p.i++;
    return list;
  }
  if (isPunct(t, "{")) {
    p.i++;
    const obj: Record<string, unknown> = {};
    while (!isPunct(tokens[p.i], "}")) {
      const k = tokens[p.i];
      if (!k || k.kind === "eof") return NOT_LITERAL;
      let key: string | null = null;
      if (k.kind === "ident") key = k.text;
      else if (k.kind === "string") key = stringValue(k);
      else if (k.kind === "number") key = k.text;
      if (key === null) return NOT_LITERAL;
      p.i++;
      if (!isPunct(tokens[p.i], "=") && !isPunct(tokens[p.i], ":")) return NOT_LITERAL;
      p.i++;
      const v = parseLiteralValue(tokens, p, depth + 1);
      if (v === NOT_LITERAL) return NOT_LITERAL;
      obj[key] = v;
      if (isPunct(tokens[p.i], ",")) p.i++;
    }
    p.i++;
    return obj;
  }
  return NOT_LITERAL;
}

// ───────────────────────────── object keys ─────────────────────────────

/**
 * Lines (1-based, relative to the first line of `exprText`) of `key = value` inside the top-level
 * object constructor of an expression, e.g. a tag in `tags = { … }`. Null when not found.
 */
export function locateObjectKey(
  exprText: string,
  key: string,
): { startLine: number; endLine: number } | null {
  try {
    const { tokens } = lexText(exprText);
    const first = tokens.findIndex((t) => t.kind !== "newline");
    if (!isPunct(tokens[first], "{")) return null;
    let depth = 0;
    let keyPos = false;
    for (let i = first; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t.kind === "punct" && (t.text === "{" || t.text === "[" || t.text === "(")) {
        depth++;
        keyPos = depth === 1;
        continue;
      }
      if (t.kind === "punct" && (t.text === "}" || t.text === "]" || t.text === ")")) {
        depth--;
        if (depth <= 0) return null;
        continue;
      }
      if (depth === 1 && (t.kind === "newline" || isPunct(t, ","))) {
        keyPos = true;
        continue;
      }
      if (depth === 1 && keyPos) {
        keyPos = false;
        const name = t.kind === "ident" ? t.text : t.kind === "string" ? stringValue(t) : null;
        const sep = tokens[i + 1];
        if (name === key && (isPunct(sep, "=") || isPunct(sep, ":"))) {
          const end = scanObjectValue(tokens, i + 2);
          return { startLine: t.line, endLine: Math.max(t.line, end) };
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Last line of an object member's value starting at token `k`. */
function scanObjectValue(tokens: Token[], k: number): number {
  let depth = 0;
  let endLine = tokens[k]?.line ?? 1;
  for (; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.kind === "eof") break;
    if (t.kind === "newline" && depth === 0) break;
    if (t.kind === "punct") {
      if (t.text === "{" || t.text === "[" || t.text === "(") depth++;
      else if (t.text === "}" || t.text === "]" || t.text === ")") {
        if (depth === 0) break;
        depth--;
      } else if (t.text === "," && depth === 0) break;
    }
    if (t.kind !== "newline") endLine = t.endLine;
  }
  return endLine;
}
