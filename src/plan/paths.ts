import type { AttrPath } from "../types.js";

/** Parsed resource instance address. */
export interface ParsedAddress {
  /** Instance address of the containing module (`module.a["x"].module.b`), or null for root. */
  moduleAddress: string | null;
  /** Module call names with instance keys stripped, e.g. ["a", "b"]. */
  configModulePath: string[];
  mode: "managed" | "data";
  type: string;
  name: string;
  index?: string | number;
  /** `type.name` (managed) or `data.type.name`, as used for resources in plan.configuration. */
  configAddress: string;
}

/**
 * Split a Terraform address into its parts. Handles module instance keys with dots, quotes and
 * brackets inside the key, e.g. `module.svc["a.b"].aws_s3_bucket.this[0]`.
 */
export function parseAddress(address: string): ParsedAddress {
  const parts = splitAddress(address);
  const modules: string[] = [];
  const moduleSegments: string[] = [];
  let i = 0;
  while (parts[i] === "module" && i + 1 < parts.length) {
    const seg = parts[i + 1]!;
    moduleSegments.push(`module.${seg}`);
    modules.push(stripIndex(seg).name);
    i += 2;
  }
  let mode: "managed" | "data" = "managed";
  if (parts[i] === "data") {
    mode = "data";
    i += 1;
  }
  const type = parts[i] ?? "";
  const last = stripIndex(parts[i + 1] ?? "");
  return {
    moduleAddress: moduleSegments.length ? moduleSegments.join(".") : null,
    configModulePath: modules,
    mode,
    type,
    name: last.name,
    ...(last.index !== undefined && { index: last.index }),
    configAddress: `${mode === "data" ? "data." : ""}${type}.${last.name}`,
  };
}

/** Split on dots that are outside brackets and quotes. */
function splitAddress(address: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < address.length; i++) {
    const ch = address[i]!;
    if (quoted) {
      current += ch;
      if (ch === "\\" && i + 1 < address.length) current += address[++i];
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === "[") depth++;
    else if (ch === "]") depth--;
    if (ch === "." && depth === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts;
}

function stripIndex(segment: string): { name: string; index?: string | number } {
  const open = segment.indexOf("[");
  if (open < 0 || !segment.endsWith("]")) return { name: segment };
  const raw = segment.slice(open + 1, -1);
  const name = segment.slice(0, open);
  if (/^\d+$/.test(raw)) return { name, index: Number(raw) };
  try {
    return { name, index: JSON.parse(raw) as string };
  } catch {
    return { name, index: raw };
  }
}

/** `["ingress", 0, "cidr_blocks"]` → `ingress[0].cidr_blocks`; map keys that are not identifiers are quoted. */
export function formatPath(path: AttrPath): string {
  let out = "";
  for (const step of path) {
    if (typeof step === "number") out += `[${step}]`;
    else if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(step)) out += out ? `.${step}` : step;
    else out += `[${JSON.stringify(step)}]`;
  }
  return out;
}

/** Keys that name an element of a nested-block list, in order of preference. */
const ELEMENT_NAME_KEYS = ["description", "name", "sid", "key"];

function elementName(el: unknown): string | null {
  if (el === null || typeof el !== "object" || Array.isArray(el)) return null;
  for (const k of ELEMENT_NAME_KEYS) {
    const v = (el as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim() !== "" && v.length <= 60 && !v.includes("(sensitive)")) return v;
  }
  return null;
}

/**
 * Like formatPath, but an index into a list of nested blocks that carry a description or name shows
 * that name instead (`value` is the object the path points into): `ingress "Postgres from office"
 * cidr_blocks` rather than `ingress[0].cidr_blocks`, whose index depends on Terraform's set order.
 */
export function describePath(value: unknown, path: AttrPath): string {
  let out = "";
  let cur: unknown = value;
  let afterName = false;
  for (const step of path) {
    if (typeof step === "number") {
      const el = Array.isArray(cur) ? cur[step] : undefined;
      const name = elementName(el);
      out += name === null ? `[${step}]` : ` ${JSON.stringify(name)}`;
      afterName = name !== null;
      cur = el;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(step)) out += out ? (afterName ? ` ${step}` : `.${step}`) : step;
    else out += `[${JSON.stringify(step)}]`;
    afterName = false;
    cur =
      cur !== null && typeof cur === "object" && !Array.isArray(cur)
        ? (cur as Record<string, unknown>)[step]
        : undefined;
  }
  return out;
}

export function pathKey(path: AttrPath): string {
  return JSON.stringify(path);
}

/** Value at a path, or undefined. */
export function getAtPath(value: unknown, path: AttrPath): unknown {
  let cur: unknown = value;
  for (const step of path) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof step === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[step];
    } else {
      if (typeof cur !== "object" || Array.isArray(cur)) return undefined;
      cur = (cur as Record<string, unknown>)[step];
    }
  }
  return cur;
}

/** True when `prefix` is a prefix of (or equal to) `path`. */
export function isPrefix(prefix: AttrPath, path: AttrPath): boolean {
  return prefix.length <= path.length && prefix.every((step, i) => step === path[i]);
}

/**
 * Leaf paths whose known value changes (`changed`) and paths that become unknown after apply
 * (`unknown`). Arrays of scalars and empty containers count as leaves (a list of CIDRs is one
 * change, not N). A replaced resource marks every computed attribute unknown, so callers usually
 * want `changed` for replacements and both for in-place updates.
 */
export function diffPaths(
  before: unknown,
  after: unknown,
  afterUnknown: unknown,
): { changed: AttrPath[]; unknown: AttrPath[] } {
  const changed: AttrPath[] = [];
  const unknown: AttrPath[] = [];
  walk(before, after, afterUnknown, [], changed, unknown);
  const byText = (a: AttrPath, b: AttrPath): number => formatPath(a).localeCompare(formatPath(b));
  return { changed: changed.sort(byText), unknown: unknown.sort(byText) };
}

/** Known-value changes plus paths that become unknown, merged and sorted. */
export function changedPaths(before: unknown, after: unknown, afterUnknown: unknown): AttrPath[] {
  const { changed, unknown } = diffPaths(before, after, afterUnknown);
  return [...changed, ...unknown].sort((a, b) => formatPath(a).localeCompare(formatPath(b)));
}

function isScalar(v: unknown): boolean {
  return v === null || v === undefined || typeof v !== "object";
}

function isLeafArray(v: unknown): boolean {
  return Array.isArray(v) && v.every(isScalar);
}

function walk(
  b: unknown,
  a: unknown,
  unknown: unknown,
  path: AttrPath,
  out: AttrPath[],
  unknownOut: AttrPath[],
): void {
  if (unknown === true) {
    unknownOut.push(path);
    return;
  }
  const bothObjects =
    b !== null &&
    a !== null &&
    typeof b === "object" &&
    typeof a === "object" &&
    Array.isArray(b) === Array.isArray(a);
  if (!bothObjects || isLeafArray(b) || isLeafArray(a)) {
    if (!path.length) return;
    if (!deepEqual(b, a)) out.push(path);
    else if (unknown !== undefined && unknown !== false && containsTrue(unknown)) unknownOut.push(path);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    const u = Array.isArray(unknown) ? unknown : [];
    for (let i = 0; i < n; i++) walk(b[i], a[i], u[i], [...path, i], out, unknownOut);
    return;
  }
  const bo = b as Record<string, unknown>;
  const ao = a as Record<string, unknown>;
  const uo =
    unknown && typeof unknown === "object" && !Array.isArray(unknown)
      ? (unknown as Record<string, unknown>)
      : {};
  const keys = new Set([...Object.keys(bo), ...Object.keys(ao), ...Object.keys(uo)]);
  for (const k of keys) walk(bo[k], ao[k], uo[k], [...path, k], out, unknownOut);
}

function containsTrue(v: unknown): boolean {
  if (v === true) return true;
  if (Array.isArray(v)) return v.some(containsTrue);
  if (v && typeof v === "object") return Object.values(v).some(containsTrue);
  return false;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if ((a === null || a === undefined) && (b === null || b === undefined)) return a === b;
  if (typeof a !== typeof b || typeof a !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) if (!deepEqual(ao[k], bo[k])) return false;
  return true;
}
