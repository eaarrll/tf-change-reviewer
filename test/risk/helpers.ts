/* Builders for ResourceChange / PlanModel test data (no dependency on plan/load.ts). */
import { diffPaths, parseAddress } from "../../src/plan/paths.js";
import type {
  Action,
  AttrPath,
  ConfigModule,
  ConfigResource,
  PlanModel,
  ResourceChange,
} from "../../src/types.js";

export interface ChangeSpec {
  address: string;
  /** Raw change.actions; default ["update"]. */
  actions?: string[];
  before?: unknown;
  after?: unknown;
  afterUnknown?: unknown;
  actionReason?: string;
  replacePaths?: AttrPath[];
  importing?: { id?: string };
  previousAddress?: string;
  deposed?: string;
  sensitiveChangedPaths?: AttrPath[];
}

function normalize(
  actions: string[],
  importing: boolean,
  moved: boolean,
): Pick<ResourceChange, "action" | "replaceOrder"> {
  const key = actions.join(",");
  if (actions.includes("forget")) return { action: "forget" };
  if (key === "delete,create") return { action: "replace", replaceOrder: "destroy-before-create" };
  if (key === "create,delete") return { action: "replace", replaceOrder: "create-before-destroy" };
  if (key === "update") return { action: importing ? "import" : "update" };
  if (key === "no-op") return { action: importing ? "import" : moved ? "move" : "no-op" };
  return { action: key as Action };
}

/** A ResourceChange with changed/unknown paths computed from before/after like plan/load.ts does. */
export function rc(spec: ChangeSpec): ResourceChange {
  const parsed = parseAddress(spec.address);
  const actions = spec.actions ?? ["update"];
  const before = spec.before ?? null;
  const after = spec.after ?? null;
  const afterUnknown = spec.afterUnknown ?? {};
  const { changed, unknown } = diffPaths(before, after, afterUnknown);
  const moved = spec.previousAddress !== undefined && spec.previousAddress !== spec.address;
  return {
    address: spec.address,
    moduleAddress: parsed.moduleAddress,
    configModulePath: parsed.configModulePath,
    mode: parsed.mode,
    type: parsed.type,
    name: parsed.name,
    ...(parsed.index !== undefined && { index: parsed.index }),
    providerName: "registry.terraform.io/hashicorp/aws",
    ...(spec.previousAddress !== undefined && { previousAddress: spec.previousAddress }),
    ...(spec.deposed !== undefined && { deposed: spec.deposed }),
    actions,
    ...normalize(actions, spec.importing !== undefined, moved),
    ...(spec.actionReason !== undefined && { actionReason: spec.actionReason }),
    replacePaths: spec.replacePaths ?? [],
    ...(spec.importing !== undefined && { importing: spec.importing }),
    before,
    after,
    afterUnknown,
    changedPaths: changed,
    unknownPaths: unknown,
    sensitiveChangedPaths: spec.sensitiveChangedPaths ?? [],
  };
}

export function configModule(
  path: string[],
  resources: ConfigResource[] = [],
  extra: Partial<ConfigModule> = {},
): ConfigModule {
  return {
    path,
    resources: Object.fromEntries(resources.map((r) => [r.address, r])),
    moduleCalls: {},
    variables: {},
    outputs: {},
    ...extra,
  };
}

export function configResource(
  address: string,
  expressions: Record<string, unknown>,
  extra: Partial<ConfigResource> = {},
): ConfigResource {
  const [type = "", name = ""] = address.replace(/^data\./, "").split(".");
  return {
    address,
    mode: address.startsWith("data.") ? "data" : "managed",
    type,
    name,
    expressions,
    ...extra,
  };
}

/**
 * A PlanModel over the changes. Every module path the changes live in is declared in the
 * configuration (so nothing looks like a removed module) unless `modules` is given.
 */
export function plan(changes: ResourceChange[], extra: Partial<PlanModel> = {}): PlanModel {
  const modules: Record<string, ConfigModule> = { "": configModule([]) };
  for (const c of changes) {
    for (let n = 1; n <= c.configModulePath.length; n++) {
      const p = c.configModulePath.slice(0, n);
      modules[p.join(".")] ??= configModule(p);
    }
  }
  const counts: PlanModel["counts"] = {};
  for (const c of changes) if (c.action !== "no-op") counts[c.action] = (counts[c.action] ?? 0) + 1;
  return {
    formatVersion: "1.2",
    terraformVersion: "1.10.5",
    changes,
    drift: [],
    outputChanges: [],
    variables: {},
    modules,
    providerConstraints: {},
    errored: false,
    counts,
    ...extra,
  };
}

export const policyJson = (statements: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ Version: "2012-10-17", Statement: statements, ...extra });
