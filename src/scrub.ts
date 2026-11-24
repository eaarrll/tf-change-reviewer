/*
 * Value-equality scrubbing of text that never went through plan masking: source files and the PR
 * diff the agent reads, lineage snippets, model output, the rendered report. The values come from
 * plan/mask.ts (every value the plan marks sensitive, and secret-looking credential values), so a
 * sensitive value copied into a .tfvars file, a JSON policy or a CI comment is hidden there too.
 *
 * Each value is also matched in the encodings it takes in those texts (encodedForms): an HCL quoted
 * string (`"Mod\"Pw"`), a JSON string (Terraform's encoder also writes & < > as & <
 * >), and HCL template escapes (`$${`, `%%{`). A multi-line value is also matched line by line
 * (createLineMatcher): all of its lines in a row, whatever their indentation or diff marker (an
 * indented `<<-EOT` heredoc, whose source keeps the indentation the plan value lost), and a line
 * on its own, anywhere, only when that line holds a secret itself (isSecretLine: a credential
 * assignment, a mixed-case or opaque token), so a diff hunk showing only the key line is hidden,
 * but lines a secret script shares with ordinary ones (`#!/bin/bash`, `export
 * AWS_DEFAULT_REGION=us-east-1`, `echo "Installing Docker 24"`) are not.
 *
 * Values of 8+ characters are replaced wherever they occur; shorter ones (4-7) only as a whole
 * string or as a quoted token (`"abcd"`), so a short value does not blank unrelated words. Line
 * breaks inside a value are kept, so line numbers computed on the raw text stay valid.
 */
import { isSecretAssignment, looksOpaque } from "./redact.js";
import { SENSITIVE_PLACEHOLDER } from "./types.js";

const MIN_EXACT = 4;
const MIN_SUBSTRING = 8;
/** Larger value sets are matched in chunks (one regex per chunk) to keep each pattern bounded. */
const CHUNK = 200;
/** Length of the form prefixes createFormMatcher looks up before running its patterns. */
const PREFIX = 8;

export interface Scrubber {
  /** Number of values scrubbed for (0 = a no-op scrubber). */
  readonly size: number;
  text(value: string): string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The placeholder, followed by the line breaks the matched text spanned. */
function replacement(matched: string): string {
  const breaks = matched.match(/\r?\n/g);
  return breaks ? SENSITIVE_PLACEHOLDER + breaks.join("") : SENSITIVE_PLACEHOLDER;
}

/** HCL template escapes: `${` and `%{` are written `$${` and `%%{` in quoted strings and heredocs. */
function templateEscaped(value: string): string {
  // Replacer functions: in a replacement string "$$" would mean a single "$".
  return value.replace(/\$\{/g, () => "$${").replace(/%\{/g, () => "%%{");
}

/** An HCL quoted string's body: backslash escapes plus template escapes. */
function hclQuoted(value: string): string {
  const escaped = value.replace(/[\\"\n\r\t]/g, (c) =>
    c === "\\" ? "\\\\" : c === '"' ? '\\"' : c === "\n" ? "\\n" : c === "\r" ? "\\r" : "\\t",
  );
  return templateEscaped(escaped);
}

/** A JSON string's body (JSON.stringify without the quotes). */
function jsonBody(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/** Go's encoding/json (Terraform's plan and jsonencode output) also escapes & < > and U+2028/9. */
function goJsonBody(value: string): string {
  return jsonBody(value).replace(
    /[&<>\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * Whether a value is distinctive enough to hide wherever it occurs: mixed character classes or a
 * long opaque token. Plain names (`prod-cart-events`), commands (`set -euo pipefail`), URLs (their
 * passwords have a redactSecrets rule), ARNs and paths are not.
 */
export function isDistinctive(value: string): boolean {
  if (value.length < MIN_SUBSTRING) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/|^arn:|^\//.test(value)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
  return classes >= 3 || (value.length >= 16 && /\d/.test(value) && /[A-Za-z]/.test(value));
}

/**
 * The forms a value takes in the texts scrubbed: as is, HCL-quoted, JSON-encoded (plain and Go's
 * HTML-safe variant), and with template escapes (heredocs, and .tf.json strings). Every form is at
 * least as long as the value's own threshold demands. Line-by-line matching is createLineMatcher's.
 */
export function encodedForms(value: string): string[] {
  const t = templateEscaped(value);
  return [
    ...new Set([value, t, hclQuoted(value), jsonBody(value), goJsonBody(value), jsonBody(t), goJsonBody(t)]),
  ];
}

/** Characters only an escaped form has: without them in a text, only the plain forms can occur. */
const ESCAPES = /\\|\$\$\{|%%\{/;

export interface FormMatcher {
  replace(text: string, replacer: (matched: string) => string): string;
}

/**
 * Replaces any of `forms` in a text, longest first, so a value containing another is replaced
 * whole (within one chunk of `chunk` alternatives, to keep each pattern bounded). A text with no
 * backslash or doubled template sign cannot hold an escaped form, so it is matched against the
 * plain forms only, which keeps the common case as fast as matching the raw values alone.
 */
export function createFormMatcher(forms: Iterable<string>, chunk = Infinity): FormMatcher {
  const build = (list: string[]): RegExp[] => {
    const sorted = [...list].sort((a, b) => b.length - a.length);
    const out: RegExp[] = [];
    for (let i = 0; i < sorted.length; i += chunk)
      out.push(
        new RegExp(
          sorted
            .slice(i, i + chunk)
            .map(escapeRegExp)
            .join("|"),
          "g",
        ),
      );
    return out;
  };
  const all = [...new Set(forms)].filter((f) => f !== "");
  if (all.length === 0) return { replace: (text) => text };
  const any = build(all);
  const plain = build(all.filter((f) => !ESCAPES.test(f)));
  // Prefilter: a text holds a form only if it holds the first `gram` characters of one. A set
  // lookup per position is far cheaper than a pattern with thousands of alternatives (PEM lines).
  const gram = Math.min(PREFIX, ...all.map((f) => f.length));
  const prefixes = new Set(all.map((f) => f.slice(0, gram)));
  const mayHold = (text: string): boolean => {
    for (let i = 0; i + gram <= text.length; i++) if (prefixes.has(text.slice(i, i + gram))) return true;
    return false;
  };
  return {
    replace(text, replacer) {
      if (!mayHold(text)) return text;
      let out = text;
      for (const re of ESCAPES.test(text) ? any : plain) out = out.replace(re, replacer);
      return out;
    },
  };
}

const LINE_BREAK = /(\r?\n|\r)/;

/** A line's content as a value line could appear in it: trimmed, and without a diff marker. */
function lineKeys(line: string): string[] {
  const trimmed = line.trim();
  return /^[+-]/.test(line) ? [trimmed, line.slice(1).trim()] : [trimmed];
}

/** The line with its content replaced: a diff marker, indentation and trailing blanks are kept. */
function maskLine(line: string): string {
  const m = /^([+-]?[ \t]*)(.*?)([ \t]*)$/.exec(line);
  return m && m[2] !== "" ? `${m[1]}${SENSITIVE_PLACEHOLDER}${m[3]}` : line;
}

/** A token that is a secret on its own: no blanks, and mixed case with digits, or long and opaque. */
function isSecretToken(value: string): boolean {
  if (value.length < MIN_SUBSTRING || /\s/.test(value)) return false;
  // URLs (their passwords have a redactSecrets rule), ARNs and paths are not.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/|^arn:|^[~.]?\//.test(value)) return false;
  return (
    (/[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value)) ||
    (value.length >= 32 && looksOpaque(value))
  );
}

/** `name = value`, `export NAME='value'`, `"name": "value",` on one line. */
const LINE_ASSIGNMENT =
  /^(?:export[ \t]+)?["']?([A-Za-z_][\w.-]{0,127})["']?[ \t]*[=:][ \t]*(.*?)[ \t]*[,;]?$/;

/**
 * Whether one line of a multi-line secret holds a secret itself, so it is hidden wherever it
 * occurs, even without the rest of the value: a credential assignment (`password: hunter2`,
 * `export DB_PASS='Qp7-...'`), an assignment of a secret-looking token (`key=Zq81-...`), or such a
 * token alone (a PEM body line). Lines a secret script shares with ordinary scripts are not:
 * `#!/bin/bash`, `export AWS_DEFAULT_REGION=us-east-1`, `echo "Installing Docker 24"`, PEM
 * BEGIN/END headers.
 */
export function isSecretLine(line: string): boolean {
  const text = line.trim();
  if (text.length < MIN_SUBSTRING) return false;
  const m = LINE_ASSIGNMENT.exec(text);
  const value = (m?.[2] ?? "").replace(/^(["'`])(.*)\1$/, "$2");
  // An assignment is judged by its value (`AMI=ami-0abc...` is not a token); a line that only
  // looks like one (base64 ending in `=` padding) as a whole.
  if (!m || /^=*$/.test(value)) return isSecretToken(text);
  return isSecretAssignment(m[1] ?? "", value) || isSecretToken(value);
}

export interface LineMatcher {
  /** Number of line patterns (0 = a no-op matcher). */
  readonly size: number;
  text(value: string): string;
}

/**
 * Hides the lines of multi-line values (8+ characters) in other texts:
 * - every line of a value when all of its lines appear in a row, as whole lines (trimmed, diff
 *   marker ignored): an indented heredoc in source, a diff hunk with the whole value, a copy of the
 *   value inside a longer script;
 * - a single line of a value only when it holds a secret itself (isSecretLine: `key=Zq81-...`, a
 *   PEM body line), anywhere and in any encoding (a partial diff hunk, a longer line), so lines a
 *   secret shares with ordinary text are kept, in non-sensitive plan values and source alike.
 * Line breaks are kept, so line numbers stay valid.
 */
export function createLineMatcher(values: Iterable<string>): LineMatcher {
  /** The secret lines, matched like whole values (every encoding, inside longer lines too). */
  const secretLines = new Set<string>();
  /** Runs of a value's lines (2+ non-empty), keyed by their first line. */
  const runs = new Map<string, string[][]>();
  for (const value of new Set(values)) {
    if (typeof value !== "string" || value.length < MIN_SUBSTRING || !/[\r\n]/.test(value)) continue;
    for (const l of value.split(/\r?\n|\r/)) if (isSecretLine(l)) secretLines.add(l.trim());
    for (const v of new Set([value, templateEscaped(value)])) {
      const lines = v.split(/\r?\n|\r/).map((l) => l.trim());
      while (lines.length && lines[0] === "") lines.shift();
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      if (lines.filter((l) => l !== "").length < 2 || lines.join("").length < MIN_SUBSTRING) continue;
      const first = lines[0]!;
      runs.set(first, [...(runs.get(first) ?? []), lines]);
    }
  }
  const size = secretLines.size + runs.size;
  if (size === 0) return { size, text: (value) => value };
  const singles = createFormMatcher([...secretLines].flatMap(encodedForms), CHUNK);
  return {
    size,
    text(value: string): string {
      if (typeof value !== "string" || value === "") return value;
      const parts = value.split(LINE_BREAK);
      // Lines sit at the even indexes; the odd ones are the breaks between them.
      const keys = parts.filter((_, i) => i % 2 === 0).map(lineKeys);
      const hide = new Array<boolean>(keys.length).fill(false);
      for (let i = 0; i < keys.length; i++) {
        for (const key of keys[i]!) {
          for (const run of runs.get(key) ?? []) {
            if (i + run.length > keys.length) continue;
            if (run.every((l, j) => keys[i + j]!.includes(l))) hide.fill(true, i, i + run.length);
          }
        }
      }
      const out = hide.includes(true)
        ? parts.map((p, i) => (i % 2 === 0 && hide[i / 2] ? maskLine(p) : p)).join("")
        : value;
      return singles.replace(out, () => SENSITIVE_PLACEHOLDER);
    },
  };
}

export function createScrubber(values: Iterable<string>): Scrubber {
  const all = [...new Set([...values].filter((v) => typeof v === "string" && v.length >= MIN_EXACT))];
  if (all.length === 0) return { size: 0, text: (value) => value };
  // A form is matched like the value it came from: anywhere when the value is long, else only quoted.
  const longForms = new Set<string>();
  const shortForms = new Set<string>();
  for (const v of all) {
    for (const f of encodedForms(v)) (v.length >= MIN_SUBSTRING ? longForms : shortForms).add(f);
  }
  for (const f of longForms) shortForms.delete(f);
  const exact = new Set([...longForms, ...shortForms]);
  // Longest first, so a value containing another is replaced whole.
  const long = createFormMatcher(longForms, CHUNK);
  const short = [...shortForms].sort((a, b) => b.length - a.length);
  const quoted: RegExp[] = [];
  for (let i = 0; i < short.length; i += CHUNK) {
    const alt = short
      .slice(i, i + CHUNK)
      .map(escapeRegExp)
      .join("|");
    quoted.push(new RegExp(`(["'\`])(${alt})\\1`, "g"));
  }
  const lines = createLineMatcher(all);
  return {
    size: all.length,
    text(value: string): string {
      if (typeof value !== "string" || value === "") return value;
      if (exact.has(value)) return replacement(value);
      let out = value;
      out = long.replace(out, replacement);
      for (const re of quoted)
        out = out.replace(re, (_m, q: string, v: string) => `${q}${replacement(v)}${q}`);
      return lines.text(out);
    },
  };
}

/** A no-op scrubber. */
export const NO_SCRUB: Scrubber = createScrubber([]);
