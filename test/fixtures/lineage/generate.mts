/*
 * Regenerates the lineage test fixtures: real `terraform show -json` plans (trimmed of the fields
 * loadPlan ignores) and PR diffs for the scenarios in this directory.
 *
 * A scenario is <name>/{before/, after/, scenario.json?}. `after/` is the repository at the PR head
 * (tests read it as the workspace). For each scenario this script plans `before`, applies it to a
 * state (terraform apply for builtin-only configurations, a state crafted from the plan otherwise,
 * as evals/gen-fixtures.ts does), plans `after` against that state and writes <name>/plan.json and
 * <name>/pr.diff. AWS resources are planned offline with mock credentials and every skip_* flag.
 *
 * Usage: npx tsx test/fixtures/lineage/generate.mts [name ...]   (terraform on PATH)
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const PLUGIN_CACHE = join(ROOT, ".tf-plugin-cache");
const WORK = process.env.LINEAGE_FIXTURE_WORK ?? join(tmpdir(), "tf-change-reviewer-lineage-fixtures");

const MOCK_OVERRIDE = `provider "aws" {
  access_key                  = "mock_access_key"
  secret_key                  = "mock_secret_key"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
}
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

function tf(args: string[], cwd: string): string {
  const r = spawnSync("terraform", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, TF_PLUGIN_CACHE_DIR: PLUGIN_CACHE, TF_IN_AUTOMATION: "1", TF_INPUT: "0" },
  });
  if (r.status !== 0) throw new Error(`terraform ${args.join(" ")} failed in ${cwd}:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

function usesAws(dir: string): boolean {
  return listFiles(dir).some((f) => f.endsWith(".tf") && /resource\s+"aws_/.test(readFileSync(join(dir, f), "utf8")));
}

function prepare(src: string, dest: string, aws: boolean): void {
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
  if (aws) writeFileSync(join(dest, "zz_mock_provider_override.tf"), MOCK_OVERRIDE);
}

function placeholder(type: J, name: string, address: string): J {
  if (type === "string") return name === "arn" ? `arn:aws:mock:eu-west-1:123456789012:${address}` : `mock-${name}`;
  if (type === "number") return 0;
  if (type === "bool") return false;
  if (Array.isArray(type)) return type[0] === "list" || type[0] === "set" ? [] : {};
  return null;
}

function fillUnknown(value: J, unknown: J, block: J, address: string): J {
  if (unknown === true) return value ?? null;
  if (!unknown || typeof unknown !== "object" || Array.isArray(unknown)) return value;
  const obj: J = value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
  for (const [key, u] of Object.entries(unknown)) {
    const attr = block?.attributes?.[key];
    const nested = block?.block_types?.[key];
    if (u === true) obj[key] = attr ? placeholder(attr.type, key, address) : nested ? [] : `mock-${key}`;
    else if (Array.isArray(u)) {
      const cur = Array.isArray(obj[key]) ? obj[key] : [];
      obj[key] = cur.map((item: J, i: number) => fillUnknown(item, u[i] ?? null, nested?.block, address));
    } else if (u && typeof u === "object") obj[key] = fillUnknown(obj[key] ?? null, u, nested?.block, address);
  }
  return obj;
}

function stateFromPlan(plan: J, schema: J): J {
  const resources: J[] = [];
  for (const rc of plan.resource_changes ?? []) {
    if (rc.mode !== "managed") continue;
    const rs = schema.provider_schemas[rc.provider_name]?.resource_schemas[rc.type];
    if (!rs) throw new Error(`no schema for ${rc.provider_name} ${rc.type}`);
    const attrs = fillUnknown(rc.change.after, rc.change.after_unknown, rs.block, rc.address);
    if (attrs.id === null || attrs.id === undefined || attrs.id === "mock-id") attrs.id = `mock-${rc.address}`;
    let res = resources.find((r) => r.type === rc.type && r.name === rc.name && r.module === rc.module_address);
    if (!res) {
      res = {
        ...(rc.module_address && { module: rc.module_address }),
        mode: "managed",
        type: rc.type,
        name: rc.name,
        provider: `provider["${rc.provider_name}"]`,
        instances: [],
      };
      resources.push(res);
    }
    res.instances.push({
      ...(rc.index !== undefined && { index_key: rc.index }),
      schema_version: rs.version,
      attributes: attrs,
      sensitive_attributes: [],
    });
  }
  return {
    version: 4,
    terraform_version: plan.terraform_version,
    serial: 1,
    lineage: "00000000-0000-4000-8000-000000000002",
    outputs: {},
    resources,
    check_results: null,
  };
}

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === ".terraform" || name.startsWith("terraform.tfstate") || name.endsWith(".out")) continue;
    if (name === ".terraform.lock.hcl" || name.startsWith("zz_mock_")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, base));
    else out.push(relative(base, full));
  }
  return out.sort();
}

function prDiff(name: string, before: string, after: string): string {
  const tmp = join(WORK, name, "_diff");
  rmSync(tmp, { recursive: true, force: true });
  for (const [src, dest] of [
    [before, "a"],
    [after, "b"],
  ] as const) {
    for (const f of listFiles(src)) {
      mkdirSync(dirname(join(tmp, dest, f)), { recursive: true });
      cpSync(join(src, f), join(tmp, dest, f));
    }
  }
  const r = spawnSync("git", ["diff", "--no-index", "--no-color", "--unified=3", "--find-renames", "a", "b"], {
    cwd: tmp,
    encoding: "utf8",
  });
  if (r.status !== 0 && r.status !== 1) throw new Error(`git diff failed: ${r.stderr}`);
  return r.stdout
    .replace(/^diff --git a\/[ab]\/(\S+) b\/[ab]\/(\S+)$/gm, "diff --git a/$1 b/$2")
    .replace(/^--- a\/[ab]\//gm, "--- a/")
    .replace(/^\+\+\+ b\/[ab]\//gm, "+++ b/");
}

/** Keep what loadPlan reads; drop planned_values / prior_state (large, unused). */
function trim(plan: J): J {
  const keep = [
    "format_version",
    "terraform_version",
    "variables",
    "resource_changes",
    "resource_drift",
    "output_changes",
    "configuration",
    "errored",
  ];
  return Object.fromEntries(keep.filter((k) => k in plan).map((k) => [k, plan[k]]));
}

function generate(name: string): void {
  const scenario = join(HERE, name);
  const work = join(WORK, name);
  const aws = usesAws(join(scenario, "before")) || usesAws(join(scenario, "after"));
  const before = join(work, "before");
  const after = join(work, "after");
  prepare(join(scenario, "before"), before, aws);
  prepare(join(scenario, "after"), after, aws);
  const optionsPath = join(scenario, "scenario.json");
  const options = existsSync(optionsPath) ? JSON.parse(readFileSync(optionsPath, "utf8")) : {};

  tf(["init", "-input=false", "-no-color", "-backend=false"], before);
  if (aws) {
    tf(["plan", "-refresh=false", "-input=false", "-no-color", "-lock=false", "-out=before.out"], before);
    const beforePlan = JSON.parse(tf(["show", "-json", "before.out"], before));
    const schema = JSON.parse(tf(["providers", "schema", "-json"], before));
    writeFileSync(join(after, "terraform.tfstate"), JSON.stringify(stateFromPlan(beforePlan, schema), null, 2));
  } else {
    tf(["apply", "-auto-approve", "-input=false", "-no-color", "-lock=false"], before);
    cpSync(join(before, "terraform.tfstate"), join(after, "terraform.tfstate"));
  }
  const vars = Object.entries((options.afterVars ?? {}) as Record<string, string>).flatMap(([k, v]) => [
    "-var",
    `${k}=${v}`,
  ]);
  tf(["init", "-input=false", "-no-color", "-backend=false"], after);
  tf(["plan", "-refresh=false", "-input=false", "-no-color", "-lock=false", ...vars, "-out=after.out"], after);
  const plan = JSON.parse(tf(["show", "-json", "after.out"], after));
  writeFileSync(join(scenario, "plan.json"), JSON.stringify(trim(plan), null, 1) + "\n");
  writeFileSync(join(scenario, "pr.diff"), prDiff(name, join(scenario, "before"), join(scenario, "after")));
  const counts: Record<string, number> = {};
  for (const rc of plan.resource_changes ?? []) {
    const k = rc.change.actions.join("+");
    counts[k] = (counts[k] ?? 0) + 1;
  }
  console.log(`${name}: ${JSON.stringify(counts)}`);
}

const names = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(HERE).filter((n) => existsSync(join(HERE, n, "before")) && existsSync(join(HERE, n, "after")));
let failed = false;
for (const n of names) {
  try {
    generate(n);
  } catch (error) {
    failed = true;
    console.error(`${n}: ${(error as Error).message}`);
  }
}
if (failed) process.exitCode = 1;
