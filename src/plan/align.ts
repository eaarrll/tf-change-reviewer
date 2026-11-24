/*
 * Lines up the elements of nested-block lists between a change's `before` and `after`.
 *
 * Terraform writes a set of nested blocks (security group `ingress`, route table `route`, NACL
 * entries, …) as a JSON list in its own set order, so the same rule can sit at index 0 before the
 * change and index 1 after it. Compared by index, an edit to one rule then looks like an edit to
 * every rule, and "before → after" pairs values of two different rules. Before any path is
 * computed, `before` (and its sensitivity marks) is reordered so each element sits at the index of
 * its counterpart in `after`: exact matches first, then the most similar element (more than half
 * of its attributes equal). A list whose elements only changed order is left alone (an ordered
 * list, where order is the change). An element added in the middle of the set gets a null in
 * `before` at its index, so it reads as an addition rather than as an edit of whichever existing
 * element sat there.
 */
import { deepEqual } from "./paths.js";

/** Lists longer than this are compared by index (alignment is quadratic). */
const MAX_ALIGN = 100;
const MAX_DEPTH = 32;

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** `before` and `beforeSensitive` reordered to line up with `after`; the same objects when nothing moves. */
export function alignBefore(
  before: unknown,
  after: unknown,
  beforeSensitive: unknown,
): { before: unknown; beforeSensitive: unknown } {
  const [b, s] = align(before, after, beforeSensitive, 0);
  return { before: b, beforeSensitive: s };
}

function align(b: unknown, a: unknown, s: unknown, depth: number): [unknown, unknown] {
  if (depth > MAX_DEPTH) return [b, s];
  if (Array.isArray(b) && Array.isArray(a)) return alignList(b, a, s, depth);
  if (isRec(b) && isRec(a)) {
    let outB: Rec | null = null;
    let outS: Rec | null = null;
    const marks = isRec(s) ? s : null;
    for (const k of Object.keys(b)) {
      if (!(k in a)) continue;
      const [nb, ns] = align(b[k], a[k], marks?.[k], depth + 1);
      if (nb !== b[k]) (outB ??= { ...b })[k] = nb;
      if (marks && ns !== marks[k]) (outS ??= { ...marks })[k] = ns;
    }
    return [outB ?? b, outS ?? s];
  }
  return [b, s];
}

function alignList(b: unknown[], a: unknown[], s: unknown, depth: number): [unknown, unknown] {
  const objects = b.length > 0 && a.length > 0 && b.every(isRec) && a.every(isRec);
  let order: number[] | null = null;
  if (objects && b.length <= MAX_ALIGN && a.length <= MAX_ALIGN) order = matchOrder(b as Rec[], a as Rec[]);
  const marks = Array.isArray(s) ? s : null;
  let outB = order ? order.map((j) => (j < 0 ? null : b[j])) : b;
  let outS: unknown =
    order && marks && marks.length > 0 ? order.map((j) => (j < 0 ? false : (marks[j] ?? false))) : s;
  // Recurse into the elements that now line up.
  const n = Math.min(outB.length, a.length);
  let copiedB = outB !== b;
  let copiedS = outS !== s;
  for (let i = 0; i < n; i++) {
    const elemMarks = Array.isArray(outS) ? outS[i] : undefined;
    const [nb, ns] = align(outB[i], a[i], elemMarks, depth + 1);
    if (nb !== outB[i]) {
      if (!copiedB) outB = [...outB];
      copiedB = true;
      outB[i] = nb;
    }
    if (Array.isArray(outS) && ns !== elemMarks) {
      if (!copiedS) outS = [...outS];
      copiedS = true;
      (outS as unknown[])[i] = ns;
    }
  }
  return [outB, outS];
}

/**
 * For each `after` index, the `before` index that goes there (-1: an element added mid-list), then
 * the unmatched `before` indices; null when the list should stay as it is.
 */
function matchOrder(b: Rec[], a: Rec[]): number[] | null {
  const slot = new Array<number>(a.length).fill(-1);
  const used = new Set<number>();
  // 1. Exact matches, nearest index first.
  for (let i = 0; i < a.length; i++) {
    let best = -1;
    for (let j = 0; j < b.length; j++) {
      if (used.has(j) || !deepEqual(a[i], b[j])) continue;
      if (best < 0 || Math.abs(j - i) < Math.abs(best - i)) best = j;
    }
    if (best >= 0) {
      slot[i] = best;
      used.add(best);
    }
  }
  // 2. The most similar remaining pairs (more than half of the attributes equal).
  const pairs: { i: number; j: number; score: number }[] = [];
  for (let i = 0; i < a.length; i++) {
    if (slot[i]! >= 0) continue;
    for (let j = 0; j < b.length; j++) {
      if (used.has(j)) continue;
      const score = similarity(a[i]!, b[j]!);
      if (score > 0.5) pairs.push({ i, j, score });
    }
  }
  pairs.sort(
    (x, y) => y.score - x.score || Math.abs(x.i - x.j) - Math.abs(y.i - y.j) || x.i - y.i || x.j - y.j,
  );
  for (const p of pairs) {
    if (slot[p.i]! >= 0 || used.has(p.j)) continue;
    slot[p.i] = p.j;
    used.add(p.j);
  }
  // 3. What is left pairs up in order (an edited element stays an edit); extra before elements go last.
  const rest = b.map((_, j) => j).filter((j) => !used.has(j));
  for (let i = 0; i < a.length && rest.length > 0; i++) if (slot[i]! < 0) slot[i] = rest.shift()!;
  // Added elements at the end need no placeholder; those before a matched element keep their index.
  let end = slot.length;
  while (end > 0 && slot[end - 1]! < 0) end--;
  const order = [...slot.slice(0, end), ...rest];
  if (order.every((j, i) => j === i)) return null;
  // Same elements in another order: an ordered list was reordered, which is itself the change.
  if (a.length === b.length && order.every((j, i) => deepEqual(b[j], a[i]))) return null;
  return order;
}

/** Share of attributes (union of keys) with equal values. */
function similarity(x: Rec, y: Rec): number {
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  if (keys.size === 0) return 0;
  let equal = 0;
  for (const k of keys) if (deepEqual(x[k] ?? null, y[k] ?? null)) equal++;
  return equal / keys.size;
}
