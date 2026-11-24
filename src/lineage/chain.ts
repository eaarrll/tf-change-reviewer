/*
 * The lineage as a tree. A traced attribute can read several inputs (a local built from two
 * variables, a for_each next to the value it iterates), so the steps branch; only the branches that
 * reach a root cause explain the change. These helpers pick those branches out for the cause chain
 * and the "why it happens" text, so unchanged sibling inputs are not drawn as if they were upstream
 * of the changed line.
 */
import type { Lineage, LineageStep, SourceLocation } from "../types.js";

/** Steps by id. */
function byId(lineage: Lineage): Map<string, LineageStep> {
  return new Map(lineage.steps.map((s) => [s.id, s]));
}

/** Whether the lineage carries parent links (older or hand-built lineages may not). */
function hasTree(lineage: Lineage): boolean {
  return lineage.steps.some((s) => s.parentId !== undefined);
}

/** The steps from the traced attribute down to `id`, outermost (the resource) first. */
export function pathTo(lineage: Lineage, id: string): LineageStep[] {
  const steps = byId(lineage);
  const target = steps.get(id);
  if (!target) return [];
  if (!hasTree(lineage)) {
    // No parent links: the trace order is the best approximation of the path.
    const i = lineage.steps.indexOf(target);
    return lineage.steps.slice(0, i + 1);
  }
  const out: LineageStep[] = [];
  const seen = new Set<string>();
  let cur: LineageStep | undefined = target;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur);
    cur = cur.parentId === undefined ? undefined : steps.get(cur.parentId);
  }
  return out;
}

/** Paths enumerated per step at most (a step shared by many traced attributes). */
const MAX_PATHS_PER_STEP = 16;

/**
 * Every path from a traced attribute down to `id`: the primary one (pathTo) first, then those
 * through the other steps that also read a shared step (`alsoParentIds`).
 */
export function pathsTo(lineage: Lineage, id: string): LineageStep[][] {
  const primary = pathTo(lineage, id);
  if (!primary.length || !lineage.steps.some((s) => s.alsoParentIds?.length))
    return primary.length ? [primary] : [];
  const steps = byId(lineage);
  const out: LineageStep[][] = [];
  const walk = (cur: LineageStep, below: LineageStep[], seen: Set<string>): void => {
    if (out.length >= MAX_PATHS_PER_STEP) return;
    const path = [cur, ...below];
    const parents = [cur.parentId, ...(cur.alsoParentIds ?? [])]
      .map((p) => (p === undefined ? undefined : steps.get(p)))
      .filter((p): p is LineageStep => p !== undefined && !seen.has(p.id));
    if (!parents.length) {
      out.push(path);
      return;
    }
    for (const p of parents) walk(p, path, new Set([...seen, p.id]));
  };
  const target = steps.get(id)!;
  walk(target, [], new Set([id]));
  const key = (p: LineageStep[]): string => p.map((s) => s.id).join(",");
  const primaryKey = key(primary);
  return [primary, ...out.filter((p) => key(p) !== primaryKey)];
}

/** True when `ancestor` is on a path from the top to `id`. */
function isAncestor(lineage: Lineage, ancestor: string, id: string): boolean {
  return pathsTo(lineage, id).some((p) => p.some((s) => s.id === ancestor && s.id !== id));
}

/**
 * The branches that explain the change: one path per root cause and traced attribute that reads
 * it, from the traced attribute down to the root cause, ordered by where they start. A root cause that sits on another root cause's
 * path (a changed local whose changed tfvars value is also a cause) does not get its own path.
 * Without root causes: the path to the upstream resource change, else to the deepest step.
 */
export function causePaths(lineage: Lineage, max = 4): LineageStep[][] {
  if (lineage.steps.length === 0) return [];
  let targets = lineage.rootCauseIds.filter((id) => lineage.steps.some((s) => s.id === id));
  if (targets.length === 0) {
    const upstream = lineage.steps.filter((s) => s.kind === "upstream_resource");
    const pick =
      upstream.length > 0 ? upstream[upstream.length - 1]! : (deepest(lineage) ?? lineage.steps[0]!);
    targets = [pick.id];
  }
  const leaves = targets.filter((t) => !targets.some((o) => o !== t && isAncestor(lineage, t, o)));
  const paths = leaves.flatMap((id) => pathsTo(lineage, id)).filter((p) => p.length > 0);
  const order = (p: LineageStep[]): number =>
    Number(p[0]!.id.slice(1)) * 1000 + Number(p.at(-1)!.id.slice(1));
  return paths.sort((a, b) => order(a) - order(b)).slice(0, max);
}

/** The step farthest from the resource (first one on ties). */
function deepest(lineage: Lineage): LineageStep | undefined {
  let best: LineageStep | undefined;
  let bestDepth = -1;
  for (const s of lineage.steps) {
    const d = pathTo(lineage, s.id).length;
    if (d > bestDepth) {
      best = s;
      bestDepth = d;
    }
  }
  return best;
}

/** The traced attributes themselves (steps without a parent), in trace order. */
export function topSteps(lineage: Lineage): LineageStep[] {
  if (!hasTree(lineage)) return lineage.steps.slice(0, 1);
  return lineage.steps.filter((s) => s.parentId === undefined);
}

/** Every step on a branch that reaches a root cause (the tree pruned to its explaining part). */
export function explainingSteps(lineage: Lineage): Set<string> {
  const out = new Set<string>();
  for (const path of causePaths(lineage, Number.POSITIVE_INFINITY)) for (const s of path) out.add(s.id);
  return out;
}

/** Same file and side, and `inner`'s lines inside `outer`'s span (a block and a line in it). */
export function encloses(outer: SourceLocation | undefined, inner: SourceLocation | undefined): boolean {
  if (!outer || !inner) return false;
  return (
    outer.file === inner.file &&
    (outer.side ?? "head") === (inner.side ?? "head") &&
    outer.startLine <= inner.startLine &&
    inner.endLine <= outer.endLine &&
    (outer.startLine !== inner.startLine || outer.endLine !== inner.endLine)
  );
}

/** A cause path without the steps a later step of the same path sits inside (a block and its changed line). */
export function collapsePath(path: readonly LineageStep[]): LineageStep[] {
  return path.filter((s, i) => !path.slice(i + 1).some((n) => encloses(s.location, n.location)));
}
