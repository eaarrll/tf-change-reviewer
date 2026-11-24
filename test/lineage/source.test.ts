import { describe, expect, it } from "vitest";
import { loadPlan } from "../../src/plan/load.js";
import { joinRepoPath, makeSnippet, MAX_SNIPPET_CHARS, SourceIndex } from "../../src/lineage/source.js";
import type { PlanModel, Workspace } from "../../src/types.js";
import { cres, memoryWorkspace, planJson } from "./helpers.js";

const FAKE_AWS_KEY = ["AKIA", "Z7QX3VN5LM2K8PRT"].join("");

function plan(rootModule: Record<string, unknown> = {}, variables: Record<string, unknown> = {}): PlanModel {
  return loadPlan(planJson({ rootModule, variables }));
}

const SG = [
  'resource "aws_security_group" "db" {', // 1
  '  name = "db"', // 2
  "", // 3
  "  ingress {", // 4
  '    description = "app"', // 5
  "    from_port   = 5432", // 6
  "    cidr_blocks = var.app_cidrs", // 7
  "  }", // 8
  "", // 9
  "  ingress {", // 10
  '    description = "office"', // 11
  "    from_port   = 5432", // 12
  "    cidr_blocks = local.office", // 13
  "  }", // 14
  "", // 15
  '  dynamic "ingress" {', // 16
  "    for_each = var.rules", // 17
  "    content {", // 18
  "      description = ingress.key", // 19
  "      from_port   = ingress.value.port", // 20
  "      cidr_blocks = ingress.value.cidrs", // 21
  "    }", // 22
  "  }", // 23
  "", // 24
  "  tags = {", // 25
  '    Name = "db"', // 26
  '    Team = "billing"', // 27
  "  }", // 28
  "}", // 29
].join("\n");

const sgRef = { mode: "managed" as const, type: "aws_security_group", name: "db" };

describe("joinRepoPath / makeSnippet", () => {
  it("joins module sources relative to a directory", () => {
    expect(joinRepoPath("", "./modules/db")).toBe("modules/db");
    expect(joinRepoPath("infra", "../modules/db")).toBe("modules/db");
    expect(joinRepoPath("infra/app", ".\\store")).toBe("infra/app/store");
    expect(joinRepoPath("", "../escape")).toBeNull();
  });

  it("masks, dedents and caps snippets", () => {
    const text = `resource "a_b" "c" {\n    password = "hunter2-hunter2"\n    key_id   = "${FAKE_AWS_KEY}"\n}\n`;
    const s = makeSnippet(text, 2, 3);
    const [first, second] = s.split("\n");
    expect(first).toBe('password = "(sensitive)"');
    expect(second?.startsWith('key_id   = "')).toBe(true);
    expect(s).not.toContain("hunter2");
    expect(s).not.toContain(FAKE_AWS_KEY);
    const long = makeSnippet(`x = "${"a".repeat(1000)}"`, 1, 1);
    expect([...long].length).toBe(MAX_SNIPPET_CHARS);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("SourceIndex.moduleDir", () => {
  const files = {
    "infra/main.tf": "",
    "infra/.terraform/modules/modules.json": JSON.stringify({
      Modules: [
        { Key: "", Source: "", Dir: "." },
        { Key: "app", Source: "./modules/app", Dir: "modules/app" },
        {
          Key: "vpc",
          Source: "registry.terraform.io/terraform-aws-modules/vpc/aws",
          Dir: ".terraform/modules/vpc",
        },
        { Key: "vpc.sub", Source: "./modules/sub", Dir: ".terraform/modules/vpc/modules/sub" },
        { Key: "evil", Source: "git::x", Dir: "/etc" },
        { Key: "escape", Source: "git::y", Dir: "../../.." },
      ],
    }),
  };
  const p = plan({
    module_calls: {
      app: {
        source: "./modules/app",
        module: { module_calls: { store: { source: "../store", module: {} } } },
      },
      shared: { source: "../shared/x", module: {} },
      vpc: {
        source: "terraform-aws-modules/vpc/aws",
        version: "5.1.0",
        module: { module_calls: { sub: { source: "./modules/sub", module: {} } } },
      },
      git: { source: "git::https://example.com/x.git?ref=v1", module: {} },
      evil: { source: "git::x", module: {} },
      escape: { source: "git::y", module: {} },
    },
  });

  it("resolves the root and local sources relative to the parent", async () => {
    const s = new SourceIndex(memoryWorkspace(files, "infra"), p);
    expect(await s.moduleDir([])).toBe("infra");
    expect(await s.moduleDir(["app"])).toBe("infra/modules/app");
    expect(await s.moduleDir(["app", "store"])).toBe("infra/modules/store");
    expect(await s.moduleDir(["shared"])).toBe("shared/x");
  });

  it("resolves remote modules (and their local children) through modules.json", async () => {
    const s = new SourceIndex(memoryWorkspace(files, "infra"), p);
    expect(await s.moduleDir(["vpc"])).toBe("infra/.terraform/modules/vpc");
    expect(await s.moduleDir(["vpc", "sub"])).toBe("infra/.terraform/modules/vpc/modules/sub");
  });

  it("returns null for remote modules without a manifest entry and unsafe manifest dirs", async () => {
    const s = new SourceIndex(memoryWorkspace(files, "infra"), p);
    expect(await s.moduleDir(["git"])).toBeNull();
    expect(await s.moduleDir(["evil"])).toBeNull();
    expect(await s.moduleDir(["escape"])).toBeNull();
    expect(await s.moduleDir(["nope"])).toBeNull();
    const notes = await s.moduleNotes(["git"]);
    expect(notes[0]).toContain('"git::https://example.com/x.git?ref=v1"');
  });

  it("tolerates a missing or malformed manifest", async () => {
    const s1 = new SourceIndex(memoryWorkspace({}, ""), p);
    expect(await s1.moduleDir(["vpc"])).toBeNull();
    const s2 = new SourceIndex(memoryWorkspace({ ".terraform/modules/modules.json": "{nope" }, ""), p);
    expect(await s2.moduleDir(["vpc"])).toBeNull();
    expect(await s2.moduleDir(["app"])).toBe("modules/app");
  });

  it("uses the manifest for a module call the plan no longer has (removed call)", async () => {
    const s = new SourceIndex(
      memoryWorkspace({
        ".terraform/modules/modules.json": JSON.stringify({ Modules: [{ Key: "old", Dir: "modules/old" }] }),
      }),
      plan(),
    );
    expect(await s.moduleDir(["old"])).toBe("modules/old");
  });
});

describe("SourceIndex resources and attributes", () => {
  const ws = memoryWorkspace({
    "main.tf": SG,
    "other.tf": 'data "aws_iam_policy_document" "p" {\n  statement {\n    actions = ["s3:*"]\n  }\n}\n',
  });
  const s = new SourceIndex(ws, plan({ resources: [cres("aws_security_group.db")] }));

  it("finds a resource block with every argument's references", async () => {
    const hit = await s.findResource([], sgRef);
    expect(hit?.location).toEqual({ file: "main.tf", startLine: 1, endLine: 29 });
    expect(hit?.references).toEqual(expect.arrayContaining(["var.app_cidrs", "local.office", "var.rules"]));
    expect(hit?.snippet.startsWith('resource "aws_security_group" "db" {')).toBe(true);
    expect(await s.findResource([], { ...sgRef, name: "nope" })).toBeNull();
    expect(
      await s.findResource([], { mode: "data", type: "aws_iam_policy_document", name: "p" }),
    ).toMatchObject({
      location: { file: "other.tf", startLine: 1, endLine: 5 },
    });
  });

  it("finds a top-level attribute and narrows map keys to their line", async () => {
    expect((await s.findResourceAttribute([], sgRef, ["name"]))?.location).toEqual({
      file: "main.tf",
      startLine: 2,
      endLine: 2,
    });
    const team = await s.findResourceAttribute([], sgRef, ["tags", "Team"]);
    expect(team?.location).toEqual({ file: "main.tf", startLine: 27, endLine: 27 });
    expect(team?.snippet).toBe('Team = "billing"');
    const whole = await s.findResourceAttribute([], sgRef, ["tags", "Missing"]);
    expect(whole?.location).toEqual({ file: "main.tf", startLine: 25, endLine: 28 });
  });

  it("picks a set-typed nested block by the planned block value, not by index", async () => {
    const office = await s.findResourceAttribute(
      [],
      sgRef,
      ["ingress", 0, "cidr_blocks"],
      [{ description: "office", from_port: 5432, cidr_blocks: ["0.0.0.0/0"] }],
    );
    expect(office?.location.startLine).toBe(13);
    expect(office?.references).toEqual(["local.office"]);
    const app = await s.findResourceAttribute(
      [],
      sgRef,
      ["ingress", 2, "cidr_blocks"],
      [{ description: "app", from_port: 5432, cidr_blocks: ["10.0.0.0/8"] }],
    );
    expect(app?.location.startLine).toBe(7);
  });

  it("recognizes a dynamic block's element when static blocks' literals disagree", async () => {
    const hit = await s.findResourceAttribute(
      [],
      sgRef,
      ["ingress", 0, "cidr_blocks"],
      [{ description: "https", from_port: 443, cidr_blocks: ["0.0.0.0/0"] }],
    );
    expect(hit?.location.startLine).toBe(21);
    expect(hit?.references).toEqual(["ingress.value.cidrs", "ingress.value"]);
    expect(hit?.dynamic).toHaveLength(1);
    expect(hit?.dynamic?.[0]).toMatchObject({ label: "ingress", iterator: "ingress" });
    expect(hit?.dynamic?.[0]?.forEach?.location.startLine).toBe(17);
    expect(hit?.dynamic?.[0]?.forEach?.references).toEqual(["var.rules"]);
  });

  it("falls back to the ordinal of static blocks without hints", async () => {
    expect(
      (await s.findResourceAttribute([], sgRef, ["ingress", 1, "cidr_blocks"]))?.location.startLine,
    ).toBe(13);
    expect(
      (await s.findResourceAttribute([], sgRef, ["ingress", 0, "cidr_blocks"]))?.location.startLine,
    ).toBe(7);
  });

  it("returns null for attributes that are not in the source", async () => {
    expect(await s.findResourceAttribute([], sgRef, ["arn"])).toBeNull();
    expect(await s.findResourceAttribute([], sgRef, ["egress", 0, "cidr_blocks"])).toBeNull();
    expect(await s.findResourceAttribute([], { ...sgRef, name: "x" }, ["name"])).toBeNull();
  });

  it("honours a custom dynamic iterator name", async () => {
    const s2 = new SourceIndex(
      memoryWorkspace({
        "main.tf":
          'resource "aws_lb_listener" "l" {\n  dynamic "default_action" {\n    for_each = local.actions\n    iterator = act\n    content {\n      type = act.value.type\n    }\n  }\n}\n',
      }),
      plan(),
    );
    const hit = await s2.findResourceAttribute([], { mode: "managed", type: "aws_lb_listener", name: "l" }, [
      "default_action",
      0,
      "type",
    ]);
    expect(hit?.dynamic?.[0]).toMatchObject({ label: "default_action", iterator: "act" });
    expect(hit?.references).toEqual(["act.value.type", "act.value"]);
  });

  it("lists every attribute of a block, nested ones included", async () => {
    const attrs = await s.findResourceAttributes([], {
      mode: "data",
      type: "aws_iam_policy_document",
      name: "p",
    });
    expect(attrs.map((a) => [a.path.join("."), a.hit.location.startLine])).toEqual([
      ["statement.actions", 3],
    ]);
    const sgAttrs = await s.findResourceAttributes([], sgRef);
    const ingress = ["ingress.description", "ingress.from_port", "ingress.cidr_blocks"];
    expect(sgAttrs.map((a) => a.path.join("."))).toEqual([
      "name",
      "tags",
      ...ingress,
      ...ingress,
      ...ingress,
    ]);
    expect(sgAttrs.find((a) => a.hit.location.startLine === 21)?.hit.dynamic?.[0]?.iterator).toBe("ingress");
  });

  it("prefers override files for attributes and the base file for the block", async () => {
    const s2 = new SourceIndex(
      memoryWorkspace({
        "main.tf": 'resource "a_b" "c" {\n  size = 1\n  name = "x"\n}\n',
        "main_override.tf": 'resource "a_b" "c" {\n  size = 2\n}\n',
      }),
      plan(),
    );
    const ref = { mode: "managed" as const, type: "a_b", name: "c" };
    expect((await s2.findResource([], ref))?.location.file).toBe("main.tf");
    expect((await s2.findResourceAttribute([], ref, ["size"]))?.location.file).toBe("main_override.tf");
    expect((await s2.findResourceAttribute([], ref, ["name"]))?.location.file).toBe("main.tf");
  });
});

describe("SourceIndex modules, variables, locals and outputs", () => {
  const ws = memoryWorkspace({
    "main.tf": [
      'module "db" {', // 1
      '  source    = "app.terraform.io/acme/db/aws"', // 2
      '  version   = "~> 2.1"', // 3
      "  encrypted = var.encrypted", // 4
      "  for_each  = var.dbs", // 5
      "}", // 6
      "", // 7
      'variable "encrypted" {', // 8
      "  type    = bool", // 9
      "  default = true", // 10
      "}", // 11
      'variable "nodefault" {}', // 12
      'variable "db_password" {', // 13
      "  sensitive = true", // 14
      '  default   = "plain-value-123"', // 15
      "}", // 16
    ].join("\n"),
    "locals.tf": "locals {\n  a = 1\n}\n\nlocals {\n  b = local.a + var.encrypted\n}\n",
    "outputs.tf":
      'output "endpoint" {\n  value = module.db["x"].endpoint\n}\noutput "noval" {\n  description = "x"\n}\n',
    "config.tf.json": "{}",
  });
  const p = plan({
    module_calls: { db: { source: "app.terraform.io/acme/db/aws", version: "~> 2.1", module: {} } },
    variables: { encrypted: { default: true }, nodefault: {}, db_password: { sensitive: true } },
  });
  const s = new SourceIndex(ws, p);

  it("finds module calls, arguments and source/version lines", async () => {
    expect((await s.findModuleCall(["db"]))?.location).toEqual({ file: "main.tf", startLine: 1, endLine: 6 });
    const arg = await s.findModuleArgument(["db"], "encrypted");
    expect(arg?.location.startLine).toBe(4);
    expect(arg?.references).toEqual(["var.encrypted"]);
    expect((await s.findModuleArgument(["db"], "for_each"))?.references).toEqual(["var.dbs"]);
    expect(await s.findModuleArgument(["db"], "missing")).toBeNull();
    expect((await s.findModuleSource(["db"])).map((h) => h.location.startLine)).toEqual([3, 2]);
    expect(await s.findModuleCall([])).toBeNull();
  });

  it("finds variables and their default line, with the literal value", async () => {
    expect((await s.findVariable([], "encrypted"))?.location).toEqual({
      file: "main.tf",
      startLine: 8,
      endLine: 11,
    });
    const def = await s.findVariableDefault([], "encrypted");
    expect(def?.location).toEqual({ file: "main.tf", startLine: 10, endLine: 10 });
    expect(def?.literal).toEqual({ value: true });
    expect(await s.findVariableDefault([], "nodefault")).toBeNull();
    expect((await s.findVariable([], "nodefault"))?.location.startLine).toBe(12);
  });

  it("masks the default of a sensitive variable but keeps its literal for comparison", async () => {
    const def = await s.findVariableDefault([], "db_password");
    expect(def?.snippet).toBe("default = (sensitive)");
    expect(def?.snippet).not.toContain("plain-value-123");
    expect(def?.literal).toEqual({ value: "plain-value-123" });
  });

  it("masks a module argument that feeds a sensitive child variable, escaped quotes included", async () => {
    const ws2 = memoryWorkspace({
      "main.tf": 'module "db" {\n  source  = "./db"\n  db_pass = "Mod\\"Const-77"\n  gen     = var.gen\n}\n',
      "db/main.tf": 'variable "db_pass" {\n  sensitive = true\n}\nvariable "gen" {}\n',
    });
    const p2 = plan({
      module_calls: {
        db: { source: "./db", module: { variables: { db_pass: { sensitive: true }, gen: {} } } },
      },
    });
    const s2 = new SourceIndex(ws2, p2);
    const pass = await s2.findModuleArgument(["db"], "db_pass");
    expect(pass?.snippet).toBe("db_pass = (sensitive)");
    expect(pass?.literal).toEqual({ value: 'Mod"Const-77' });
    expect((await s2.findModuleArgument(["db"], "gen"))?.snippet).toBe("gen     = var.gen");
  });

  it("finds locals in any locals block of the module", async () => {
    expect((await s.findLocal([], "a"))?.location).toEqual({ file: "locals.tf", startLine: 2, endLine: 2 });
    const b = await s.findLocal([], "b");
    expect(b?.location.startLine).toBe(6);
    expect(b?.references).toEqual(["local.a", "var.encrypted"]);
    expect(await s.findLocal([], "c")).toBeNull();
  });

  it("finds an output's value, or its block when it has none", async () => {
    const out = await s.findOutput([], "endpoint");
    expect(out?.location).toEqual({ file: "outputs.tf", startLine: 2, endLine: 2 });
    expect(out?.references).toEqual(['module.db["x"].endpoint', "module.db"]);
    expect((await s.findOutput([], "noval"))?.location).toEqual({
      file: "outputs.tf",
      startLine: 4,
      endLine: 6,
    });
  });

  it("notes JSON configuration files it does not search", async () => {
    expect(await s.moduleNotes([])).toEqual([expect.stringContaining("config.tf.json")]);
  });
});

describe("SourceIndex providers", () => {
  const ws = memoryWorkspace({
    "providers.tf": [
      "terraform {", // 1
      "  required_providers {", // 2
      "    aws = {", // 3
      '      source  = "hashicorp/aws"', // 4
      '      version = "~> 6.0"', // 5
      "    }", // 6
      "  }", // 7
      "}", // 8
      'provider "aws" {', // 9
      '  alias  = "us"', // 10
      '  region = "us-east-1"', // 11
      "}", // 12
      'provider "aws" {', // 13
      '  region = "eu-west-1"', // 14
      "  default_tags {", // 15
      "    tags = {", // 16
      '      Project = "orders"', // 17
      "      Env     = var.environment", // 18
      "    }", // 19
      "  }", // 20
      "}", // 21
    ].join("\n"),
    ".terraform.lock.hcl":
      'provider "registry.terraform.io/hashicorp/aws" {\n  version     = "6.74.0"\n  constraints = "~> 6.0"\n  hashes = [\n    "h1:abc=",\n  ]\n}\n',
  });
  const s = new SourceIndex(ws, plan());

  it("prefers the un-aliased provider block", async () => {
    expect((await s.findProvider("aws"))?.location).toEqual({
      file: "providers.tf",
      startLine: 13,
      endLine: 21,
    });
    expect(await s.findProvider("google")).toBeNull();
  });

  it("finds default_tags keys", async () => {
    const env = await s.findProviderAttribute("aws", ["default_tags", "tags", "Env"]);
    expect(env?.location).toEqual({ file: "providers.tf", startLine: 18, endLine: 18 });
    expect(env?.references).toEqual(["var.environment"]);
    expect((await s.findProviderAttribute("aws", ["default_tags", "tags"]))?.location).toMatchObject({
      startLine: 16,
      endLine: 19,
    });
  });

  it("finds required_providers versions and the locked version", async () => {
    expect((await s.findRequiredProvider("aws"))?.location).toEqual({
      file: "providers.tf",
      startLine: 5,
      endLine: 5,
    });
    expect(await s.findRequiredProvider("google")).toBeNull();
    expect((await s.findLockedProvider("registry.terraform.io/hashicorp/aws"))?.location).toEqual({
      file: ".terraform.lock.hcl",
      startLine: 2,
      endLine: 2,
    });
    expect(await s.findLockedProvider("registry.terraform.io/hashicorp/google")).toBeNull();
  });
});

describe("SourceIndex tfvars", () => {
  const files = {
    "env/main.tf": "",
    "env/terraform.tfvars": 'size = "medium"\nreplicas = 2\napi_token = "tok-123456"\n',
    "env/terraform.tfvars.json": '{\n  "size": "large",\n  "tags": {\n    "a": "b"\n  }\n}\n',
    "env/b.auto.tfvars": 'size = "xlarge"\n',
    "env/a.auto.tfvars.json": '{"size": "huge"}',
    "env/other.tfvars": 'size = "ignored"\n',
    "terraform.tfvars": 'size = "wrong-dir"\n',
  };
  const s = new SourceIndex(
    memoryWorkspace(files, "env"),
    loadPlan(
      planJson({
        rootModule: { variables: { size: {}, api_token: { sensitive: true }, tags: {} } },
        variables: { size: "xlarge", api_token: "x" },
      }),
    ),
  );

  it("returns assignments in Terraform's precedence order from the root module dir only", async () => {
    const hits = await s.findTfvars("size");
    expect(hits.map((h) => [h.location.file, h.location.startLine, h.literal?.value])).toEqual([
      ["env/terraform.tfvars", 1, "medium"],
      ["env/terraform.tfvars.json", 2, "large"],
      ["env/a.auto.tfvars.json", 1, "huge"],
      ["env/b.auto.tfvars", 1, "xlarge"],
    ]);
  });

  it("spans multi-line JSON values", async () => {
    const [tags] = await s.findTfvars("tags");
    expect(tags?.location).toEqual({ file: "env/terraform.tfvars.json", startLine: 3, endLine: 5 });
    expect(tags?.literal).toEqual({ value: { a: "b" } });
  });

  it("masks values of sensitive variables in snippets", async () => {
    const [tok] = await s.findTfvars("api_token");
    expect(tok?.snippet).toBe("api_token = (sensitive)");
    expect(JSON.stringify(tok?.snippet)).not.toContain("tok-123456");
  });

  it("returns [] when the variable is not assigned", async () => {
    expect(await s.findTfvars("nothing")).toEqual([]);
  });
});

describe("SourceIndex moved / removed / import blocks", () => {
  const s = new SourceIndex(
    memoryWorkspace({
      "main.tf":
        "moved {\n  from = aws_s3_bucket.old\n  to   = aws_s3_bucket.new\n}\nremoved {\n  from = aws_s3_bucket.gone\n  lifecycle {\n    destroy = false\n  }\n}\n",
    }),
    plan(),
  );

  it("finds the block naming an address", async () => {
    expect((await s.findConfigBlockFor([], "moved", "to", "aws_s3_bucket.new"))?.location.startLine).toBe(1);
    expect(
      (await s.findConfigBlockFor([], "removed", "from", "aws_s3_bucket.gone[0]"))?.location.startLine,
    ).toBe(5);
    expect(await s.findConfigBlockFor([], "import", "to", "aws_s3_bucket.new")).toBeNull();
  });
});

describe("SourceIndex never throws", () => {
  const throwing: Workspace = {
    root: "/repo",
    rootModuleDir: "",
    readFile: () => Promise.reject(new Error("boom")),
    listFiles: () => Promise.reject(new Error("boom")),
  };
  const s = new SourceIndex(throwing, plan({ module_calls: { m: { source: "./m", module: {} } } }));

  it("returns null / [] from every finder", async () => {
    const ref = { mode: "managed" as const, type: "a_b", name: "c" };
    expect(await s.findResource([], ref)).toBeNull();
    expect(await s.findResourceAttribute([], ref, ["x"])).toBeNull();
    expect(await s.findResourceAttributes([], ref)).toEqual([]);
    expect(await s.findModuleCall(["m"])).toBeNull();
    expect(await s.findModuleArgument(["m"], "x")).toBeNull();
    expect(await s.findModuleSource(["m"])).toEqual([]);
    expect(await s.findVariable([], "x")).toBeNull();
    expect(await s.findVariableDefault([], "x")).toBeNull();
    expect(await s.findLocal([], "x")).toBeNull();
    expect(await s.findOutput(["m"], "x")).toBeNull();
    expect(await s.findProvider("aws")).toBeNull();
    expect(await s.findProviderAttribute("aws", ["default_tags"])).toBeNull();
    expect(await s.findRequiredProvider("aws")).toBeNull();
    expect(await s.findLockedProvider("registry.terraform.io/hashicorp/aws")).toBeNull();
    expect(await s.findTfvars("x")).toEqual([]);
    expect(await s.findConfigBlockFor([], "moved", "to", "a_b.c")).toBeNull();
    expect(await s.snippetAt({ file: "main.tf", startLine: 1, endLine: 1 })).toBeNull();
    expect(await s.moduleDir(["m"])).toBe("m");
  });
});

describe("SourceIndex var files and plans without configuration", () => {
  it("finds assignments in var files Terraform does not load automatically", async () => {
    const ws = memoryWorkspace({
      "main.tf": 'variable "suffix" {}\n',
      "terraform.tfvars": 'suffix = "auto"\n',
      "prod.tfvars": 'suffix = "root"\n',
      "envs/prod.tfvars.json": '{\n  "suffix": "json"\n}\n',
    });
    const s = new SourceIndex(ws, plan());
    const hits = await s.findVarFileAssignments("suffix", ["envs/prod.tfvars.json", "terraform.tfvars"]);
    expect(hits.map((h) => [h.location.file, h.location.startLine, h.literal?.value])).toEqual([
      ["envs/prod.tfvars.json", 2, "json"],
      ["prod.tfvars", 1, "root"],
    ]);
  });

  it("resolves a local module's directory from its call when the plan has no configuration", async () => {
    const ws = memoryWorkspace({
      "main.tf": 'module "app" {\n  source = "./modules/app"\n}\n',
      "modules/app/main.tf": 'resource "terraform_data" "x" {}\n',
    });
    const s = new SourceIndex(ws, plan());
    expect(await s.moduleDir(["app"])).toBe("modules/app");
    const ref = { mode: "managed" as const, type: "terraform_data", name: "x" };
    expect((await s.findResource(["app"], ref))?.location.file).toBe("modules/app/main.tf");
  });
});
