// End-to-end leak test for values that value-equality scrubbing used to miss: sensitive values in
// escaped form (HCL `\"`, Terraform's JSON `&`), an indented heredoc default, a short value,
// a lowercase passphrase, and the plan JSON itself sitting in the checkout (plan-json: plan.json),
// plus .env and state files the PR adds. A scripted agent reads all of it through every tool.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderCliReport, renderJson, renderReviewComment } from "../../src/report/markdown.js";
import { reviewPlan } from "../../src/review.js";
import { createFsWorkspace } from "../../src/workspace.js";
import { scriptedClient, reply, thinking, toolUse, verdictReply } from "../helpers/anthropic.js";

const DB_PASSWORD = 'Def&Pass<w>"q1';
const MODULE_PASS = 'Mod"Const-Pw-77';
const SVC_CONFIG = "host=db.internal\nkey=Zq81-Indent-Secret\n";
const PASSPHRASE = "correcthorsebattery";
const PIN = 'p"w9';
/** Fragments that must not appear in any form: raw, HCL-escaped or JSON-escaped. */
const LEAKS = [
  "Def&Pass",
  "Def\\u0026Pass",
  "Const-Pw-77",
  "Zq81-Indent",
  "correcthorse",
  'p"w9',
  'p\\"w9',
  "Plain-Env-Secret-91",
  "StateOnly-Secret-7",
];
const AWS = "registry.terraform.io/hashicorp/aws";

/** terraform show -json output: Go's encoder escapes & < > too. */
function goJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[&<>]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

function plan(): Record<string, unknown> {
  const replace = (address: string, input: string, module?: string) => ({
    address,
    ...(module && { module_address: module }),
    mode: "managed",
    type: "terraform_data",
    name: address.split(".").at(-1),
    provider_name: "terraform.io/builtin/terraform",
    action_reason: "replace_because_cannot_update",
    change: {
      actions: ["delete", "create"],
      before: { input, output: input, id: "a" },
      after: { input, triggers_replace: null },
      after_unknown: { id: true, output: true },
      before_sensitive: { input: true, output: true },
      after_sensitive: { input: true },
      replace_paths: [["input"]],
    },
  });
  return {
    format_version: "1.2",
    terraform_version: "1.10.5",
    variables: {
      db_password: { value: DB_PASSWORD },
      svc_config: { value: SVC_CONFIG },
      passphrase: { value: PASSPHRASE },
      pin: { value: PIN },
    },
    resource_changes: [
      replace("terraform_data.cfg", SVC_CONFIG),
      replace("module.db.terraform_data.pw", MODULE_PASS, "module.db"),
      {
        address: "aws_security_group.db",
        mode: "managed",
        type: "aws_security_group",
        name: "db",
        provider_name: AWS,
        change: {
          actions: ["update"],
          before: { name: "db", description: "x", tags: { Owner: "a" } },
          after: { name: "db", description: `x ${PASSPHRASE} ${DB_PASSWORD}`, tags: { Owner: "b" } },
          after_unknown: {},
          before_sensitive: {},
          after_sensitive: {},
        },
      },
    ],
    configuration: {
      root_module: {
        variables: {
          db_password: { sensitive: true, default: DB_PASSWORD },
          svc_config: { sensitive: true, default: SVC_CONFIG },
          passphrase: { sensitive: true },
          pin: { sensitive: true, default: PIN },
        },
        resources: [
          {
            address: "terraform_data.cfg",
            mode: "managed",
            type: "terraform_data",
            name: "cfg",
            expressions: { input: { references: ["var.svc_config"] } },
          },
          {
            address: "aws_security_group.db",
            mode: "managed",
            type: "aws_security_group",
            name: "db",
            expressions: { name: { constant_value: "db" } },
          },
        ],
        module_calls: {
          db: {
            source: "./modules/db",
            expressions: { db_pass: { constant_value: MODULE_PASS } },
            module: {
              variables: { db_pass: { sensitive: true } },
              resources: [
                {
                  address: "terraform_data.pw",
                  mode: "managed",
                  type: "terraform_data",
                  name: "pw",
                  expressions: { input: { references: ["var.db_pass"] } },
                },
              ],
            },
          },
        },
      },
    },
  };
}

const MAIN_TF = [
  'variable "db_password" {',
  "  type      = string",
  "  sensitive = true",
  '  default   = "Def&Pass<w>\\"q1"',
  "}",
  "",
  'variable "svc_config" {',
  "  type      = string",
  "  sensitive = true",
  "  default   = <<-EOT",
  "    host=db.internal",
  "    key=Zq81-Indent-Secret",
  "  EOT",
  "}",
  "",
  'variable "passphrase" {',
  "  sensitive = true",
  "}",
  "",
  'variable "pin" {',
  "  sensitive = true",
  '  default   = "p\\"w9"',
  "}",
  "",
  'module "db" {',
  '  source  = "./modules/db"',
  '  db_pass = "Mod\\"Const-Pw-77"',
  "}",
  "",
  'resource "terraform_data" "cfg" {',
  "  input = var.svc_config",
  "}",
  "",
].join("\n");

const FILES: Record<string, string> = {
  "main.tf": MAIN_TF,
  "terraform.tfvars": 'passphrase = "correcthorsebattery"\n',
  "modules/db/main.tf":
    'variable "db_pass" {\n  sensitive = true\n}\n\nresource "terraform_data" "pw" {\n  input = var.db_pass\n}\n',
  ".env": "PLAIN=Plain-Env-Secret-91\n",
  "terraform.tfstate":
    '{\n  "version": 4,\n  "resources": [{"attributes": {"value": "x-StateOnly-Secret-7"}}]\n}\n',
};

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "tfcr-leak-"));
  for (const [path, text] of Object.entries({ ...FILES, "plan.json": goJson(plan()) })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function newFileDiff(path: string, text: string): string[] {
  const lines = text.replace(/\n$/, "").split("\n");
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
  ];
}

/** Every string inside a recorded request body, decoded (the body is JSON). */
function strings(raw: string): string {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x);
  };
  walk(JSON.parse(raw) as unknown);
  return out.join("\n");
}

describe("no escaped, heredoc, short or passphrase secret, plan or state file reaches the model or the report", () => {
  it("scrubs every encoding and refuses the plan, state and .env in every tool and cause ref", async () => {
    const root = repo();
    const diffText = [
      ...newFileDiff("main.tf", MAIN_TF),
      ...newFileDiff(".env", FILES[".env"]!),
      ...newFileDiff("terraform.tfstate", FILES["terraform.tfstate"]!),
      ...newFileDiff("plan.json", goJson(plan())),
      "",
    ].join("\n");
    // Sanity: the inputs really hold the escaped forms the scrubber has to catch.
    expect(diffText).toContain('db_pass = "Mod\\"Const-Pw-77"');
    expect(diffText).toContain("Def\\u0026Pass\\u003cw\\u003e");

    const { client, requests } = scriptedClient([
      reply(
        [
          thinking,
          toolUse("t1", "read_file", { path: "plan.json" }),
          toolUse("t2", "read_file", { path: "main.tf" }),
          toolUse("t3", "search_repo", { pattern: "=", path_glob: "*" }),
          toolUse("t4", "get_diff", {}),
          toolUse("t5", "get_diff", { path: ".env" }),
          toolUse("t6", "get_diff", { path: "terraform.tfstate" }),
          toolUse("t7", "get_diff", { path: "plan.json" }),
          toolUse("t8", "read_file", { path: "terraform.tfvars" }),
        ],
        "tool_use",
      ),
      reply(
        [
          thinking,
          toolUse("t9", "trace_cause", { address: "module.db.terraform_data.pw", attribute: "input" }),
          toolUse("t10", "trace_cause", { address: "terraform_data.cfg" }),
          toolUse("t11", "get_change", { address: "terraform_data.cfg" }),
          toolUse("t12", "get_change", { address: "aws_security_group.db" }),
          toolUse("t13", "list_changes", {}),
        ],
        "tool_use",
      ),
      verdictReply({
        summary: "Config replaced.",
        findings: [
          {
            address: "terraform_data.cfg",
            severity: "high",
            title: "Config replaced",
            impact: "Recreated.",
            cause: "The heredoc default changed.",
            cause_refs: [
              { file: "main.tf", line: 12 },
              { file: "main.tf", line: 27 },
              { file: "main.tf", line: 4 },
              { file: "plan.json", line: 1 },
            ],
            confidence: "high",
          },
        ],
        dismissed: [],
      }),
    ]);
    const review = await reviewPlan({
      planJson: plan(),
      workspace: createFsWorkspace(root, ""),
      diffText,
      agent: {
        model: "claude-opus-5-5",
        apiKey: "sk-test",
        effort: "high",
        maxTurns: 6,
        maxCostUsd: 5,
        timeoutMs: 60_000,
        client,
      },
      maxFindings: 7,
    });

    expect(review.agent?.status).toBe("complete");
    expect(requests).toHaveLength(3);
    const sent = requests.map((r) => strings(r.raw)).join("\n");
    // The tools ran and refused what they had to (the workspace reads a plan JSON as missing).
    expect(sent).toContain("File not found or not readable at the PR head: plan.json.");
    // .env, terraform.tfstate and plan.json in the whole diff, then each one asked for by path.
    const last = strings(requests.at(-1)?.raw ?? "{}");
    expect(last.match(/\[changed lines not shown:/g)).toHaveLength(6);
    expect(sent).toContain('passphrase = "(sensitive)"');
    for (const leak of LEAKS) expect(sent, leak).not.toContain(leak);

    const rendered = [
      JSON.stringify(review),
      renderReviewComment([review], { version: "test" }),
      renderCliReport([review]),
      renderJson([review]),
    ].join("\n");
    for (const leak of LEAKS) expect(rendered, leak).not.toContain(leak);
    expect(rendered).not.toContain("format_version");
  });
});
