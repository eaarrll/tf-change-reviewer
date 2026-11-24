// Tracer behaviour on small in-memory repositories and hand-written plans in the shape
// `terraform show -json` prints. End-to-end runs on real plans are in trace-fixtures.test.ts.
import { describe, expect, it } from "vitest";
import { emptyDiff } from "../../src/git/diff.js";
import { loadPlan } from "../../src/plan/load.js";
import { looseEqual, parsePatches, reconstructBase, traceChange } from "../../src/lineage/trace.js";
import type { TraceContext } from "../../src/lineage/trace.js";
import { chain, changeOf, contextFor, cres, memoryWorkspace, planJson, rc, rootCauses } from "./helpers.js";

/** A unified diff replacing whole lines of one file: [line, old, new]; old/new null = pure add/remove. */
function diffOf(file: string, edits: [number, string | null, string | null][]): string {
  const out = [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`];
  for (const [line, oldText, newText] of edits) {
    const oldCount = oldText === null ? 0 : 1;
    const newCount = newText === null ? 0 : 1;
    out.push(`@@ -${oldCount ? line : line - 1},${oldCount} +${newCount ? line : line - 1},${newCount} @@`);
    if (oldText !== null) out.push(`-${oldText}`);
    if (newText !== null) out.push(`+${newText}`);
  }
  return out.join("\n") + "\n";
}

describe("parsePatches / reconstructBase", () => {
  const diff = [
    "diff --git a/main.tf b/main.tf",
    "index 1..2 100644",
    "--- a/main.tf",
    "+++ b/main.tf",
    "@@ -1,3 +1,2 @@",
    " a",
    "-b",
    " c",
    "@@ -6,2 +5,3 @@ ctx",
    " f",
    "-g",
    "+G",
    "+H",
    "\\ No newline at end of file",
    "diff --git a/old.tf b/old.tf",
    "deleted file mode 100644",
    "--- a/old.tf",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-x",
    "-y",
    "diff --git a/from.tf b/to.tf",
    "similarity index 90%",
    "rename from from.tf",
    "rename to to.tf",
    "diff --git a/new.tf b/new.tf",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/new.tf",
    "@@ -0,0 +1 @@",
    "+n",
    'diff --git "a/sp ace.tf" "b/sp ace.tf"',
    '--- "a/sp ace.tf"',
    '+++ "b/sp ace.tf"',
    "@@ -1 +1 @@",
    "-q",
    "+r",
  ].join("\n");

  it("parses files, renames, deletions and quoted paths with old-side removed lines", () => {
    const patches = parsePatches(diff);
    expect(patches.map((p) => [p.oldPath, p.newPath, [...p.removed]])).toEqual([
      ["main.tf", "main.tf", [2, 7]],
      ["old.tf", null, [1, 2]],
      ["from.tf", "to.tf", []],
      [null, "new.tf", []],
      ["sp ace.tf", "sp ace.tf", [1]],
    ]);
  });

  it("rebuilds the base file from the head and the hunks", () => {
    const [main, old] = parsePatches(diff);
    // head: a c d e f G H  (base: a b c d e f g)
    expect(reconstructBase(main!, "a\nc\nd\ne\nf\nG\nH")).toBe("a\nb\nc\nd\ne\nf\ng");
    expect(reconstructBase(old!, null)).toBe("x\ny");
  });

  it("falls back to the hunks' old side when the head does not match the diff", () => {
    const [main] = parsePatches(diff);
    // Unknown base lines (4, 5) come back empty; known ones keep their numbers.
    expect(reconstructBase(main!, "totally\ndifferent").split("\n")).toEqual([
      "a",
      "b",
      "c",
      "",
      "",
      "f",
      "g",
    ]);
    expect(reconstructBase(main!, null).split("\n")[6]).toBe("g");
  });

  it("never throws on garbage", () => {
    expect(() => parsePatches("@@ -x +y @@\n+++\n---\n\0")).not.toThrow();
    expect(parsePatches("")).toEqual([]);
  });
});

describe("looseEqual", () => {
  it("compares repo literals with typed plan values", () => {
    expect(looseEqual("3", 3)).toBe(true);
    expect(looseEqual(3, "3")).toBe(true);
    expect(looseEqual("true", true)).toBe(true);
    expect(looseEqual({ a: 1 }, { a: 1, b: null })).toBe(true);
    expect(looseEqual(["b", "a"], ["a", "b"])).toBe(true);
    expect(looseEqual({ a: { port: "443" } }, { a: { port: 443, extra: null } })).toBe(true);
  });

  it("detects real differences", () => {
    expect(looseEqual("3", 4)).toBe(false);
    expect(looseEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(looseEqual(["a"], ["a", "b"])).toBe(false);
    expect(looseEqual({ a: 1 }, [1])).toBe(false);
    expect(looseEqual(null, "x")).toBe(false);
  });
});

describe("traceChange: data sources", () => {
  const main = [
    "locals {", // 1
    '  bucket_arn = "arn:aws:s3:::${var.bucket}"', // 2
    "}", // 3
    "", // 4
    'data "aws_iam_policy_document" "p" {', // 5
    "  statement {", // 6
    '    actions   = ["s3:*"]', // 7
    "    resources = [local.bucket_arn]", // 8
    "  }", // 9
    "}", // 10
    "", // 11
    'resource "aws_iam_policy" "p" {', // 12
    "  policy = data.aws_iam_policy_document.p.json", // 13
    "}", // 14
    'variable "bucket" {', // 15
    '  default = "reports"', // 16
    "}", // 17
  ].join("\n");
  const plan = loadPlan(
    planJson({
      rootModule: {
        resources: [
          cres("aws_iam_policy.p", { policy: { references: ["data.aws_iam_policy_document.p.json"] } }),
          cres("data.aws_iam_policy_document.p"),
        ],
        variables: { bucket: { default: "reports" } },
      },
      changes: [rc("aws_iam_policy.p", ["update"], { before: { policy: "{a}" }, after: { policy: "{b}" } })],
      variables: { bucket: "reports" },
    }),
  );

  it("points at the data source and the arguments the PR changed", async () => {
    const ctx = contextFor(
      plan,
      memoryWorkspace({ "main.tf": main }),
      diffOf("main.tf", [[7, '    actions   = ["s3:Get*"]', '    actions   = ["s3:*"]']]),
    );
    const l = await traceChange(changeOf(ctx, "aws_iam_policy.p"), ctx);
    // Only the touched argument is followed: the diff already explains the change.
    expect(chain(l)).toEqual([
      "resource_attribute aws_iam_policy.p policy @main.tf:13-13",
      "upstream_resource data.aws_iam_policy_document.p @main.tf:7-7 *",
      "resource_attribute data.aws_iam_policy_document.p statement.actions @main.tf:7-7 *",
    ]);
    expect(l.rootCauseIds).toEqual(["s2", "s1"]);
    expect(l.explanation).toBe("diff");
  });

  it("follows every argument's references when the PR does not touch the data source", async () => {
    const ctx = contextFor(
      plan,
      memoryWorkspace({ "main.tf": main }),
      diffOf("main.tf", [[16, '  default = "old"', '  default = "reports"']]),
    );
    const l = await traceChange(changeOf(ctx, "aws_iam_policy.p"), ctx);
    expect(chain(l)).toEqual([
      "resource_attribute aws_iam_policy.p policy @main.tf:13-13",
      "upstream_resource data.aws_iam_policy_document.p @main.tf:5-10",
      "local local.bucket_arn @main.tf:2-2",
      'variable_default variable "bucket" default @main.tf:16-16 *',
    ]);
    expect(rootCauses(l).map((s) => s.label)).toEqual(['variable "bucket" default']);
  });
});

describe("traceChange: remote modules", () => {
  const rootTf = [
    'module "vpc" {', // 1
    '  source  = "terraform-aws-modules/vpc/aws"', // 2
    '  version = "5.2.0"', // 3
    "  cidr    = var.cidr", // 4
    "}", // 5
    'variable "cidr" {', // 6
    '  default = "10.0.0.0/16"', // 7
    "}", // 8
  ].join("\n");
  const plan = loadPlan(
    planJson({
      rootModule: {
        module_calls: {
          vpc: {
            source: "terraform-aws-modules/vpc/aws",
            version: "5.2.0",
            expressions: { cidr: { references: ["var.cidr"] } },
            module: {
              resources: [cres("aws_vpc.this", { cidr_block: { references: ["var.cidr"] } })],
              variables: { cidr: {} },
            },
          },
        },
        variables: { cidr: { default: "10.0.0.0/16" } },
      },
      changes: [
        rc("module.vpc.aws_vpc.this", ["update"], {
          before: { enable_dns_hostnames: false, cidr_block: "10.0.0.0/16" },
          after: { enable_dns_hostnames: true, cidr_block: "10.0.0.0/16" },
        }),
      ],
      variables: { cidr: "10.0.0.0/16" },
    }),
  );
  const bump = diffOf("main.tf", [[3, '  version = "5.1.0"', '  version = "5.2.0"']]);

  it("stops at the module call and blames its version bump when the module is not in the repo", async () => {
    const ctx = contextFor(plan, memoryWorkspace({ "main.tf": rootTf }), bump);
    const l = await traceChange(changeOf(ctx, "module.vpc.aws_vpc.this"), ctx);
    expect(chain(l)).toEqual([
      'module_source module "vpc" version @main.tf:3-3 *',
      'module_source module "vpc" source @main.tf:2-2',
      'unresolved module "vpc" comes from "terraform-aws-modules/vpc/aws" outside the repository',
    ]);
    expect(l.explanation).toBe("diff");
    expect(rootCauses(l).map((s) => s.label)).toEqual(['module "vpc" version']);
    expect(l.notes.join(" ")).toContain("modules.json");
  });

  it("traces into the module through modules.json, then falls back to the version bump", async () => {
    const files = {
      "main.tf": rootTf,
      ".terraform/modules/modules.json": JSON.stringify({
        Modules: [
          {
            Key: "vpc",
            Source: "registry.terraform.io/terraform-aws-modules/vpc/aws",
            Dir: ".terraform/modules/vpc",
          },
        ],
      }),
      ".terraform/modules/vpc/main.tf":
        'variable "cidr" {}\nresource "aws_vpc" "this" {\n  cidr_block           = var.cidr\n  enable_dns_hostnames = true\n}\n',
    };
    const ctx = contextFor(plan, memoryWorkspace(files), bump);
    const l = await traceChange(changeOf(ctx, "module.vpc.aws_vpc.this"), ctx);
    expect(chain(l)).toEqual([
      "resource_attribute aws_vpc.this enable_dns_hostnames @.terraform/modules/vpc/main.tf:4-4",
      'module_source module "vpc" version @main.tf:3-3 *',
    ]);
    expect(l.explanation).toBe("diff");
  });
});

describe("traceChange: external explanations", () => {
  const main = 'resource "aws_s3_bucket" "b" {\n  bucket = "logs"\n  tags   = { Team = "a" }\n}\n';
  const config = { resources: [cres("aws_s3_bucket.b", { bucket: { constant_value: "logs" }, tags: {} })] };

  it("blames drift when Terraform reverts a change made outside it", async () => {
    const plan = loadPlan(
      planJson({
        rootModule: config,
        changes: [
          rc("aws_s3_bucket.b", ["update"], {
            before: { tags: { Team: "b" } },
            after: { tags: { Team: "a" } },
          }),
        ],
        drift: [
          rc("aws_s3_bucket.b", ["update"], {
            before: { tags: { Team: "a" } },
            after: { tags: { Team: "b" } },
          }),
        ],
      }),
    );
    const ctx = contextFor(
      plan,
      memoryWorkspace({ "main.tf": main }),
      diffOf("other.tf", [[1, null, "# x"]]),
    );
    const l = await traceChange(changeOf(ctx, "aws_s3_bucket.b"), ctx);
    expect(l.explanation).toBe("external");
    expect(l.rootCauseIds).toEqual([]);
    expect(l.notes.join(" ")).toContain("drift");
    expect(chain(l)).toEqual(["resource_attribute aws_s3_bucket.b tags.Team @main.tf:3-3"]);
  });

  it("explains tainted objects and -replace requests as external", async () => {
    for (const reason of ["replace_because_tainted", "replace_by_request"]) {
      const plan = loadPlan(
        planJson({ rootModule: config, changes: [rc("aws_s3_bucket.b", ["delete", "create"], { reason })] }),
      );
      const ctx = contextFor(plan, memoryWorkspace({ "main.tf": main }), "");
      const l = await traceChange(changeOf(ctx, "aws_s3_bucket.b"), ctx);
      expect(l.explanation).toBe("external");
      expect(chain(l)).toEqual(['resource_block resource "aws_s3_bucket" "b" @main.tf:1-1']);
      expect(l.notes[0]).toMatch(/tainted|-replace/);
    }
  });

  it("does not claim an outside value for sensitive variables", async () => {
    const plan = loadPlan(
      planJson({
        rootModule: {
          resources: [cres("aws_s3_bucket.b", { bucket: { references: ["var.name"] } })],
          variables: { name: { default: "a", sensitive: true } },
        },
        changes: [
          rc("aws_s3_bucket.b", ["delete", "create"], {
            before: { bucket: "a" },
            after: { bucket: "zz" },
            replacePaths: [["bucket"]],
          }),
        ],
        variables: { name: "zz" },
      }),
    );
    const files = {
      "main.tf":
        'resource "aws_s3_bucket" "b" {\n  bucket = var.name\n}\nvariable "name" {\n  sensitive = true\n  default   = "a"\n}\n',
    };
    const ctx = contextFor(plan, memoryWorkspace(files), "");
    const l = await traceChange(changeOf(ctx, "aws_s3_bucket.b"), ctx);
    expect(l.explanation).toBe("unknown");
    expect(l.notes.join(" ")).not.toContain("outside the repo");
    expect(JSON.stringify(l)).not.toContain('"zz"');
    expect(l.steps[1]?.snippet).toBe("default = (sensitive)");
  });

  it("does not claim an outside value when the plan's value was redacted", async () => {
    const token = ["ghp", "_", "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0FeDcBa98"].join("");
    const plan = loadPlan(
      planJson({
        rootModule: {
          resources: [cres("aws_ssm_parameter.p", { value: { references: ["var.note"] } })],
          variables: { note: {} },
        },
        changes: [rc("aws_ssm_parameter.p", ["update"], { before: { value: "a" }, after: { value: "b" } })],
        variables: { note: `prefix ${token}` },
      }),
    );
    expect(JSON.stringify(plan.variables)).not.toContain(token);
    const files = {
      "main.tf": 'variable "note" {}\nresource "aws_ssm_parameter" "p" {\n  value = var.note\n}\n',
      "terraform.tfvars": `note = "prefix ${token}"\n`,
    };
    const ctx = contextFor(plan, memoryWorkspace(files), "");
    const l = await traceChange(changeOf(ctx, "aws_ssm_parameter.p"), ctx);
    expect(l.notes.join(" ")).not.toContain("outside the repo");
    expect(JSON.stringify(l)).not.toContain(token);
  });

  it("explains a resource whose configuration vanished before this PR as external", async () => {
    const plan = loadPlan(
      planJson({
        rootModule: {},
        changes: [rc("aws_s3_bucket.gone", ["delete"], { reason: "delete_because_no_resource_config" })],
      }),
    );
    const ctx = contextFor(
      plan,
      memoryWorkspace({ "main.tf": "" }),
      diffOf("main.tf", [[1, null, "# unrelated"]]),
    );
    const l = await traceChange(changeOf(ctx, "aws_s3_bucket.gone"), ctx);
    expect(l.explanation).toBe("external");
    expect(l.steps).toEqual([]);
  });
});

describe("traceChange: module repetition", () => {
  it("follows each.value in a module argument to the module call's for_each", async () => {
    const files = {
      "main.tf": [
        'module "svc" {', // 1
        '  source   = "./svc"', // 2
        "  for_each = var.services", // 3
        "  port     = each.value.port", // 4
        "}", // 5
        'variable "services" {}', // 6
      ].join("\n"),
      "terraform.tfvars": "services = {\n  api = { port = 8443 }\n}\n",
      "svc/main.tf": 'variable "port" {}\nresource "aws_lb_listener" "l" {\n  port = var.port\n}\n',
    };
    const plan = loadPlan(
      planJson({
        rootModule: {
          module_calls: {
            svc: {
              source: "./svc",
              for_each_expression: { references: ["var.services"] },
              expressions: { port: { references: ["each.value.port", "each.value"] } },
              module: { resources: [cres("aws_lb_listener.l", { port: { references: ["var.port"] } })] },
            },
          },
          variables: { services: {} },
        },
        changes: [
          rc('module.svc["api"].aws_lb_listener.l', ["update"], {
            before: { port: 443 },
            after: { port: 8443 },
          }),
        ],
        variables: { services: { api: { port: 8443 } } },
      }),
    );
    const ctx = contextFor(
      plan,
      memoryWorkspace(files),
      diffOf("terraform.tfvars", [[2, "  api = { port = 443 }", "  api = { port = 8443 }"]]),
    );
    const l = await traceChange(changeOf(ctx, 'module.svc["api"].aws_lb_listener.l'), ctx);
    expect(chain(l)).toEqual([
      "resource_attribute aws_lb_listener.l port @svc/main.tf:3-3",
      'module_input module "svc" argument port @main.tf:4-4',
      'count_for_each module "svc" for_each @main.tf:3-3',
      'variable_default variable "services" (no default) @main.tf:6-6',
      "variable_value services in terraform.tfvars @terraform.tfvars:2-2 *",
    ]);
    expect(l.explanation).toBe("diff");
  });
});

describe("traceChange: nested module for_each over an upstream resource", () => {
  it("looks the upstream up in the caller's module instance and follows its configured change", async () => {
    const files = {
      "main.tf": 'module "app" {\n  source = "./app"\n}\n',
      "app/main.tf": [
        'resource "terraform_data" "cfg" {', // 1
        '  input = ["a", "b"]', // 2
        "}", // 3
        'module "svc" {', // 4
        '  source   = "./svc"', // 5
        "  for_each = toset(terraform_data.cfg.output)", // 6
        "}", // 7
      ].join("\n"),
      "app/svc/main.tf": 'resource "terraform_data" "role" {\n  input = "x"\n}\n',
    };
    const plan = loadPlan(
      planJson({
        rootModule: {
          module_calls: {
            app: {
              source: "./app",
              module: {
                resources: [cres("terraform_data.cfg", { input: { constant_value: ["a", "b"] } })],
                module_calls: {
                  svc: {
                    source: "./svc",
                    for_each_expression: { references: ["terraform_data.cfg.output", "terraform_data.cfg"] },
                    module: { resources: [cres("terraform_data.role", { input: { constant_value: "x" } })] },
                  },
                },
              },
            },
          },
        },
        changes: [
          rc("module.app.terraform_data.cfg", ["update"], {
            before: { input: ["a"], output: ["a"] },
            after: { input: ["a", "b"] },
            afterUnknown: { output: true },
            provider: "terraform.io/builtin/terraform",
          }),
          rc('module.app.module.svc["b"].terraform_data.role', ["create"], {
            provider: "terraform.io/builtin/terraform",
          }),
        ],
      }),
    );
    const ctx = contextFor(
      plan,
      memoryWorkspace(files),
      diffOf("app/main.tf", [[2, '  input = ["a"]', '  input = ["a", "b"]']]),
    );
    const l = await traceChange(changeOf(ctx, 'module.app.module.svc["b"].terraform_data.role'), ctx);
    expect(chain(l)).toEqual([
      'resource_block resource "terraform_data" "role" @app/svc/main.tf:1-1',
      'count_for_each module "svc" for_each @app/main.tf:6-6',
      "upstream_resource module.app.terraform_data.cfg (update) @app/main.tf:1-1",
      "resource_attribute terraform_data.cfg input @app/main.tf:2-2 *",
    ]);
    expect(l.steps[2]?.upstreamAddress).toBe("module.app.terraform_data.cfg");
    expect(l.explanation).toBe("diff");
  });
});

describe("traceChange: removed attributes, lifecycle triggers, forget and move", () => {
  it("points at an attribute the PR deleted (the provider default applies)", async () => {
    const head = 'resource "aws_db_instance" "db" {\n  engine = "postgres"\n}\n';
    const diff = [
      "diff --git a/db.tf b/db.tf",
      "--- a/db.tf",
      "+++ b/db.tf",
      "@@ -1,4 +1,3 @@",
      ' resource "aws_db_instance" "db" {',
      '   engine = "postgres"',
      "-  storage_encrypted = true",
      " }",
    ].join("\n");
    const plan = loadPlan(
      planJson({
        rootModule: { resources: [cres("aws_db_instance.db", { engine: { constant_value: "postgres" } })] },
        changes: [
          rc("aws_db_instance.db", ["delete", "create"], {
            before: { storage_encrypted: true },
            after: { storage_encrypted: false },
            replacePaths: [["storage_encrypted"]],
          }),
        ],
      }),
    );
    const ctx = contextFor(plan, memoryWorkspace({ "db.tf": head }), diff);
    const l = await traceChange(changeOf(ctx, "aws_db_instance.db"), ctx);
    expect(chain(l)).toEqual([
      "removed_code aws_db_instance.db storage_encrypted removed by this PR @db.tf:3-3(base) *",
    ]);
    expect(l.steps[0]?.snippet).toBe("storage_encrypted = true");
    expect(l.explanation).toBe("diff");
  });

  it("notes computed attributes that no line of code sets", async () => {
    const plan = loadPlan(
      planJson({
        rootModule: { resources: [cres("aws_instance.a", { ami: { constant_value: "ami-1" } })] },
        changes: [
          rc("aws_instance.a", ["update"], { before: { private_dns: "a" }, after: { private_dns: "b" } }),
        ],
      }),
    );
    const ctx = contextFor(
      plan,
      memoryWorkspace({ "main.tf": 'resource "aws_instance" "a" {\n  ami = "ami-1"\n}\n' }),
      "",
    );
    const l = await traceChange(changeOf(ctx, "aws_instance.a"), ctx);
    expect(chain(l)).toEqual(['resource_block resource "aws_instance" "a" @main.tf:1-1']);
    expect(l.notes[0]).toContain("provider computes or defaults it");
  });

  it("follows lifecycle.replace_triggered_by for replace_by_triggers", async () => {
    const main = [
      'resource "terraform_data" "rev" {', // 1
      "  input = var.rev", // 2
      "}", // 3
      'resource "aws_instance" "a" {', // 4
      "  lifecycle {", // 5
      "    replace_triggered_by = [terraform_data.rev]", // 6
      "  }", // 7
      "}", // 8
      'variable "rev" {', // 9
      "  default = 2", // 10
      "}", // 11
    ].join("\n");
    const plan = loadPlan(
      planJson({
        rootModule: {
          resources: [
            cres("terraform_data.rev", { input: { references: ["var.rev"] } }),
            cres("aws_instance.a"),
          ],
          variables: { rev: { default: 2 } },
        },
        changes: [
          rc("terraform_data.rev", ["update"], {
            before: { input: 1 },
            after: { input: 2 },
            provider: "terraform.io/builtin/terraform",
          }),
          rc("aws_instance.a", ["delete", "create"], { reason: "replace_by_triggers" }),
        ],
        variables: { rev: 2 },
      }),
    );
    const ctx = contextFor(
      plan,
      memoryWorkspace({ "main.tf": main }),
      diffOf("main.tf", [[10, "  default = 1", "  default = 2"]]),
    );
    const l = await traceChange(changeOf(ctx, "aws_instance.a"), ctx);
    expect(chain(l)).toEqual([
      "resource_attribute aws_instance.a lifecycle.replace_triggered_by @main.tf:6-6",
      "upstream_resource terraform_data.rev (update) @main.tf:1-1",
      "resource_attribute terraform_data.rev input @main.tf:2-2",
      'variable_default variable "rev" default @main.tf:10-10 *',
    ]);
    expect(l.explanation).toBe("diff");
  });

  it("points a forget at its removed block and a move at its moved block", async () => {
    const main =
      "removed {\n  from = aws_s3_bucket.a\n  lifecycle {\n    destroy = false\n  }\n}\nmoved {\n  from = aws_s3_bucket.x\n  to   = aws_s3_bucket.y\n}\n";
    const plan = loadPlan(
      planJson({
        changes: [
          rc("aws_s3_bucket.a", ["forget"]),
          { ...rc("aws_s3_bucket.y", ["no-op"]), previous_address: "aws_s3_bucket.x" },
        ],
      }),
    );
    const ctx = contextFor(
      plan,
      memoryWorkspace({ "main.tf": main }),
      diffOf("main.tf", [[2, null, "  from = aws_s3_bucket.a"]]),
    );
    expect(chain(await traceChange(changeOf(ctx, "aws_s3_bucket.a"), ctx))).toEqual([
      "resource_block removed block for aws_s3_bucket.a @main.tf:2-2 *",
    ]);
    expect(chain(await traceChange(changeOf(ctx, "aws_s3_bucket.y"), ctx))).toEqual([
      "resource_block moved block for aws_s3_bucket.y @main.tf:7-10",
    ]);
  });
});

describe("traceChange: robustness", () => {
  const loopFiles = {
    "main.tf":
      'locals {\n  a = local.b\n  b = local.a\n}\nresource "terraform_data" "x" {\n  input = local.a\n}\n',
  };
  const loopPlan = loadPlan(
    planJson({
      rootModule: { resources: [cres("terraform_data.x", { input: { references: ["local.a"] } })] },
      changes: [rc("terraform_data.x", ["update"], { before: { input: 1 }, after: { input: 2 } })],
    }),
  );

  it("terminates on reference cycles", async () => {
    const ctx = contextFor(loopPlan, memoryWorkspace(loopFiles), "");
    const l = await traceChange(changeOf(ctx, "terraform_data.x"), ctx);
    expect(chain(l)).toEqual([
      "resource_attribute terraform_data.x input @main.tf:6-6",
      "local local.a @main.tf:2-2",
      "local local.b @main.tf:3-3",
    ]);
  });

  it("stops at maxDepth hops with a note", async () => {
    const locals = Array.from({ length: 20 }, (_, i) => `  l${i} = local.l${i + 1}`).join("\n");
    const files = {
      "main.tf": `locals {\n${locals}\n  l20 = 1\n}\nresource "terraform_data" "x" {\n  input = local.l0\n}\n`,
    };
    const plan = loadPlan(
      planJson({
        rootModule: { resources: [cres("terraform_data.x", { input: { references: ["local.l0"] } })] },
        changes: [rc("terraform_data.x", ["update"], { before: { input: 1 }, after: { input: 2 } })],
      }),
    );
    const ctx = contextFor(plan, memoryWorkspace(files), "", { maxDepth: 5 });
    const l = await traceChange(changeOf(ctx, "terraform_data.x"), ctx);
    expect(l.steps).toHaveLength(6);
    expect(l.notes).toContain("Tracing stopped after 5 reference hops.");
  });

  it("terminates when two changing resources reference each other", async () => {
    const files = {
      "main.tf":
        'resource "terraform_data" "a" {\n  input = terraform_data.b.id\n}\nresource "terraform_data" "b" {\n  input = terraform_data.a.id\n}\n',
    };
    const plan = loadPlan(
      planJson({
        rootModule: {
          resources: [
            cres("terraform_data.a", { input: { references: ["terraform_data.b.id", "terraform_data.b"] } }),
            cres("terraform_data.b", { input: { references: ["terraform_data.a.id", "terraform_data.a"] } }),
          ],
        },
        changes: [
          rc("terraform_data.a", ["delete", "create"], { replacePaths: [["input"]] }),
          rc("terraform_data.b", ["delete", "create"], { replacePaths: [["input"]] }),
        ],
      }),
    );
    const ctx = contextFor(plan, memoryWorkspace(files), "");
    const l = await traceChange(changeOf(ctx, "terraform_data.a"), ctx);
    expect(chain(l)).toEqual([
      "resource_attribute terraform_data.a input @main.tf:2-2",
      "upstream_resource terraform_data.b (replace) @main.tf:4-4",
      "resource_attribute terraform_data.b input @main.tf:5-5",
    ]);
    expect(l.explanation).toBe("upstream");
  });

  it("says so when no diff is available", async () => {
    const ctx: TraceContext = {
      ...contextFor(loopPlan, memoryWorkspace(loopFiles), null),
      diff: emptyDiff(),
    };
    const l = await traceChange(changeOf(ctx, "terraform_data.x"), ctx);
    expect(l.explanation).toBe("unknown");
    expect(l.notes).toContain("No PR diff was available, so the changed lines are unknown.");
  });

  it("never throws, and redacts secrets from internal error notes", async () => {
    const key = ["AKIA", "Z7QX3VN5LM2K8PRT"].join("");
    const ctx = contextFor(loopPlan, memoryWorkspace(loopFiles), "");
    const broken = {
      ...ctx,
      plan: new Proxy(ctx.plan, {
        get() {
          throw new Error(`boom ${key}`);
        },
      }),
    };
    const l = await traceChange(changeOf(ctx, "terraform_data.x"), broken);
    expect(l).toMatchObject({
      address: "terraform_data.x",
      steps: [],
      rootCauseIds: [],
      explanation: "unknown",
    });
    expect(l.notes[0]).toContain("internal error");
    expect(l.notes[0]).not.toContain(key);
  });

  it("returns an anchor-only lineage for a resource whose block is missing", async () => {
    const ctx = contextFor(loopPlan, memoryWorkspace({}), "");
    const l = await traceChange(changeOf(ctx, "terraform_data.x"), ctx, []);
    expect(l.steps).toEqual([]);
    expect(l.notes[0]).toContain("terraform_data.x was not found");
  });
});

describe("traceChange: tree, own-index references and several attributes at once", () => {
  it("follows x[count.index] to the instance with the same index only", async () => {
    const files = {
      "main.tf": [
        'resource "terraform_data" "b" {',
        "  count = 3",
        '  input = "v2-${count.index}"',
        "}",
        'resource "terraform_data" "v" {',
        "  count = 3",
        "  input = terraform_data.b[count.index].id",
        "}",
      ].join("\n"),
    };
    const plan = loadPlan(
      planJson({
        rootModule: {
          resources: [
            cres("terraform_data.b", { input: {} }, { count_expression: { constant_value: 3 } }),
            cres(
              "terraform_data.v",
              { input: { references: ["terraform_data.b", "count.index"] } },
              { count_expression: { constant_value: 3 } },
            ),
          ],
        },
        changes: [0, 1, 2].flatMap((i) => [
          rc(`terraform_data.b[${i}]`, ["delete", "create"], { replacePaths: [["input"]] }),
          rc(`terraform_data.v[${i}]`, ["delete", "create"], { replacePaths: [["input"]] }),
        ]),
      }),
    );
    const ctx = contextFor(
      plan,
      memoryWorkspace(files),
      diffOf("main.tf", [[3, '  input = "v1"', '  input = "v2-${count.index}"']]),
    );
    const l = await traceChange(changeOf(ctx, "terraform_data.v[1]"), ctx);
    const ups = l.steps.filter((s) => s.kind === "upstream_resource").map((s) => s.upstreamAddress);
    expect(ups).toEqual(["terraform_data.b[1]"]);
    expect(l.notes.join(" ")).not.toMatch(/were traced/);
    // Parent links: every step but the traced attribute points one level up.
    expect(l.steps[0]?.parentId).toBeUndefined();
    for (const s of l.steps.slice(1)) expect(l.steps.some((p) => p.id === s.parentId)).toBe(true);
  });

  it("traces several attributes of one change side by side, each with its own path", async () => {
    const files = {
      "main.tf": [
        'resource "aws_db_instance" "d" {',
        "  deletion_protection = var.protect",
        "  skip_final_snapshot = var.skip",
        "}",
        'variable "protect" {',
        "  default = false",
        "}",
        'variable "skip" {',
        "  default = true",
        "}",
      ].join("\n"),
    };
    const plan = loadPlan(
      planJson({
        rootModule: {
          resources: [
            cres("aws_db_instance.d", {
              deletion_protection: { references: ["var.protect"] },
              skip_final_snapshot: { references: ["var.skip"] },
            }),
          ],
        },
        changes: [
          rc("aws_db_instance.d", ["update"], {
            before: { deletion_protection: true, skip_final_snapshot: false },
            after: { deletion_protection: false, skip_final_snapshot: true },
          }),
        ],
      }),
    );
    const diff = diffOf("main.tf", [
      [6, "  default = true", "  default = false"],
      [9, "  default = false", "  default = true"],
    ]);
    const ctx = contextFor(plan, memoryWorkspace(files), diff);
    const l = await traceChange(changeOf(ctx, "aws_db_instance.d"), ctx, [
      ["deletion_protection"],
      ["skip_final_snapshot"],
    ]);
    expect(l.attribute).toEqual(["deletion_protection"]);
    expect(l.steps.filter((s) => s.parentId === undefined).map((s) => s.path)).toEqual([
      ["deletion_protection"],
      ["skip_final_snapshot"],
    ]);
    expect(
      rootCauses(l)
        .map((s) => s.location?.startLine)
        .sort(),
    ).toEqual([6, 9]);
  });
});
