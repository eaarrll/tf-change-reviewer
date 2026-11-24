// End-to-end lineage on real plans: the db-encryption-replace eval fixture and the scenarios in
// test/fixtures/lineage (real terraform 1.10.5 plans from generate.mts, `after/` as the repository).
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizePath } from "../../src/git/diff.js";
import { loadPlan } from "../../src/plan/load.js";
import { createFsWorkspace } from "../../src/workspace.js";
import { traceChange } from "../../src/lineage/trace.js";
import type { Lineage, SourceLocation } from "../../src/types.js";
import {
  chain,
  changeOf,
  contextFor,
  cres,
  lineageFixture,
  memoryWorkspace,
  planJson,
  rc,
  rootCauses,
} from "./helpers.js";

const EVALS = new URL("../../evals/fixtures/", import.meta.url);

function evalFixture(name: string, diff: "pr" | "none" = "pr") {
  const dir = new URL(`${name}/`, EVALS);
  const plan = loadPlan(JSON.parse(readFileSync(new URL("plan.json", dir), "utf8")));
  const diffText = diff === "pr" ? readFileSync(new URL("pr.diff", dir), "utf8") : null;
  return contextFor(plan, createFsWorkspace(new URL("repo", dir).pathname, ""), diffText);
}

const covers = (loc: SourceLocation | undefined, file: string, line: number, side?: "base"): boolean =>
  loc !== undefined &&
  normalizePath(loc.file) === normalizePath(file) &&
  (loc.side ?? "head") === (side ?? "head") &&
  loc.startLine <= line &&
  line <= loc.endLine;

describe("db-encryption-replace (eval fixture)", () => {
  const RDS = "module.orders_db.aws_db_instance.this";

  it("traces the RDS replacement to the module argument and the new variable's default", async () => {
    const ctx = evalFixture("db-encryption-replace");
    const l = await traceChange(changeOf(ctx, RDS), ctx);
    expect(l.attribute).toEqual(["storage_encrypted"]);
    expect(chain(l)).toEqual([
      "resource_attribute aws_db_instance.this storage_encrypted @modules/db/main.tf:28-28",
      'module_input module "orders_db" argument encrypted @main.tf:12-12 *',
      'variable_default variable "orders_db_encrypted" default @main.tf:18-18 *',
    ]);
    expect(l.steps.map((s) => s.modulePath)).toEqual([["orders_db"], [], []]);
    expect(l.steps.map((s) => s.references)).toEqual([["var.encrypted"], ["var.orders_db_encrypted"], []]);
    expect(l.steps.map((s) => s.snippet)).toEqual([
      "storage_encrypted       = var.encrypted",
      "encrypted      = var.orders_db_encrypted",
      "default     = false",
    ]);
    // Most upstream first: the variable default (main.tf:18), then the module argument (main.tf:12).
    expect(l.rootCauseIds).toEqual(["s2", "s1"]);
    expect(l.explanation).toBe("diff");
    expect(l.notes).toEqual([]);
  });

  it("gives the same chain when the attribute is passed explicitly", async () => {
    const ctx = evalFixture("db-encryption-replace");
    const implicit = await traceChange(changeOf(ctx, RDS), ctx);
    const explicit = await traceChange(changeOf(ctx, RDS), ctx, ["storage_encrypted"]);
    expect(explicit).toEqual(implicit);
  });

  it("hits every labeled cause line", async () => {
    const ctx = evalFixture("db-encryption-replace");
    const labels = JSON.parse(readFileSync(new URL("db-encryption-replace/labels.json", EVALS), "utf8")) as {
      material: { address: string; cause: { file: string; line: number }[] }[];
    };
    for (const m of labels.material) {
      const l = await traceChange(changeOf(ctx, m.address), ctx);
      for (const c of m.cause) {
        expect(rootCauses(l).some((s) => covers(s.location, c.file, c.line))).toBe(true);
      }
    }
  });

  it("traces the log retention change to the child module's variable default", async () => {
    const ctx = evalFixture("db-encryption-replace");
    const l = await traceChange(
      changeOf(ctx, 'module.platform.aws_cloudwatch_log_group.service["audit"]'),
      ctx,
      ["retention_in_days"],
    );
    expect(chain(l)).toEqual([
      "resource_attribute aws_cloudwatch_log_group.service retention_in_days @modules/platform/main.tf:17-17",
      'variable_default variable "log_retention_days" default (module "platform" does not set it) @modules/platform/main.tf:11-11 *',
    ]);
    expect(l.explanation).toBe("diff");
  });

  it("traces tags_all to the provider's default_tags line the PR added", async () => {
    const ctx = evalFixture("db-encryption-replace");
    const l = await traceChange(changeOf(ctx, 'module.platform.aws_sqs_queue.events["audit"]'), ctx);
    expect(l.attribute).toEqual(["tags_all", "CostCenter"]);
    expect(chain(l)).toEqual([
      'provider_config provider "aws" default_tags CostCenter @providers.tf:17-17 *',
    ]);
    expect(l.steps[0]?.modulePath).toEqual([]);
  });

  it("never puts the database password in a lineage", async () => {
    const ctx = evalFixture("db-encryption-replace");
    const all: Lineage[] = [];
    for (const c of ctx.plan.changes) all.push(await traceChange(c, ctx), await traceChange(c, ctx, []));
    const text = JSON.stringify(all);
    expect(text).not.toContain("not-a-real-password-123");
    const password = await traceChange(changeOf(ctx, RDS), ctx, ["password"]);
    expect(password.steps[0]?.snippet).toBe('password                = "(sensitive)"');
  });

  it("without a diff, keeps the chain but explains nothing", async () => {
    const ctx = evalFixture("db-encryption-replace", "none");
    const l = await traceChange(changeOf(ctx, RDS), ctx);
    expect(l.steps).toHaveLength(3);
    expect(l.steps.every((s) => !s.changedInDiff)).toBe(true);
    expect(l.explanation).toBe("unknown");
    expect(l.notes).toEqual(["No PR diff was available, so the changed lines are unknown."]);
  });
});

describe("lineage scenarios (real plans)", () => {
  it("locals chain across files", async () => {
    const ctx = lineageFixture("locals-chain");
    const l = await traceChange(changeOf(ctx, "terraform_data.queue"), ctx);
    expect(chain(l)).toEqual([
      "resource_attribute terraform_data.queue triggers_replace @main.tf:7-7",
      "local local.name @main.tf:3-3",
      "local local.prefix @main.tf:2-2",
      'variable_default variable "env" default @variables.tf:3-3',
      "local local.region_short @locals.tf:2-2",
      'variable_default variable "region" default @variables.tf:8-8 *',
    ]);
    expect(l.rootCauseIds).toEqual(["s5"]);
  });

  it("module in module, with a sibling source (../store)", async () => {
    const ctx = lineageFixture("nested-module");
    const l = await traceChange(changeOf(ctx, "module.app.module.store.terraform_data.bucket"), ctx);
    expect(chain(l)).toEqual([
      "resource_attribute terraform_data.bucket triggers_replace @modules/store/main.tf:6-6",
      'module_input module "store" argument name @modules/app/main.tf:7-7 *',
      'module_input module "app" argument bucket_name @main.tf:8-8',
      'variable_default variable "bucket_name" default @main.tf:3-3',
    ]);
    expect(l.steps.map((s) => s.modulePath)).toEqual([["app", "store"], ["app"], [], []]);
    expect(l.rootCauseIds).toEqual(["s1"]);
  });

  it("module output feeding another module", async () => {
    const ctx = lineageFixture("module-output");
    const l = await traceChange(changeOf(ctx, "module.app.terraform_data.server"), ctx);
    expect(chain(l)).toEqual([
      "resource_attribute terraform_data.server triggers_replace @modules/app/main.tf:10-10",
      'module_input module "app" argument subnet @main.tf:7-7',
      'module_output module "net" output subnet_cidr @modules/net/main.tf:6-6',
      "local local.cidr @modules/net/main.tf:2-2 *",
    ]);
    expect(l.steps[3]?.modulePath).toEqual(["net"]);
    expect(l.explanation).toBe("diff");
  });

  it("tfvars precedence: the auto.tfvars value applies, the overridden terraform.tfvars edit does not", async () => {
    const ctx = lineageFixture("tfvars-precedence");
    const l = await traceChange(changeOf(ctx, "terraform_data.cluster"), ctx);
    expect(chain(l)).toEqual([
      "resource_attribute terraform_data.cluster triggers_replace @main.tf:11-11",
      'variable_default variable "instance_size" default @main.tf:3-3',
      "variable_value instance_size in terraform.tfvars @terraform.tfvars:1-1 *",
      "variable_value instance_size in prod.auto.tfvars @prod.auto.tfvars:2-2 *",
    ]);
    expect(rootCauses(l).map((s) => s.location?.file)).toEqual(["prod.auto.tfvars"]);
    expect(l.notes).toEqual([
      "terraform.tfvars:1 changes instance_size, but prod.auto.tfvars:2 sets the value that applies.",
    ]);
  });

  it("count re-index: replacements and the dropped last index trace to the tfvars list", async () => {
    const ctx = lineageFixture("count-reindex");
    for (const address of ["terraform_data.bucket[0]", "terraform_data.bucket[1]"]) {
      const l = await traceChange(changeOf(ctx, address), ctx);
      expect(chain(l)).toEqual([
        "resource_attribute terraform_data.bucket triggers_replace @main.tf:7-7",
        'variable_default variable "names" (no default) @main.tf:1-3',
        "variable_value names in terraform.tfvars @terraform.tfvars:1-1 *",
        "count_for_each terraform_data.bucket count @main.tf:6-6",
      ]);
      expect(rootCauses(l).map((s) => s.kind)).toEqual(["variable_value"]);
    }
    const del = await traceChange(changeOf(ctx, "terraform_data.bucket[2]"), ctx);
    expect(chain(del)).toEqual([
      'resource_block resource "terraform_data" "bucket" (instance [2] no longer exists) @main.tf:5-5',
      "count_for_each terraform_data.bucket count @main.tf:6-6",
      'variable_default variable "names" (no default) @main.tf:1-3',
      "variable_value names in terraform.tfvars @terraform.tfvars:1-1 *",
    ]);
    expect(del.explanation).toBe("diff");
  });

  it("for_each: a removed map key, and module instances added / removed through a local", async () => {
    const ctx = lineageFixture("for-each");
    const queue = await traceChange(changeOf(ctx, 'terraform_data.queue["refunds"]'), ctx);
    expect(chain(queue)).toEqual([
      'resource_block resource "terraform_data" "queue" (instance ["refunds"] no longer exists) @main.tf:12-12',
      "count_for_each terraform_data.queue for_each @main.tf:13-13",
      'variable_default variable "queues" (no default) @variables.tf:5-7',
      "variable_value queues in terraform.tfvars @terraform.tfvars:4-4 *",
    ]);
    const tail = [
      'count_for_each module "svc" for_each @main.tf:7-7',
      "local local.services @main.tf:2-2",
      'variable_default variable "base_services" (no default) @variables.tf:1-3',
      "variable_value base_services in terraform.tfvars @terraform.tfvars:1-1 *",
    ];
    const removed = await traceChange(changeOf(ctx, 'module.svc["legacy"].terraform_data.role'), ctx);
    expect(chain(removed)).toEqual([
      'resource_block resource "terraform_data" "role" (module instance module.svc["legacy"] no longer exists) @modules/svc/main.tf:5-5',
      ...tail,
    ]);
    const added = await traceChange(changeOf(ctx, 'module.svc["payouts"].terraform_data.role'), ctx);
    expect(chain(added)).toEqual([
      'resource_block resource "terraform_data" "role" @modules/svc/main.tf:5-5',
      ...tail,
    ]);
    expect(rootCauses(added).map((s) => s.location)).toEqual([
      { file: "terraform.tfvars", startLine: 1, endLine: 1 },
    ]);
  });

  it("upstream replacements: each resource's lineage continues into the one it reads", async () => {
    const ctx = lineageFixture("upstream");
    const l = await traceChange(changeOf(ctx, "terraform_data.dns"), ctx);
    expect(chain(l)).toEqual([
      "resource_attribute terraform_data.dns triggers_replace @main.tf:16-16",
      "upstream_resource terraform_data.server (replace) @main.tf:10-10",
      "resource_attribute terraform_data.server triggers_replace @main.tf:11-11",
      "upstream_resource terraform_data.network (replace) @main.tf:6-6",
      "resource_attribute terraform_data.network triggers_replace @main.tf:7-7",
      'variable_default variable "cidr" default @main.tf:3-3 *',
    ]);
    expect(l.steps.filter((s) => s.kind === "upstream_resource").map((s) => s.upstreamAddress)).toEqual([
      "terraform_data.server",
      "terraform_data.network",
    ]);
    expect(l.rootCauseIds).toEqual(["s5"]);
    expect(l.explanation).toBe("diff");
  });

  it("upstream replacements with no PR line on the path explain as upstream", async () => {
    const ctx = lineageFixture(
      "upstream",
      "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\n",
    );
    const l = await traceChange(changeOf(ctx, "terraform_data.server"), ctx);
    expect(l.rootCauseIds).toEqual([]);
    expect(l.explanation).toBe("upstream");
  });

  it("removed resource blocks point at the base side of the diff", async () => {
    const ctx = lineageFixture("removed-resource");
    const legacy = await traceChange(changeOf(ctx, "terraform_data.legacy"), ctx);
    expect(chain(legacy)).toEqual([
      'removed_code resource "terraform_data" "legacy" removed by this PR @main.tf:5-7(base) *',
    ]);
    expect(legacy.steps[0]?.snippet).toBe('resource "terraform_data" "legacy" {\n  input = "legacy"\n}');
    const archive = await traceChange(changeOf(ctx, "terraform_data.archive"), ctx);
    expect(chain(archive)).toEqual([
      'removed_code resource "terraform_data" "archive" removed by this PR @archive.tf:2-7(base) *',
    ]);
    expect(archive.explanation).toBe("diff");
  });

  it("removed module call: the resource's deleted block, then the removed call", async () => {
    const ctx = lineageFixture("removed-module");
    const bucket = await traceChange(changeOf(ctx, "module.old.terraform_data.bucket"), ctx);
    expect(chain(bucket)).toEqual([
      'removed_code resource "terraform_data" "bucket" (file removed by this PR) @modules/old/main.tf:5-7(base) *',
      'removed_code module "old" removed by this PR @main.tf:5-8(base) *',
    ]);
    expect(bucket.rootCauseIds).toEqual(["s1", "s0"]);
    const inner = await traceChange(changeOf(ctx, "module.old.module.inner.terraform_data.index"), ctx);
    expect(chain(inner)).toEqual(['removed_code module "old" removed by this PR @main.tf:5-8(base) *']);
  });

  it("values passed with -var explain as external", async () => {
    const ctx = lineageFixture("external-var");
    const update = await traceChange(changeOf(ctx, "terraform_data.node[0]"), ctx);
    expect(chain(update)).toEqual([
      "resource_attribute terraform_data.node input @main.tf:13-13",
      'variable_default variable "image" default @main.tf:8-8',
    ]);
    expect(update.explanation).toBe("external");
    expect(update.notes).toEqual([
      "The plan's value of var.image matches no default or .tfvars value in the repository: it was set outside the repo (-var, -var-file, TF_VAR_image or CI).",
    ]);
    const created = await traceChange(changeOf(ctx, "terraform_data.node[2]"), ctx);
    expect(chain(created)).toEqual([
      'resource_block resource "terraform_data" "node" @main.tf:11-11',
      "count_for_each terraform_data.node count @main.tf:12-12",
      'variable_default variable "replicas" default @main.tf:3-3',
    ]);
    expect(created.explanation).toBe("external");
    // The unrelated change in the same PR is still explained by its own line.
    const notes = await traceChange(changeOf(ctx, "terraform_data.notes"), ctx);
    expect(notes.explanation).toBe("diff");
  });
});

describe("nested blocks (hand-written plan, real tree)", () => {
  // The AWS provider cannot run in every environment, so this plan is written by hand in the shape
  // terraform 1.10 prints for aws_security_group: ingress is a set, so the planned order differs
  // from the source order and from the prior order.
  const rule = (description: string, port: number, cidrs: string[]) => ({
    cidr_blocks: cidrs,
    description,
    from_port: port,
    ipv6_cidr_blocks: [],
    prefix_list_ids: [],
    protocol: "tcp",
    security_groups: [],
    self: false,
    to_port: port,
  });
  const before = {
    name: "billing-db",
    ingress: [
      rule("app subnets", 5432, ["10.40.0.0/16"]),
      rule("https", 443, ["10.0.0.0/8"]),
      rule("office", 5432, ["203.0.113.0/24"]),
    ],
  };
  const after = {
    name: "billing-db",
    ingress: [
      rule("https", 443, ["0.0.0.0/0"]),
      rule("office", 5432, ["0.0.0.0/0"]),
      rule("app subnets", 5432, ["10.40.0.0/16"]),
    ],
  };
  const plan = loadPlan(
    planJson({
      rootModule: {
        resources: [
          cres("aws_security_group.db", {
            name: { constant_value: "billing-db" },
            ingress: [
              {
                cidr_blocks: { constant_value: ["10.40.0.0/16"] },
                description: { constant_value: "app subnets" },
              },
              {
                cidr_blocks: { references: ["var.office_cidrs"] },
                description: { constant_value: "office" },
              },
            ],
          }),
        ],
        variables: { office_cidrs: { default: ["0.0.0.0/0"] }, extra_rules: { default: {} } },
      },
      changes: [rc("aws_security_group.db", ["update"], { before, after })],
      variables: {
        office_cidrs: ["0.0.0.0/0"],
        extra_rules: { https: { port: 443, cidrs: ["0.0.0.0/0"] } },
      },
    }),
  );
  const dir = new URL("../fixtures/lineage/nested-block/", import.meta.url);
  const ctx = contextFor(
    plan,
    createFsWorkspace(new URL("after", dir).pathname, ""),
    readFileSync(new URL("pr.diff", dir), "utf8"),
  );

  it("finds the static block holding the planned element", async () => {
    const l = await traceChange(changeOf(ctx, "aws_security_group.db"), ctx, ["ingress", 1, "cidr_blocks"]);
    expect(chain(l)).toEqual([
      'resource_attribute aws_security_group.db ingress "office" cidr_blocks @main.tf:30-30',
      'variable_default variable "office_cidrs" default @main.tf:3-3 *',
    ]);
  });

  it("finds the dynamic block generating an element and follows its for_each", async () => {
    const l = await traceChange(changeOf(ctx, "aws_security_group.db"), ctx, ["ingress", 0, "cidr_blocks"]);
    expect(chain(l)).toEqual([
      'resource_attribute aws_security_group.db ingress "https" cidr_blocks @main.tf:40-40',
      'count_for_each dynamic "ingress" for_each @main.tf:34-34',
      'variable_default variable "extra_rules" default @main.tf:9-9 *',
    ]);
    expect(l.steps[0]?.references).toEqual(["ingress.value.cidrs", "ingress.value"]);
    expect(l.explanation).toBe("diff");
  });

  it("traces the changed set elements by default", async () => {
    const l = await traceChange(changeOf(ctx, "aws_security_group.db"), ctx);
    const causes = rootCauses(l).map((s) => s.location?.startLine);
    expect(causes).toEqual(expect.arrayContaining([3, 9]));
    expect(l.explanation).toBe("diff");
  });
});

describe("labeled eval fixtures: a root cause covers a labeled cause line", () => {
  // Fixtures other engineers maintain; skipped when absent. Each labeled material change with cause
  // lines must have a root-cause step on one of them (the eval's trace-accuracy criterion).
  const names = [
    "db-encryption-replace",
    "s3-count-reindex",
    "sg-open-world",
    "iam-wildcard",
    "module-removed",
    "renamed-without-moved",
  ];
  for (const name of names) {
    const present = existsSync(new URL(`${name}/labels.json`, EVALS));
    it.skipIf(!present)(name, async () => {
      const ctx = evalFixture(name);
      const labels = JSON.parse(readFileSync(new URL(`${name}/labels.json`, EVALS), "utf8")) as {
        material: { address: string; cause?: { file: string; line: number; side?: "base" }[] }[];
      };
      for (const m of labels.material) {
        if (!m.cause?.length) continue;
        const change = ctx.plan.changes.find((c) => c.address === m.address);
        if (!change) continue;
        const l = await traceChange(change, ctx);
        const hit = rootCauses(l).some((s) =>
          m.cause!.some((c) => covers(s.location, c.file, c.line, c.side)),
        );
        expect(hit, `${m.address}: ${JSON.stringify(chain(l))}`).toBe(true);
      }
    });
  }
});

describe("tfvars driven by a sensitive or unreadable value", () => {
  it("does not claim external when a tfvars value cannot be evaluated", async () => {
    const files = {
      "main.tf": 'variable "doc" {}\nresource "terraform_data" "x" {\n  input = var.doc\n}\n',
      "terraform.tfvars": 'doc = <<EOT\n${"$"}{not literal}\nEOT\n',
    };
    const p = loadPlan(
      planJson({
        rootModule: {
          resources: [cres("terraform_data.x", { input: { references: ["var.doc"] } })],
          variables: { doc: {} },
        },
        changes: [rc("terraform_data.x", ["update"], { before: { input: "a" }, after: { input: "b" } })],
        variables: { doc: "b" },
      }),
    );
    const c = contextFor(p, memoryWorkspace(files), "");
    const l = await traceChange(changeOf(c, "terraform_data.x"), c);
    expect(l.explanation).toBe("unknown");
    expect(l.notes.join(" ")).not.toContain("outside the repo");
  });
});
