// Lineage regressions found by probing real-provider plans: var files, deleted assignments, realigned
// module lines, for_each module instances, shared variables, nested block elements, sensitive module
// inputs, plans without a configuration section and deposed objects.
import { describe, expect, it } from "vitest";
import { causePaths } from "../../src/lineage/chain.js";
import { traceChange } from "../../src/lineage/trace.js";
import { loadPlan } from "../../src/plan/load.js";
import { SENSITIVE_PLACEHOLDER } from "../../src/types.js";
import { chain, changeOf, contextFor, cres, memoryWorkspace, planJson, rc, rootCauses } from "./helpers.js";

/** A unified diff of one file from explicit hunks: [oldStart, newStart, lines (" x", "-x", "+x")]. */
function patch(file: string, hunks: [number, number, string[]][]): string {
  const out = [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`];
  for (const [oldStart, newStart, lines] of hunks) {
    const oldCount = lines.filter((l) => !l.startsWith("+")).length;
    const newCount = lines.filter((l) => !l.startsWith("-")).length;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...lines);
  }
  return out.join("\n") + "\n";
}

const bucketTf = (variable: string, def: string, sensitive = false): string =>
  [
    `variable "${variable}" {`, // 1
    `  default = "${def}"`, // 2
    ...(sensitive ? ["  sensitive = true"] : []),
    "}",
    'resource "aws_s3_bucket" "data" {',
    `  bucket = var.${variable}`,
    "}",
  ].join("\n");

function bucketPlan(variable: string, def: string, value: unknown, sensitive = false) {
  return loadPlan(
    planJson({
      rootModule: {
        resources: [cres("aws_s3_bucket.data", { bucket: { references: [`var.${variable}`] } })],
        variables: { [variable]: { default: def, ...(sensitive && { sensitive: true }) } },
      },
      changes: [
        rc("aws_s3_bucket.data", ["delete", "create"], {
          before: { bucket: "old" },
          after: { bucket: value },
          replacePaths: [["bucket"]],
        }),
      ],
      variables: { [variable]: value },
    }),
  );
}

describe("root variables set in var files", () => {
  it("links a value from a var file the PR changes (-var-file=envs/prod.tfvars), not an injected value", async () => {
    const plan = bucketPlan("suffix", "billing", "ledger");
    const files = { "main.tf": bucketTf("suffix", "billing"), "envs/prod.tfvars": 'suffix = "ledger"\n' };
    const diff = patch("envs/prod.tfvars", [[1, 1, ['-suffix = "billing"', '+suffix = "ledger"']]]);
    const ctx = contextFor(plan, memoryWorkspace(files), diff);
    const l = await traceChange(changeOf(ctx, "aws_s3_bucket.data"), ctx);
    expect(l.explanation).toBe("diff");
    expect(rootCauses(l).map((s) => `${s.kind} ${s.location?.file}:${s.location?.startLine}`)).toEqual([
      "variable_value envs/prod.tfvars:1",
    ]);
    expect(l.notes.join(" ")).not.toMatch(/matches no default or \.tfvars value/);
  });

  it("still calls a value no file in the repo holds injected", async () => {
    const plan = bucketPlan("suffix", "billing", "ledger");
    const files = { "main.tf": bucketTf("suffix", "billing"), "envs/prod.tfvars": 'suffix = "other"\n' };
    const diff = patch("envs/prod.tfvars", [[1, 1, ['-suffix = "billing"', '+suffix = "other"']]]);
    const ctx = contextFor(plan, memoryWorkspace(files), diff);
    const l = await traceChange(changeOf(ctx, "aws_s3_bucket.data"), ctx);
    expect(l.explanation).toBe("external");
    expect(l.notes.join(" ")).toMatch(/matches no default or \.tfvars value/);
  });

  it("finds an unchanged var file in the root directory: in the repo, so not injected", async () => {
    const plan = bucketPlan("suffix", "billing", "ledger");
    const files = { "main.tf": bucketTf("suffix", "billing"), "prod.tfvars": 'suffix = "ledger"\n' };
    const ctx = contextFor(plan, memoryWorkspace(files), patch("other.txt", [[1, 1, ["-a", "+b"]]]));
    const l = await traceChange(changeOf(ctx, "aws_s3_bucket.data"), ctx);
    expect(l.explanation).toBe("unknown");
    expect(chain(l)).toContain(
      "variable_value suffix in prod.tfvars (loaded with -var-file) @prod.tfvars:1-1",
    );
  });
});

describe("assignments the PR deletes", () => {
  it("blames a tfvars assignment the PR removed when the default now applies", async () => {
    const plan = bucketPlan("bucket_name", "acme-legacy-data", "acme-legacy-data");
    const files = {
      "main.tf": bucketTf("bucket_name", "acme-legacy-data"),
      "terraform.tfvars": 'region = "eu-west-1"\n',
    };
    const diff = patch("terraform.tfvars", [
      [1, 1, [' region = "eu-west-1"', '-bucket_name = "acme-prod-data"']],
    ]);
    const ctx = contextFor(plan, memoryWorkspace(files), diff);
    const l = await traceChange(changeOf(ctx, "aws_s3_bucket.data"), ctx);
    expect(l.explanation).toBe("diff");
    expect(chain(l)).toContain(
      "removed_code bucket_name in terraform.tfvars removed by this PR @terraform.tfvars:2-2(base) *",
    );
    expect(rootCauses(l).map((s) => s.kind)).toEqual(["removed_code"]);
  });

  it("does not show the removed value of a sensitive variable", async () => {
    const plan = bucketPlan("bucket_name", "acme-legacy-data", "acme-legacy-data", true);
    const files = { "main.tf": bucketTf("bucket_name", "acme-legacy-data", true), "terraform.tfvars": "" };
    const diff = patch("terraform.tfvars", [[1, 0, ['-bucket_name = "hunter2-prod"']]]);
    const ctx = contextFor(plan, memoryWorkspace(files), diff);
    const l = await traceChange(changeOf(ctx, "aws_s3_bucket.data"), ctx);
    const removed = l.steps.find((s) => s.kind === "removed_code");
    expect(removed?.snippet).toBe(`bucket_name = ${SENSITIVE_PLACEHOLDER}`);
    expect(JSON.stringify(l)).not.toContain("hunter2");
  });

  const storeModule = [
    'variable "bucket_name" {', // 1
    '  default = "acme-legacy-data"', // 2
    "}", // 3
    'resource "aws_s3_bucket" "this" {', // 4
    "  bucket = var.bucket_name", // 5
    "}", // 6
  ].join("\n");
  const storePlan = (sensitive = false) =>
    loadPlan(
      planJson({
        rootModule: {
          module_calls: {
            store: {
              source: "./modules/store",
              module: {
                resources: [cres("aws_s3_bucket.this", { bucket: { references: ["var.bucket_name"] } })],
                variables: {
                  bucket_name: { default: "acme-legacy-data", ...(sensitive && { sensitive: true }) },
                },
              },
            },
          },
        },
        changes: [
          rc("module.store.aws_s3_bucket.this", ["delete", "create"], {
            before: { bucket: "acme-prod-data" },
            after: { bucket: "acme-legacy-data" },
            replacePaths: [["bucket"]],
          }),
        ],
      }),
    );
  // The removal realigns `source      =` to `source =` (terraform fmt).
  const removeArg = patch("main.tf", [
    [
      1,
      1,
      [
        ' module "store" {',
        '-  source      = "./modules/store"',
        '-  bucket_name = "acme-prod-data"',
        '+  source = "./modules/store"',
        " }",
      ],
    ],
  ]);
  const storeFiles = {
    "main.tf": 'module "store" {\n  source = "./modules/store"\n}\n',
    "modules/store/main.tf": storeModule,
  };

  it("blames a module argument the PR removed, not the realigned source line", async () => {
    const ctx = contextFor(storePlan(), memoryWorkspace(storeFiles), removeArg);
    const l = await traceChange(changeOf(ctx, "module.store.aws_s3_bucket.this"), ctx);
    expect(l.explanation).toBe("diff");
    expect(rootCauses(l).map((s) => `${s.kind} ${s.label}`)).toEqual([
      'removed_code module "store" argument bucket_name removed by this PR',
    ]);
    expect(rootCauses(l)[0]?.location).toEqual({ file: "main.tf", startLine: 3, endLine: 3, side: "base" });
    expect(l.steps.some((s) => s.kind === "module_source")).toBe(false);
  });

  it("masks the removed module argument of a sensitive child variable", async () => {
    const ctx = contextFor(storePlan(true), memoryWorkspace(storeFiles), removeArg);
    const l = await traceChange(changeOf(ctx, "module.store.aws_s3_bucket.this"), ctx);
    const removed = l.steps.find((s) => s.kind === "removed_code");
    expect(removed?.snippet).toBe(`bucket_name = ${SENSITIVE_PLACEHOLDER}`);
  });

  it("never blames a local module's realigned source line as a version change", async () => {
    // Only the source line is reformatted; nothing on the path changes.
    const realign = patch("main.tf", [
      [
        1,
        1,
        [' module "store" {', '-  source      = "./modules/store"', '+  source = "./modules/store"', " }"],
      ],
    ]);
    const ctx = contextFor(storePlan(), memoryWorkspace(storeFiles), realign);
    const l = await traceChange(changeOf(ctx, "module.store.aws_s3_bucket.this"), ctx);
    expect(l.steps.some((s) => s.kind === "module_source")).toBe(false);
    expect(l.explanation).toBe("unknown");
  });

  // The call now points at another directory whose default differs.
  const movedPlan = (source: string) =>
    loadPlan(
      planJson({
        rootModule: {
          module_calls: {
            store: {
              source,
              module: {
                resources: [cres("aws_s3_bucket.this", { bucket: { references: ["var.bucket_name"] } })],
                variables: { bucket_name: { default: "acme-legacy-data" } },
              },
            },
          },
        },
        changes: [
          rc("module.store.aws_s3_bucket.this", ["delete", "create"], {
            before: { bucket: "acme-prod-data" },
            after: { bucket: "acme-legacy-data" },
            replacePaths: [["bucket"]],
          }),
        ],
      }),
    );
  const movedFiles = {
    "main.tf": 'module "store" {\n  source = "./modules/store2"\n}\n',
    "modules/store/main.tf": storeModule.replace("acme-legacy-data", "acme-prod-data"),
    "modules/store2/main.tf": storeModule,
  };

  it("links a changed local module source as a code change, not a version bump", async () => {
    const diff = patch("main.tf", [
      [1, 1, [' module "store" {', '-  source = "./modules/store"', '+  source = "./modules/store2"', " }"]],
    ]);
    const ctx = contextFor(movedPlan("./modules/store2"), memoryWorkspace(movedFiles), diff);
    const l = await traceChange(changeOf(ctx, "module.store.aws_s3_bucket.this"), ctx);
    expect(l.explanation).toBe("diff");
    expect(
      rootCauses(l).map((s) => `${s.kind} ${s.label} ${s.location?.file}:${s.location?.startLine}`),
    ).toEqual(['module_input module "store" source main.tf:2']);
    expect(l.steps.some((s) => s.kind === "module_source")).toBe(false);
  });

  it("links a switch from a registry module to a local path as a code change", async () => {
    const diff = patch("main.tf", [
      [
        1,
        1,
        [
          ' module "store" {',
          '-  source  = "acme/store/aws"',
          '-  version = "1.2.0"',
          '+  source = "./modules/store2"',
          " }",
        ],
      ],
    ]);
    const ctx = contextFor(movedPlan("./modules/store2"), memoryWorkspace(movedFiles), diff);
    const l = await traceChange(changeOf(ctx, "module.store.aws_s3_bucket.this"), ctx);
    expect(l.explanation).toBe("diff");
    expect(rootCauses(l).map((s) => `${s.kind} ${s.label}`)).toEqual(['module_input module "store" source']);
  });
});

describe("module call source lines", () => {
  const webModule = [
    'variable "public_ssh" {', // 1
    "  default = false", // 2
    "}", // 3
    'resource "aws_vpc_security_group_ingress_rule" "ssh" {', // 4
    "  count       = var.public_ssh ? 1 : 0", // 5
    '  cidr_ipv4   = "0.0.0.0/0"', // 6
    "}", // 7
  ].join("\n");
  const plan = loadPlan(
    planJson({
      rootModule: {
        module_calls: {
          web: {
            source: "./modules/web",
            expressions: { public_ssh: { constant_value: true } },
            module: {
              resources: [
                cres(
                  "aws_vpc_security_group_ingress_rule.ssh",
                  { cidr_ipv4: { constant_value: "0.0.0.0/0" } },
                  { count_expression: { references: ["var.public_ssh"] } },
                ),
              ],
              variables: { public_ssh: { default: false } },
            },
          },
        },
      },
      changes: [rc("module.web.aws_vpc_security_group_ingress_rule.ssh[0]", ["create"])],
    }),
  );
  const head = 'module "web" {\n  source     = "./modules/web"\n  public_ssh = true\n}\n';

  it("does not list a source line that terraform fmt realigned as a cause of the module's creates", async () => {
    const diff = patch("main.tf", [
      [
        1,
        1,
        [
          ' module "web" {',
          '-  source = "./modules/web"',
          '+  source     = "./modules/web"',
          "+  public_ssh = true",
          " }",
        ],
      ],
    ]);
    const files = { "main.tf": head, "modules/web/main.tf": webModule };
    const ctx = contextFor(plan, memoryWorkspace(files), diff);
    const l = await traceChange(changeOf(ctx, "module.web.aws_vpc_security_group_ingress_rule.ssh[0]"), ctx);
    expect(l.steps.some((s) => s.kind === "module_source")).toBe(false);
    expect(rootCauses(l).map((s) => `${s.kind} ${s.location?.file}:${s.location?.startLine}`)).toEqual([
      "module_input main.tf:3",
    ]);
  });

  it("still explains everything inside a module call the PR adds by its source line", async () => {
    const diff = patch("main.tf", [
      [
        0,
        1,
        head
          .trimEnd()
          .split("\n")
          .map((l) => `+${l}`),
      ],
    ]).replace("--- a/main.tf", "new file mode 100644\n--- /dev/null");
    const files = { "main.tf": head, "modules/web/main.tf": webModule };
    const ctx = contextFor(plan, memoryWorkspace(files), diff);
    const l = await traceChange(changeOf(ctx, "module.web.aws_vpc_security_group_ingress_rule.ssh[0]"), ctx);
    expect(chain(l)).toContain('module_input module "web" source @main.tf:2-2 *');
  });
});

describe("for_each module calls", () => {
  it("resolves each.key in a module argument to the module instance's own key", async () => {
    const files = {
      "main.tf": [
        'variable "cidrs" {}', // 1
        'resource "aws_subnet" "s" {', // 2
        "  for_each   = var.cidrs", // 3
        "  cidr_block = each.value", // 4
        "}", // 5
        'module "svc" {', // 6
        '  source    = "./svc"', // 7
        "  for_each  = var.cidrs", // 8
        "  subnet_id = aws_subnet.s[each.key].id", // 9
        "}", // 10
      ].join("\n"),
      "svc/main.tf":
        'variable "subnet_id" {}\nresource "aws_network_interface" "this" {\n  subnet_id = var.subnet_id\n}\n',
    };
    const plan = loadPlan(
      planJson({
        rootModule: {
          resources: [
            cres(
              "aws_subnet.s",
              { cidr_block: { references: ["each.value"] } },
              { for_each_expression: { references: ["var.cidrs"] } },
            ),
          ],
          module_calls: {
            svc: {
              source: "./svc",
              for_each_expression: { references: ["var.cidrs"] },
              expressions: { subnet_id: { references: ["aws_subnet.s[each.key].id", "aws_subnet.s"] } },
              module: {
                resources: [
                  cres("aws_network_interface.this", { subnet_id: { references: ["var.subnet_id"] } }),
                ],
                variables: { subnet_id: {} },
              },
            },
          },
          variables: { cidrs: {} },
        },
        changes: ["a", "b"].flatMap((k) => [
          rc(`aws_subnet.s["${k}"]`, ["delete", "create"], {
            before: { cidr_block: "10.0.1.0/24" },
            after: { cidr_block: "10.0.2.0/24" },
            replacePaths: [["cidr_block"]],
          }),
          rc(`module.svc["${k}"].aws_network_interface.this`, ["delete", "create"], {
            before: { subnet_id: "subnet-1" },
            after: { subnet_id: "x" },
            afterUnknown: { subnet_id: true },
            replacePaths: [["subnet_id"]],
          }),
        ]),
        variables: { cidrs: { a: "10.0.2.0/24", b: "10.0.2.0/24" } },
      }),
    );
    const ctx = contextFor(plan, memoryWorkspace(files), null);
    const l = await traceChange(changeOf(ctx, 'module.svc["b"].aws_network_interface.this'), ctx);
    const upstream = l.steps.filter((s) => s.kind === "upstream_resource").map((s) => s.upstreamAddress);
    expect(upstream).toEqual(['aws_subnet.s["b"]']);
  });
});

describe("a variable or local shared by several traced attributes", () => {
  it("gives every attribute its own branch down to the shared root cause", async () => {
    const files = {
      "main.tf": [
        'variable "ephemeral" {}', // 1
        "locals {", // 2
        "  keep = !var.ephemeral", // 3
        "}", // 4
        'resource "aws_db_instance" "orders" {', // 5
        "  skip_final_snapshot     = var.ephemeral", // 6
        "  deletion_protection     = local.keep", // 7
        "  backup_retention_period = local.keep ? 14 : 0", // 8
        "}", // 9
      ].join("\n"),
      "terraform.tfvars": "ephemeral = true\n",
    };
    const plan = loadPlan(
      planJson({
        rootModule: {
          resources: [
            cres("aws_db_instance.orders", {
              skip_final_snapshot: { references: ["var.ephemeral"] },
              deletion_protection: { references: ["local.keep"] },
              backup_retention_period: { references: ["local.keep"] },
            }),
          ],
          variables: { ephemeral: {} },
        },
        changes: [
          rc("aws_db_instance.orders", ["update"], {
            before: { skip_final_snapshot: false, deletion_protection: true, backup_retention_period: 14 },
            after: { skip_final_snapshot: true, deletion_protection: false, backup_retention_period: 0 },
          }),
        ],
        variables: { ephemeral: true },
      }),
    );
    const diff = patch("terraform.tfvars", [[1, 1, ["-ephemeral = false", "+ephemeral = true"]]]);
    const ctx = contextFor(plan, memoryWorkspace(files), diff);
    const l = await traceChange(changeOf(ctx, "aws_db_instance.orders"), ctx, [
      ["backup_retention_period"],
      ["deletion_protection"],
      ["skip_final_snapshot"],
    ]);
    const paths = causePaths(l, 10).map((p) => p.map((s) => s.location?.startLine).join("<"));
    expect(paths).toEqual(["8<3<1", "7<3<1", "6<1"]);
    // Every traced attribute's branch ends at the changed tfvars line.
    for (const p of causePaths(l, 10)) expect(p.at(-1)?.location?.file).toBe("terraform.tfvars");
  });
});

describe("nested block elements added to or removed from a set", () => {
  const sg = (blocks: string[]): string =>
    ['resource "aws_security_group" "db" {', ...blocks, "}"].join("\n");
  const pg = ["  ingress {", '    description = "postgres"', '    cidr_blocks = ["10.0.0.0/16"]', "  }"];
  const ssh = ["  ingress {", '    description = "ssh"', '    cidr_blocks = ["0.0.0.0/0"]', "  }"];
  const rule = (description: string, cidr: string) => ({ description, cidr_blocks: [cidr] });
  const planOf = (before: unknown[], after: unknown[]) =>
    loadPlan(
      planJson({
        rootModule: { resources: [cres("aws_security_group.db")] },
        changes: [
          rc("aws_security_group.db", ["update"], { before: { ingress: before }, after: { ingress: after } }),
        ],
      }),
    );

  it("traces a block added ahead of an existing one (set order) to the added block", async () => {
    const plan = planOf(
      [rule("postgres", "10.0.0.0/16")],
      [rule("ssh", "0.0.0.0/0"), rule("postgres", "10.0.0.0/16")],
    );
    const c = plan.changes[0]!;
    // The existing rule is not paired with the new one.
    expect(c.changedPaths).toEqual([["ingress", 0]]);
    const diff = patch("main.tf", [[5, 5, ["   }", ...ssh.map((l) => `+${l}`), " }"]]]);
    const ctx = contextFor(plan, memoryWorkspace({ "main.tf": sg([...pg, ...ssh]) }), diff);
    const l = await traceChange(changeOf(ctx, "aws_security_group.db"), ctx);
    expect(chain(l)).toEqual(['resource_attribute aws_security_group.db ingress "ssh" @main.tf:6-9 *']);
    expect(l.explanation).toBe("diff");
  });

  it("points a removed block at the base side, not at a block still in the code", async () => {
    const plan = planOf(
      [rule("postgres", "10.0.0.0/16"), rule("ssh", "0.0.0.0/0")],
      [rule("postgres", "10.0.0.0/16")],
    );
    const diff = patch("main.tf", [[5, 5, ["   }", ...ssh.map((l) => `-${l}`), " }"]]]);
    const ctx = contextFor(plan, memoryWorkspace({ "main.tf": sg(pg) }), diff);
    const l = await traceChange(changeOf(ctx, "aws_security_group.db"), ctx);
    expect(chain(l)).toEqual([
      'removed_code aws_security_group.db ingress "ssh" removed by this PR @main.tf:6-9(base) *',
    ]);
  });
});

describe("plans without a configuration section", () => {
  it("finds a deleted count instance's resource in the repository instead of calling it removed earlier", async () => {
    const json = planJson({
      changes: [1, 2].map((i) => rc(`terraform_data.gone[${i}]`, ["delete"], { before: { input: "x" } })),
    });
    delete (json as { configuration?: unknown }).configuration;
    const plan = loadPlan(json);
    const files = { "main.tf": 'resource "terraform_data" "gone" {\n  count = 1\n  input = "x"\n}\n' };
    const diff = patch("main.tf", [
      [1, 1, [' resource "terraform_data" "gone" {', "-  count = 3", "+  count = 1"]],
    ]);
    const ctx = contextFor(plan, memoryWorkspace(files), diff);
    const l = await traceChange(changeOf(ctx, "terraform_data.gone[1]"), ctx);
    expect(l.explanation).toBe("diff");
    expect(rootCauses(l).map((s) => s.label)).toEqual(["terraform_data.gone count"]);
    expect(l.notes.join(" ")).not.toMatch(/removed before this PR/);
  });
});

describe("deposed objects", () => {
  it("are leftovers of an earlier replacement, not the PR's count change", async () => {
    const plan = loadPlan(
      planJson({
        rootModule: {
          resources: [cres("terraform_data.gone", {}, { count_expression: { constant_value: 1 } })],
        },
        changes: [
          { ...rc("terraform_data.gone[0]", ["delete"], { before: { input: "x" } }), deposed: "00cc22dd" },
          {
            ...rc("terraform_data.gone[1]", ["delete"], { before: { input: "x" } }),
            action_reason: "delete_because_count_index",
          },
        ],
      }),
    );
    const files = { "main.tf": 'resource "terraform_data" "gone" {\n  count = 1\n}\n' };
    const diff = patch("main.tf", [
      [1, 1, [' resource "terraform_data" "gone" {', "-  count = 2", "+  count = 1"]],
    ]);
    const ctx = contextFor(plan, memoryWorkspace(files), diff);
    const deposed = plan.changes.find((c) => c.deposed === "00cc22dd")!;
    const l = await traceChange(deposed, ctx);
    expect(l.explanation).toBe("external");
    expect(l.steps).toEqual([]);
    expect(l.deposed).toBe("00cc22dd");
    expect(l.notes.join(" ")).toMatch(/deposed 00cc22dd\) is a leftover object/);
    // The live instance the PR's count change drops is still traced to it.
    const live = await traceChange(changeOf(ctx, "terraform_data.gone[1]"), ctx);
    expect(live.explanation).toBe("diff");
  });
});

describe("remote module version lines", () => {
  const rootTf = (pad: string): string =>
    `module "vpc" {\n  source ${pad}= "terraform-aws-modules/vpc/aws"\n  version ${pad.slice(1)}= "5.2.0"\n}\n`;
  const plan = loadPlan(
    planJson({
      rootModule: {
        module_calls: {
          vpc: {
            source: "terraform-aws-modules/vpc/aws",
            version: "5.2.0",
            module: { resources: [cres("aws_vpc.this")] },
          },
        },
      },
      changes: [
        rc("module.vpc.aws_vpc.this", ["update"], {
          before: { enable_dns_hostnames: false },
          after: { enable_dns_hostnames: true },
        }),
      ],
    }),
  );

  it("counts a version line as changed only when its value changes", async () => {
    const realign = patch("main.tf", [
      [
        1,
        1,
        [
          ' module "vpc" {',
          '-  source = "terraform-aws-modules/vpc/aws"',
          '-  version = "5.2.0"',
          '+  source  = "terraform-aws-modules/vpc/aws"',
          '+  version = "5.2.0"',
          " }",
        ],
      ],
    ]);
    const ctx = contextFor(plan, memoryWorkspace({ "main.tf": rootTf("  ") }), realign);
    const l = await traceChange(changeOf(ctx, "module.vpc.aws_vpc.this"), ctx);
    expect(l.steps.filter((s) => s.kind === "module_source").map((s) => s.changedInDiff)).toEqual([
      false,
      false,
    ]);
    expect(l.explanation).not.toBe("diff");

    const bump = patch("main.tf", [[3, 3, ['-  version = "5.1.0"', '+  version = "5.2.0"']]]);
    const ctx2 = contextFor(plan, memoryWorkspace({ "main.tf": rootTf("  ") }), bump);
    const l2 = await traceChange(changeOf(ctx2, "module.vpc.aws_vpc.this"), ctx2);
    expect(rootCauses(l2).map((s) => s.label)).toEqual(['module "vpc" version']);
  });
});

describe("integration follow-ups", () => {
  it("names a label-only module rename instead of a deleted call", async () => {
    const plan = loadPlan(
      planJson({
        rootModule: {
          module_calls: {
            storage: { source: "./modules/bucket", module: { resources: [cres("aws_s3_bucket.this")] } },
          },
        },
        changes: [
          rc("module.store.aws_s3_bucket.this", ["delete"], { reason: "delete_because_no_module" }),
          rc("module.storage.aws_s3_bucket.this", ["create"]),
        ],
      }),
    );
    const files = {
      "main.tf": 'module "storage" {\n  source = "./modules/bucket"\n  name   = "data"\n}\n',
      "modules/bucket/main.tf": 'resource "aws_s3_bucket" "this" {}\n',
    };
    const diff = patch("main.tf", [
      [
        1,
        1,
        ['-module "store" {', '+module "storage" {', '   source = "./modules/bucket"', '   name   = "data"'],
      ],
    ]);
    const ctx = contextFor(plan, memoryWorkspace(files), diff);
    const l = await traceChange(changeOf(ctx, "module.store.aws_s3_bucket.this"), ctx);
    expect(l.explanation).toBe("diff");
    expect(l.steps[0]?.label).toBe('renames module "store" to "storage" without a moved block');
    expect(l.steps[0]?.location).toMatchObject({ file: "main.tf", startLine: 1, endLine: 1, side: "base" });
    expect(l.steps[1]?.label).toBe('module "storage" (the new name)');
  });

  it("traces an OpenTofu enabled=false delete to the enabled argument", async () => {
    const plan = loadPlan(
      planJson({
        rootModule: {
          resources: [cres("aws_s3_bucket.logs")],
          variables: { logs_enabled: { default: false } },
        },
        changes: [rc("aws_s3_bucket.logs", ["delete"], { reason: "delete_because_enabled_false" })],
      }),
    );
    const files = {
      "main.tf": [
        'variable "logs_enabled" {', // 1
        "  default = false", // 2
        "}", // 3
        'resource "aws_s3_bucket" "logs" {', // 4
        "  lifecycle {", // 5
        "    enabled = var.logs_enabled", // 6
        "  }", // 7
        "}", // 8
      ].join("\n"),
    };
    const diff = patch("main.tf", [
      [1, 1, [' variable "logs_enabled" {', "-  default = true", "+  default = false"]],
    ]);
    const ctx = contextFor(plan, memoryWorkspace(files), diff);
    const l = await traceChange(changeOf(ctx, "aws_s3_bucket.logs"), ctx);
    expect(l.steps[0]?.label).toContain("(enabled = false)");
    expect(l.steps.some((s) => s.label === "aws_s3_bucket.logs enabled" && s.location?.startLine === 6)).toBe(
      true,
    );
    expect(rootCauses(l).map((s) => s.location?.startLine)).toEqual([2]);
  });

  it("does not trace deletes of a destroy plan to code", async () => {
    const plan = loadPlan(
      planJson({
        rootModule: {
          resources: [cres("aws_s3_bucket.data", {}, { count_expression: { constant_value: 2 } })],
        },
        changes: [rc("aws_s3_bucket.data[0]", ["delete"]), rc("aws_s3_bucket.data[1]", ["delete"])],
      }),
    );
    const files = { "main.tf": 'resource "aws_s3_bucket" "data" {\n  count = 2\n}\n' };
    const diff = patch("main.tf", [
      [1, 1, [' resource "aws_s3_bucket" "data" {', "-  count = 3", "+  count = 2"]],
    ]);
    const ctx = contextFor(plan, memoryWorkspace(files), diff);
    const l = await traceChange(changeOf(ctx, "aws_s3_bucket.data[1]"), ctx);
    expect(l.explanation).toBe("external");
    expect(l.steps).toEqual([]);
    expect(l.notes.join(" ")).toMatch(/destroy plan/);
  });
});
