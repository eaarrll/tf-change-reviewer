// Shared builders for the lineage tests: an in-memory workspace and minimal plan JSON in the shape
// `terraform show -json` prints (only the fields loadPlan reads).
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { parseUnifiedDiff } from "../../src/git/diff.js";
import { loadPlan } from "../../src/plan/load.js";
import { createFsWorkspace } from "../../src/workspace.js";
import { SourceIndex } from "../../src/lineage/source.js";
import type { TraceContext } from "../../src/lineage/trace.js";
import type { Lineage, LineageStep, PlanModel, Workspace } from "../../src/types.js";

type Json = Record<string, unknown>;

/** Files keyed by repo path; listFiles returns direct children only, like the real workspace. */
export function memoryWorkspace(files: Record<string, string>, rootModuleDir = ""): Workspace {
  const norm = (p: string): string => posix.normalize(p.replace(/^\.\//, "")).replace(/^\.$/, "");
  return {
    root: "/repo",
    rootModuleDir,
    async readFile(path: string): Promise<string | null> {
      return files[norm(path)] ?? null;
    },
    async listFiles(dir: string, suffixes: readonly string[]): Promise<string[]> {
      const d = norm(dir);
      return Object.keys(files)
        .filter((f) => posix.dirname(f).replace(/^\.$/, "") === d)
        .filter((f) => !suffixes.length || suffixes.some((s) => f.endsWith(s)))
        .sort();
    },
  };
}

export interface RcOptions {
  before?: unknown;
  after?: unknown;
  afterUnknown?: unknown;
  replacePaths?: (string | number)[][];
  reason?: string;
  moduleAddress?: string;
  index?: string | number;
  mode?: "managed" | "data";
  provider?: string;
}

/** One resource_changes entry. The address carries module path, type, name and index. */
export function rc(address: string, actions: string[], o: RcOptions = {}): Json {
  const m = /^((?:module\.[^.[]+(?:\[[^\]]+\])?\.)*)(data\.)?([^.]+)\.([^.[]+)(?:\[(.+)\])?$/.exec(address);
  if (!m) throw new Error(`bad address ${address}`);
  const moduleAddress = o.moduleAddress ?? (m[1] ? m[1].slice(0, -1) : undefined);
  const index = o.index ?? (m[5] === undefined ? undefined : (JSON.parse(m[5]) as string | number));
  return {
    address,
    ...(moduleAddress && { module_address: moduleAddress }),
    mode: o.mode ?? (m[2] ? "data" : "managed"),
    type: m[3],
    name: m[4],
    ...(index !== undefined && { index }),
    provider_name: o.provider ?? "registry.terraform.io/hashicorp/aws",
    ...(o.reason && { action_reason: o.reason }),
    change: {
      actions,
      before: o.before ?? (actions.includes("create") && !actions.includes("delete") ? null : {}),
      after: o.after ?? (actions.join() === "delete" ? null : {}),
      after_unknown: o.afterUnknown ?? {},
      before_sensitive: {},
      after_sensitive: {},
      ...(o.replacePaths && { replace_paths: o.replacePaths }),
    },
  };
}

/** A configuration resource with expressions referencing `refs` per attribute. */
export function cres(address: string, expressions: Json = {}, extra: Json = {}): Json {
  const data = address.startsWith("data.");
  const [type, name] = address.replace(/^data\./, "").split(".");
  return { address, mode: data ? "data" : "managed", type, name, expressions, ...extra };
}

export function planJson(o: {
  rootModule?: Json;
  changes?: Json[];
  variables?: Record<string, unknown>;
  drift?: Json[];
}): Json {
  return {
    format_version: "1.2",
    terraform_version: "1.10.5",
    variables: Object.fromEntries(Object.entries(o.variables ?? {}).map(([k, v]) => [k, { value: v }])),
    resource_changes: o.changes ?? [],
    ...(o.drift && { resource_drift: o.drift }),
    configuration: { root_module: o.rootModule ?? {} },
  };
}

export function contextFor(
  plan: PlanModel,
  workspace: Workspace,
  diffText: string | null,
  extra: Partial<TraceContext> = {},
): TraceContext {
  return {
    plan,
    source: new SourceIndex(workspace, plan),
    diff: parseUnifiedDiff(diffText ?? ""),
    diffText,
    changesByAddress: new Map(plan.changes.map((c) => [c.address, c])),
    ...extra,
  };
}

const FIXTURES = new URL("../fixtures/lineage/", import.meta.url);

/** A generated scenario under test/fixtures/lineage: real plan, PR diff, `after/` as the repo. */
export function lineageFixture(name: string, diffOverride?: string | null): TraceContext {
  const dir = new URL(`${name}/`, FIXTURES);
  const plan = loadPlan(JSON.parse(readFileSync(new URL("plan.json", dir), "utf8")));
  const diff = diffOverride !== undefined ? diffOverride : readFileSync(new URL("pr.diff", dir), "utf8");
  return contextFor(plan, createFsWorkspace(new URL("after", dir).pathname, ""), diff);
}

export function changeOf(ctx: TraceContext, address: string) {
  const c = ctx.plan.changes.find((x) => x.address === address);
  if (!c) throw new Error(`no change ${address}`);
  return c;
}

/** `kind label @file:start-end*` lines: compact, readable assertions on a whole chain. */
export function chain(l: Lineage): string[] {
  return l.steps.map((s) => describeStep(s));
}

export function describeStep(s: LineageStep): string {
  const loc = s.location
    ? ` @${s.location.file}:${s.location.startLine}-${s.location.endLine}${s.location.side === "base" ? "(base)" : ""}`
    : "";
  return `${s.kind} ${s.label}${loc}${s.changedInDiff ? " *" : ""}`;
}

export function rootCauses(l: Lineage): LineageStep[] {
  return l.rootCauseIds.map((id) => l.steps.find((s) => s.id === id)!);
}
