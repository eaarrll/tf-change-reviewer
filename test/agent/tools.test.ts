import { describe, expect, it, vi } from "vitest";
import {
  MAX_FILE_RESULT_CHARS,
  MAX_LINES_PER_READ,
  MAX_SEARCH_HITS,
  MAX_TOOL_RESULT_CHARS,
  DENIED_FILES,
  capResult,
  createTools,
  maskLines,
  normalizeRepoPath,
  parseAttrPath,
  searchDirectories,
  type ReviewTool,
  type ToolCallTrace,
  type ToolDeps,
} from "../../src/agent/tools.js";
import type { Lineage } from "../../src/types.js";
import {
  AWS_KEY,
  DB,
  DB_LINEAGE,
  DB_PASSWORD,
  FILES,
  INJECTED,
  LOG_GROUP,
  NOOP,
  OLD_PASSWORD,
  SECRETS,
  SG,
  bucket,
  contextFixture,
  type ContextFixture,
} from "./fixtures.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness extends ContextFixture {
  tools: ReviewTool[];
  calls: Array<Omit<ToolCallTrace, "turn">>;
  call(name: string, input: unknown): Promise<string>;
}

function harness(
  options: Parameters<typeof contextFixture>[0] & { deps?: Partial<ToolDeps>; known?: boolean } = {},
): Harness {
  const fixture = contextFixture(options);
  const calls: Harness["calls"] = [];
  const known = options.known === false ? undefined : new Map<string, Lineage | null>([[DB, DB_LINEAGE]]);
  const tools = createTools({
    ctx: fixture.ctx,
    ...(known && { knownLineage: known }),
    onCall: (c) => calls.push(c),
    ...options.deps,
  });
  /** Calls a tool the way the runner does: validate with parse(), then run(). */
  async function call(name: string, input: unknown): Promise<string> {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    const run = tool.run as (args: unknown) => Promise<string>;
    return run(tool.parse(input));
  }
  return { ...fixture, tools, calls, call };
}

function expectNoSecrets(text: string): void {
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

describe("createTools", () => {
  it("defines six read-only tools with JSON schemas and no run function on the wire", () => {
    const { tools } = harness();
    const wire = JSON.parse(JSON.stringify(tools)) as Array<Record<string, unknown>>;

    expect(wire.map((t) => t.name)).toEqual([
      "list_changes",
      "get_change",
      "trace_cause",
      "read_file",
      "search_repo",
      "get_diff",
    ]);
    for (const tool of wire) {
      expect(typeof tool.description).toBe("string");
      expect(tool.input_schema).toMatchObject({ type: "object" });
      expect(tool).not.toHaveProperty("run");
    }
    const readFile = wire.find((t) => t.name === "read_file")?.input_schema as { required?: string[] };
    expect(readFile.required).toEqual(["path"]);
  });

  it("refuses a call the admit hook rejects, records it and never runs it", async () => {
    const { call, calls, workspace } = harness({ deps: { admit: () => "Skipped: too many calls." } });

    await expect(call("read_file", { path: "main.tf" })).rejects.toThrow("Skipped: too many calls.");

    expect(workspace.reads).toEqual([]);
    expect(calls).toEqual([expect.objectContaining({ name: "read_file", ok: false })]);
  });

  it("rejects malformed input with a readable message and records the attempt", async () => {
    const { call, calls } = harness();

    await expect(call("get_change", {})).rejects.toThrow(/invalid input for get_change/);
    await expect(call("list_changes", { action: "explode" })).rejects.toThrow(
      /invalid input for list_changes/,
    );

    expect(calls.map((c) => [c.name, c.ok])).toEqual([
      ["get_change", false],
      ["list_changes", false],
    ]);
  });

  it("logs each call at debug level with masked input", async () => {
    const debug = vi.fn();
    const { call } = harness({ deps: { logger: { info: vi.fn(), warn: vi.fn(), debug } } });

    await call("search_repo", { pattern: AWS_KEY });

    expect(debug).toHaveBeenCalledTimes(1);
    const line = String(debug.mock.calls[0]?.[0]);
    expect(line).toMatch(/^tool search_repo .* -> ok, \d+ chars, \d+ ms$/);
    expect(line).not.toContain(AWS_KEY);
  });
});

// ---------------------------------------------------------------------------
// list_changes
// ---------------------------------------------------------------------------

describe("list_changes", () => {
  it("lists every non-no-op change, highest risk first, one line each", async () => {
    const { call } = harness();

    const text = await call("list_changes", {});

    const lines = text.split("\n");
    expect(lines[0]).toBe("52 of 52 changes match; showing 1-50:");
    expect(lines[1]).toBe(`1. ${DB} | replace | storage_encrypted | critical [stateful-replace]`);
    expect(lines[2]).toBe(`2. ${SG} | create | cidr_blocks, from_port, to_port, type | high [sg-open-world]`);
    expect(text).toContain(`${bucket(0)} | update | tags_all | noise [tags-only]`);
    expect(text).not.toContain(NOOP);
    expect(lines.at(-1)).toBe("Call again with offset=50 for more.");
  });

  it("pages with offset and limit", async () => {
    const { call } = harness();

    const page = await call("list_changes", { offset: 50, limit: 10 });
    expect(page.split("\n")[0]).toBe("52 of 52 changes match; showing 51-52:");
    expect(page).not.toContain("Call again");

    expect(await call("list_changes", { offset: 60 })).toBe("52 changes match; offset 60 is past the end.");
    // Out-of-range limits are clamped, not rejected.
    expect((await call("list_changes", { limit: 0 })).split("\n")[0]).toBe(
      "52 of 52 changes match; showing 1-1:",
    );
  });

  it.each([
    [{ action: "create" }, [SG, LOG_GROUP]],
    [{ type: "aws_db_instance" }, [DB]],
    [{ type: "aws_s3_*", attribute: "acl" }, [INJECTED]],
    [{ module: "module.orders_db" }, [DB]],
    [{ module: "orders_db" }, []],
    [{ min_severity: "high" }, [DB, SG]],
    [{ min_severity: "low", type: "aws_cloudwatch_log_group" }, [LOG_GROUP]],
    [{ attribute: "storage_encrypted" }, [DB]],
    [{ attribute: "tags_all", limit: 2 }, [bucket(0), bucket(1)]],
  ])("filters with %j", async (input, expected) => {
    const { call } = harness();

    const text = await call("list_changes", input);

    if (expected.length === 0) {
      expect(text).toMatch(/^No changes match \(.*\)\. 52 changes in the plan\.$/);
      return;
    }
    const listed = text
      .split("\n")
      .filter((line) => /^\d+\. /.test(line))
      .map((line) => line.replace(/^\d+\. /, "").split(" | ")[0]);
    expect(listed).toEqual(
      expected.map((a) =>
        a.replace(/[\u0000-\u001f]/g, " ").replace(/<(\/?)plan_digest\b/gi, "<$1plan_digest_"),
      ),
    );
  });

  it("lists only root-module changes for module=root", async () => {
    const { call } = harness();

    const text = await call("list_changes", { module: "root", min_severity: "medium" });

    expect(text).toContain(SG);
    expect(text).not.toContain(DB);
  });
});

// ---------------------------------------------------------------------------
// get_change
// ---------------------------------------------------------------------------

describe("get_change", () => {
  it("shows the full masked detail of a change", async () => {
    const { call } = harness();

    const text = await call("get_change", { address: ` ${DB} ` });

    expect(text).toContain(DB);
    expect(text).toContain(
      "Action: replace, destroy-before-create (replace_because_cannot_update); severity critical (score 1000)",
    );
    expect(text).toContain('Identity: identifier="orders-prod"');
    expect(text).toContain("Forces replacement: storage_encrypted");
    expect(text).toContain("  storage_encrypted: true → false  [forces replacement]");
    expect(text).toContain("Known after apply: 3 attributes (arn, endpoint, id)");
    expect(text).toContain("[critical] stateful-replace: The database is destroyed");
    expect(text).toContain("(attribute storage_encrypted)");
    expect(text).toContain("trace_cause shows the code behind it.");
  });

  it("lists unknown values of an in-place update as rows", async () => {
    const fixture = harness();
    const injected = fixture.scoredChanges.find((s) => s.change.address === INJECTED)!.change;
    injected.unknownPaths = [["website_endpoint"]];

    const text = await fixture.call("get_change", { address: INJECTED });

    expect(text).toContain('  acl: "private" → "public-read"');
    expect(text).toContain("  website_endpoint: (absent) → (known after apply)");
    expect(text).toContain("Risk signals: none");
  });

  it("finds a moved resource by its previous address", async () => {
    const fixture = harness();
    fixture.scoredChanges[1]!.change.previousAddress = "aws_security_group_rule.ssh";

    const text = await fixture.call("get_change", { address: "aws_security_group_rule.ssh" });

    expect(text.split("\n")[0]).toBe(SG);
    expect(text).toContain("(aws_security_group_rule.ssh moved to this address)");
    expect(text).toContain("Moved from: aws_security_group_rule.ssh");
  });

  it("mentions drift on the same resource", async () => {
    const fixture = harness();
    fixture.plan.drift = [
      { ...fixture.scoredChanges[0]!.change, changedPaths: [["backup_retention_period"]] },
    ];

    expect(await fixture.call("get_change", { address: DB })).toContain(
      "Drift: changed outside Terraform since the last apply (storage_encrypted, backup_retention_period)",
    );
  });

  it("says when an address does not change, or suggests similar ones", async () => {
    const { call } = harness();

    expect(await call("get_change", { address: NOOP })).toBe(`${NOOP} does not change in this plan (no-op).`);
    expect(await call("get_change", { address: "aws_db_instance.this" })).toBe(
      `No change with address aws_db_instance.this in this plan. Similar addresses: ${DB}.`,
    );
    expect(await call("get_change", { address: "nothing.here" })).toBe(
      "No change with address nothing.here in this plan. list_changes shows every change.",
    );
  });

  it("masks secret-looking values in plan data", async () => {
    const fixture = harness();
    fixture.scoredChanges[0]!.change.after = {
      ...(fixture.scoredChanges[0]!.change.after as object),
      storage_encrypted: AWS_KEY,
    };

    const text = await fixture.call("get_change", { address: DB });

    expectNoSecrets(text);
    expect(text).toContain("[REDACTED:aws_access_key_id]");
  });
});

// ---------------------------------------------------------------------------
// trace_cause
// ---------------------------------------------------------------------------

describe("trace_cause", () => {
  it("renders a candidate's known lineage without tracing it again", async () => {
    const { call, lineageCalls } = harness();

    const text = await call("trace_cause", { address: DB });

    expect(lineageCalls).toEqual([]);
    expect(text.split("\n")).toEqual([
      DB,
      "Lineage of storage_encrypted: explained by the PR's diff; root cause: s2",
      "  s0 resource_attribute @ modules/db/main.tf:4 aws_db_instance.this storage_encrypted: storage_encrypted = var.encrypted",
      '  s1 module_input @ main.tf:4 module "orders_db" argument encrypted: encrypted = var.orders_db_encrypted',
      "  s2 variable_value @ terraform.tfvars:1 [changed in this PR] orders_db_encrypted in terraform.tfvars: orders_db_encrypted = false",
      "Locations are repo-relative file:line at the PR head; (base) marks lines the PR deleted.",
    ]);
  });

  it("traces one attribute on demand, once", async () => {
    const { call, lineageCalls } = harness();

    await call("trace_cause", { address: DB, attribute: "tags.Name" });
    const again = await call("trace_cause", { address: DB, attribute: 'tags["Name"]' });

    expect(lineageCalls).toEqual([{ address: DB, attribute: ["tags", "Name"] }]);
    expect(again).toContain("Lineage of tags.Name: tracing stopped before an explanation");
  });

  it("traces the default attribute through the context when no lineage is known", async () => {
    const { call, lineageCalls } = harness({ known: false });

    const text = await call("trace_cause", { address: LOG_GROUP });

    expect(lineageCalls).toEqual([{ address: LOG_GROUP }]);
    expect(text).toContain("Lineage of whole resource: tracing stopped before an explanation");
    expect(text).toContain("  (no steps)");
    expect(text).toContain("  Note: no code found");
  });

  it("marks base-side locations of deleted code", async () => {
    const fixture = harness({ known: false });
    fixture.ctx.getLineage = async () => ({
      address: SG,
      attribute: [],
      steps: [
        {
          id: "s0",
          kind: "removed_code",
          modulePath: [],
          label: "removed resource block",
          references: [],
          location: { file: "network.tf", startLine: 3, endLine: 9, side: "base" },
          changedInDiff: true,
          upstreamAddress: DB,
        },
      ],
      rootCauseIds: ["s0"],
      explanation: "diff",
      notes: [],
    });

    const text = await fixture.call("trace_cause", { address: SG });

    expect(text).toContain(
      `s0 removed_code @ network.tf:3-9 (base) [changed in this PR] removed resource block (upstream change: ${DB})`,
    );
  });

  it("explains bad input instead of failing", async () => {
    const fixture = harness();
    fixture.ctx.getLineage = async () => null;

    expect(await fixture.call("trace_cause", { address: DB, attribute: "a..b" })).toMatch(
      /^Could not read the attribute path "a\.\.b"/,
    );
    expect(await fixture.call("trace_cause", { address: "nope.nope" })).toContain(
      "No change with address nope.nope",
    );
    expect(await fixture.call("trace_cause", { address: SG })).toBe(`No lineage could be traced for ${SG}.`);
  });

  it("does not cache a failed trace", async () => {
    const fixture = harness({ known: false });
    let attempts = 0;
    fixture.ctx.getLineage = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("parser crashed");
      return DB_LINEAGE;
    };

    await expect(fixture.call("trace_cause", { address: DB })).rejects.toThrow(
      "trace_cause failed: parser crashed",
    );
    expect(await fixture.call("trace_cause", { address: DB })).toContain("root cause: s2");
    expect(attempts).toBe(2);
    expect(fixture.calls.map((c) => c.ok)).toEqual([false, true]);
  });
});

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

describe("read_file", () => {
  it("returns numbered lines with credential values masked and line numbers intact", async () => {
    const { call } = harness();

    const text = await call("read_file", { path: "terraform.tfvars" });

    expect(text.split("\n")).toEqual([
      "terraform.tfvars, lines 1-3 of 3:",
      "1 | orders_db_encrypted = false",
      '2 | db_password = "(sensitive)"',
      expect.stringMatching(/^3 \| deploy_access_key = "(\(sensitive\)|\[REDACTED:[a-z_]+\])"$/),
    ]);
    expectNoSecrets(text);
  });

  it("masks credentials in comments too", async () => {
    const { call } = harness();

    const text = await call("read_file", { path: "./modules/db/main.tf", start_line: 6, end_line: 6 });

    expect(text).toBe(
      'modules/db/main.tf, lines 6-6 of 7; call again with start_line=7 for more:\n6 |   # master_password = "(sensitive)"',
    );
    expect(text).not.toContain(OLD_PASSWORD);
  });

  it("reads a range, clamps the end and pads line numbers", async () => {
    const files = { "big.tf": Array.from({ length: 400 }, (_, i) => `# line ${i + 1}`).join("\n") };
    const { call } = harness({ files });

    const first = await call("read_file", { path: "big.tf" });
    expect(first.split("\n")[0]).toBe(
      `big.tf, lines 1-${MAX_LINES_PER_READ} of 400; call again with start_line=${MAX_LINES_PER_READ + 1} for more:`,
    );
    expect(first.split("\n")[1]).toBe("  1 | # line 1");

    const tail = await call("read_file", { path: "big.tf", start_line: 398, end_line: 1000 });
    expect(tail.split("\n")).toEqual([
      "big.tf, lines 398-400 of 400:",
      "398 | # line 398",
      "399 | # line 399",
      "400 | # line 400",
    ]);

    expect(await call("read_file", { path: "big.tf", start_line: 500 })).toBe("big.tf has only 400 lines.");
    expect(await call("read_file", { path: "big.tf", start_line: 10, end_line: 5 })).toBe(
      "end_line must not be smaller than start_line.",
    );
  });

  it("clips very long lines and caps the whole result", async () => {
    const files = {
      "long.tf": `a = "${"x".repeat(2000)}"`,
      "wide.tf": Array.from({ length: 300 }, () => "y".repeat(400)).join("\n"),
    };
    const { call } = harness({ files });

    expect(await call("read_file", { path: "long.tf" })).toContain(" [... 1506 more chars]");
    const wide = await call("read_file", { path: "wide.tf" });
    expect(wide.length).toBeLessThanOrEqual(MAX_FILE_RESULT_CHARS);
    expect(wide).toContain("[truncated: the result exceeded");
  });

  it.each([
    ["../outside.tf", '"../outside.tf" is not a repository-relative file path.'],
    ["modules/../../etc/passwd", '"modules/../../etc/passwd" is not a repository-relative file path.'],
    [".", '"." is not a repository-relative file path.'],
    ["terraform.tfstate", "terraform.tfstate is not readable by this reviewer"],
    ["envs/prod/terraform.tfstate.backup", "is not readable by this reviewer"],
    [".env", "is not readable by this reviewer"],
    [".git/config", "is not readable by this reviewer"],
    ["keys/id_rsa", "is not readable by this reviewer"],
    ["plan.tfplan", "is not readable by this reviewer"],
    ["certs/server.pem", "is not readable by this reviewer"],
  ])("refuses %s", async (path, message) => {
    const { call, workspace } = harness();

    expect(await call("read_file", { path })).toContain(message);
    expect(workspace.reads).toEqual([]);
  });

  it.each([
    "x.tfstate.json",
    "x.tfstate.1700000000.backup",
    "x.tfstate.lock.info",
    "terraform.tfstate.d/dev/terraform.tfstate",
  ])("refuses the state copy %s", (path) => {
    expect(DENIED_FILES.some((re) => re.test(path))).toBe(true);
  });

  it("reads configuration that only has .tfstate in its name", async () => {
    const files = {
      ...FILES,
      "remote.tfstate.tf": 'data "x" "y" {}\n',
      "infra/shared.tfstate.tf.json": "{}",
    };
    const { call } = harness({ files });

    for (const path of [
      "remote.tfstate.tf",
      "infra/shared.tfstate.tf.json",
      "a.tfstate.tfvars",
      "b.tfstate.hcl",
    ])
      expect(DENIED_FILES.some((re) => re.test(path))).toBe(false);
    expect(await call("read_file", { path: "remote.tfstate.tf" })).toContain('data "x" "y" {}');
    expect(await call("search_repo", { pattern: "data" })).toContain("remote.tfstate.tf\n  1 | data");
  });

  it("refuses a plan or state JSON by its content, whatever its name, in read_file and search_repo", async () => {
    const plan = JSON.stringify(
      {
        format_version: "1.2",
        terraform_version: "1.10.5",
        variables: { api_token: { value: "correcthorsebattery" } },
        resource_changes: [],
      },
      null,
      2,
    );
    const state = JSON.stringify({
      version: 4,
      terraform_version: "1.10.5",
      serial: 1,
      lineage: "l",
      resources: [],
    });
    const files = { ...FILES, "plan.json": plan, "infra/state.tf.json": state, "plan.tfplan.json": "{}" };
    const { call } = harness({ files });

    for (const path of ["plan.json", "infra/state.tf.json", "plan.tfplan.json"]) {
      expect(await call("read_file", { path })).toBe(
        `${path} is not readable by this reviewer (state, plans, keys and credential files are off limits).`,
      );
    }
    const found = await call("search_repo", { pattern: "terraform_version", path_glob: "*" });
    expect(found).toContain("No matches");
    expect(found).not.toContain("correcthorsebattery");
  });

  it("points at files with the same name when a path is wrong", async () => {
    const { call } = harness();

    expect(await call("read_file", { path: "db/main.tf" })).toBe(
      "File not found or not readable at the PR head: db/main.tf. Files with the same name: main.tf, modules/db/main.tf. search_repo finds Terraform files.",
    );
  });

  it("does not show binary files or empty files", async () => {
    const { call } = harness({ files: { "blob.tf": "a\u0000b", "empty.tf": "" } });

    expect(await call("read_file", { path: "blob.tf" })).toBe("blob.tf looks like a binary file; not shown.");
    expect(await call("read_file", { path: "empty.tf" })).toBe("empty.tf is empty.");
  });

  it("masks a private key block without shifting line numbers", async () => {
    const key = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA1c7+9z5Pad7OejecsQ0bu3aumwP5qYnpE6EuE3FQ5U6jH+qd",
      "dGVzdC1rZXktbWF0ZXJpYWwtbm90LXJlYWwtdGVzdC1rZXktbWF0ZXJpYWwtbm90",
      "-----END RSA PRIVATE KEY-----",
    ];
    const files = { "tls.tf": ["locals {", "  pem = <<EOT", ...key, "EOT", "}", "# after"].join("\n") };
    const { call } = harness({ files });

    const text = await call("read_file", { path: "tls.tf" });

    expect(text).not.toContain("MIIEowIBAAKCAQEA");
    expect(text).toContain("9 | # after");
    expect(text.split("\n")[0]).toBe("tls.tf, lines 1-9 of 9:");
  });

  it("caches a file between calls", async () => {
    const { call, workspace } = harness();

    await call("read_file", { path: "main.tf", start_line: 1, end_line: 2 });
    await call("read_file", { path: "main.tf", start_line: 3 });

    expect(workspace.reads.filter((p) => p === "main.tf")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// search_repo
// ---------------------------------------------------------------------------

describe("search_repo", () => {
  it("searches the root module and its local modules, grouped by file", async () => {
    const { call } = harness();

    const text = await call("search_repo", { pattern: "ENCRYPTED" });

    expect(text.split("\n")[0]).toBe(
      '5 matches in 5 files for "ENCRYPTED" (searched 6 files in ., modules/db):',
    );
    expect(text).toContain("main.tf\n  4 | encrypted = var.orders_db_encrypted");
    expect(text).toContain("modules/db/main.tf\n  4 | storage_encrypted = var.encrypted");
    expect(text).toContain("terraform.tfvars\n  1 | orders_db_encrypted = false");
    // Not referenced by the plan: not searched.
    expect(text).not.toContain("modules/other");
  });

  it("never matches or shows a secret value", async () => {
    const { call } = harness();

    const byValue = await call("search_repo", { pattern: DB_PASSWORD });
    expect(byValue).toMatch(/^No matches for/);
    const byName = await call("search_repo", { pattern: "password" });
    expectNoSecrets(byName);
    expect(byName).toContain('2 | db_password = "(sensitive)"');
    expect(await call("search_repo", { pattern: "state-file-secret" })).toMatch(/^No matches/);
  });

  it("supports regular expressions and path globs", async () => {
    const { call } = harness();

    const regex = await call("search_repo", { pattern: '^variable\\s+"(encrypted|password)"', regex: true });
    expect(regex).toContain("2 matches in 1 files");
    expect(regex).toContain("modules/db/variables.tf");

    const tfvars = await call("search_repo", { pattern: "=", path_glob: "*.tfvars" });
    expect(tfvars).toContain("(searched 1 files in ., modules/db)");
    const nested = await call("search_repo", { pattern: "resource", path_glob: "modules/**/*.tf" });
    expect(nested).toContain("1 matches in 1 files");
    expect(nested).toContain("modules/db/main.tf");
  });

  it("refuses empty, oversized, invalid and catastrophic patterns", async () => {
    const { call } = harness();

    expect(await call("search_repo", { pattern: "  " })).toMatch(/^The pattern is empty/);
    expect(await call("search_repo", { pattern: "x".repeat(201) })).toMatch(/longer than 200 characters/);
    expect(await call("search_repo", { pattern: "(", regex: true })).toMatch(/^Invalid regular expression/);
    expect(await call("search_repo", { pattern: "(a+)+$", regex: true })).toMatch(
      /backtrack catastrophically/,
    );
    expect(await call("search_repo", { pattern: "(a|aa)*b", regex: true })).toMatch(
      /backtrack catastrophically/,
    );
    expect(await call("search_repo", { pattern: "(a)\\1", regex: true })).toMatch(
      /backtrack catastrophically/,
    );
  });

  it("caps the hits it shows", async () => {
    const files = { "many.tf": Array.from({ length: 100 }, (_, i) => `# hit ${i}`).join("\n") };
    const { call } = harness({ files });

    const text = await call("search_repo", { pattern: "hit" });

    expect(text.split("\n")[0]).toBe(
      `100 matches in 1 files for "hit" (searched 1 files in ., modules/db); showing the first ${MAX_SEARCH_HITS}:`,
    );
    expect(text.split("\n").filter((l) => l.startsWith("  "))).toHaveLength(MAX_SEARCH_HITS);
  });

  it("includes modules terraform init recorded and directories the PR changed", async () => {
    const files = {
      ...FILES,
      ".terraform/modules/modules.json": JSON.stringify({
        Modules: [
          { Key: "", Dir: "." },
          { Key: "vpc", Dir: ".terraform/modules/vpc" },
        ],
      }),
      ".terraform/modules/vpc/main.tf": 'resource "aws_vpc" "this" {}\n',
      "envs/prod/extra.tf": 'resource "aws_sns_topic" "alerts" {}\n',
    };
    const diffText =
      "diff --git a/envs/prod/extra.tf b/envs/prod/extra.tf\n--- a/envs/prod/extra.tf\n+++ b/envs/prod/extra.tf\n@@ -0,0 +1 @@\n+x\n";
    const { ctx, call } = harness({ files, diffText });

    expect(await searchDirectories(ctx)).toEqual(["", "modules/db", ".terraform/modules/vpc", "envs/prod"]);
    const text = await call("search_repo", { pattern: "aws_" });
    expect(text).toContain(".terraform/modules/vpc/main.tf");
    expect(text).toContain("envs/prod/extra.tf");
  });

  it("resolves module sources relative to a nested root module and ignores remote ones", async () => {
    const fixture = harness({ rootModuleDir: "stacks/app/" });
    fixture.plan.modules = {
      "": { path: [], resources: {}, moduleCalls: {}, variables: {}, outputs: {} },
      net: {
        path: ["net"],
        source: "../../modules/net",
        resources: {},
        moduleCalls: {},
        variables: {},
        outputs: {},
      },
      "net.subnets": {
        path: ["net", "subnets"],
        source: "./subnets",
        resources: {},
        moduleCalls: {},
        variables: {},
        outputs: {},
      },
      vpc: {
        path: ["vpc"],
        source: "terraform-aws-modules/vpc/aws",
        resources: {},
        moduleCalls: {},
        variables: {},
        outputs: {},
      },
      "vpc.inner": {
        path: ["vpc", "inner"],
        source: "./inner",
        resources: {},
        moduleCalls: {},
        variables: {},
        outputs: {},
      },
    };

    expect(await searchDirectories({ ...fixture.ctx, diffText: null })).toEqual([
      "stacks/app",
      "modules/net",
      "modules/net/subnets",
    ]);
  });
});

// ---------------------------------------------------------------------------
// get_diff
// ---------------------------------------------------------------------------

describe("get_diff", () => {
  it("lists the changed files, then the masked diff", async () => {
    const { call } = harness();

    const text = await call("get_diff", {});

    expect(text.split("\n").slice(0, 3)).toEqual([
      "Changed files (2):",
      "- terraform.tfvars (+1 -1)",
      "- network.tf (+7 -0)",
    ]);
    expect(text).toContain("+orders_db_encrypted = false");
    expect(text).toContain(' db_password = "(sensitive)"');
    expectNoSecrets(text);
  });

  it("shows one file's hunks", async () => {
    const { call } = harness();

    const text = await call("get_diff", { path: "./network.tf" });

    expect(text.split("\n")[0]).toBe("diff --git a/network.tf b/network.tf");
    expect(text).toContain('+  cidr_blocks = ["0.0.0.0/0"]');
    expect(text).not.toContain("terraform.tfvars");
  });

  it("says when a file is not in the diff or the diff is missing", async () => {
    expect(await harness().call("get_diff", { path: "main.tf" })).toBe(
      "main.tf is not changed in this PR. Changed files:\n- terraform.tfvars (+1 -1)\n- network.tf (+7 -0)",
    );
    expect(await harness({ diffText: null }).call("get_diff", {})).toBe(
      "The PR diff is not available for this run.",
    );
    expect(await harness({ diffText: "" }).call("get_diff", {})).toBe("The PR diff is empty.");
  });

  it("finds a renamed file by its old path", async () => {
    const diffText = [
      "diff --git a/old.tf b/new.tf",
      "similarity index 90%",
      "rename from old.tf",
      "rename to new.tf",
      "--- a/old.tf",
      "+++ b/new.tf",
      "@@ -1 +1 @@",
      "-a = 1",
      "+a = 2",
      "",
    ].join("\n");
    const { call } = harness({ diffText });

    expect(await call("get_diff", {})).toContain("- new.tf (from old.tf) (+1 -1)");
    expect(await call("get_diff", { path: "old.tf" })).toContain("+a = 2");
  });

  it("keeps denied files in the listing but not their hunks: credentials, state, plans by name or content", async () => {
    const planLine = JSON.stringify({
      format_version: "1.2",
      terraform_version: "1.10.5",
      variables: { api_token: { value: "correcthorsebattery" } },
    });
    const section = (path: string, body: string[], header: string[] = []) => [
      `diff --git a/${path} b/${path}`,
      ...header,
      "--- /dev/null",
      `+++ b/${path}`,
      `@@ -0,0 +1,${body.length} @@`,
      ...body.map((l) => `+${l}`),
    ];
    const diffText = [
      ...section(".env", ["PLAIN=Plain-Env-Secret-91"], ["new file mode 100644"]),
      ...section("terraform.tfstate", ['  "value": "x-correcthorsebattery",']),
      ...section("infra/plan.json", [planLine]),
      // A partial hunk of a pretty-printed plan: plan-only keys give it away.
      ...section("out/review-input.json", [
        '      "after_sensitive": {},',
        '      "after": {"pin": "k9-pin!"}',
      ]),
      ...section("main.tf", ['locals { a = "ok-visible" }']),
      "",
    ].join("\n");
    const { call } = harness({ diffText });

    const whole = await call("get_diff", {});
    expect(whole).toContain("- .env (+1 -0)");
    expect(whole).toContain("- infra/plan.json (+1 -0)");
    expect(whole).toContain('+locals { a = "ok-visible" }');
    expect(
      whole.match(/\[changed lines not shown: state, plans, keys and credential files are off limits\]/g),
    ).toHaveLength(4);
    for (const leaked of ["Plain-Env-Secret-91", "correcthorsebattery", "k9-pin!"]) {
      expect(whole).not.toContain(leaked);
    }
    for (const path of [".env", "terraform.tfstate", "infra/plan.json", "out/review-input.json"]) {
      const one = await call("get_diff", { path });
      expect(one).toContain(`+++ b/${path}`);
      expect(one).toContain("[changed lines not shown:");
      expect(one).not.toMatch(/correcthorsebattery|Plain-Env|k9-pin/);
    }
  });

  it("caps a huge diff", async () => {
    const body = Array.from({ length: 3000 }, (_, i) => `+line_${i} = ${i}`).join("\n");
    const diffText = `diff --git a/big.tf b/big.tf\n--- a/big.tf\n+++ b/big.tf\n@@ -0,0 +1,3000 @@\n${body}\n`;

    const text = await harness({ diffText }).call("get_diff", {});

    expect(text.length).toBeLessThanOrEqual(MAX_FILE_RESULT_CHARS);
    expect(text).toContain("[truncated: the result exceeded");
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe("parseAttrPath", () => {
  it.each([
    ["storage_encrypted", ["storage_encrypted"]],
    ["ingress[0].cidr_blocks", ["ingress", 0, "cidr_blocks"]],
    ["ingress.0.cidr_blocks", ["ingress", 0, "cidr_blocks"]],
    ['tags["Name"]', ["tags", "Name"]],
    ['tags["kubernetes.io/role"]', ["tags", "kubernetes.io/role"]],
    [" tags.Name ", ["tags", "Name"]],
    ["", null],
    ["a..b", null],
    ["[", null],
    ['tags["unterminated]', null],
  ])("%j → %j", (text, expected) => {
    expect(parseAttrPath(text)).toEqual(expected);
  });
});

describe("normalizeRepoPath", () => {
  it.each([
    ["./main.tf", "main.tf"],
    ["/modules/db/", "modules/db"],
    ["modules\\db\\main.tf", "modules/db/main.tf"],
    [".", ""],
    ["../x", null],
    ["a/../../x", null],
  ])("%j → %j", (path, expected) => {
    expect(normalizeRepoPath(path)).toBe(expected);
  });
});

describe("capResult", () => {
  it("leaves short text alone and cuts long text at a line boundary with a note", () => {
    expect(capResult("short", 100)).toBe("short");
    const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const capped = capResult(long, 500);
    expect(capped.length).toBeLessThanOrEqual(500);
    expect(capped).toMatch(/line \d+\n\[truncated: the result exceeded 500 characters\./);
    expect(MAX_TOOL_RESULT_CHARS).toBeLessThan(MAX_FILE_RESULT_CHARS);
  });

  it("never splits a surrogate pair", () => {
    const text = `${"x".repeat(9)}\u{1F680}${"y".repeat(500)}`;
    const capped = capResult(text, 150);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(capped)).toBe(false);
  });
});

describe("maskLines", () => {
  it("keeps the line count while masking", () => {
    const lines = [`password = "${DB_PASSWORD}"`, "ok = true", `key = "${AWS_KEY}"`];
    const masked = maskLines(lines);
    expect(masked).toHaveLength(3);
    expect(masked[0]).toBe('password = "(sensitive)"');
    expect(masked[1]).toBe("ok = true");
    expect(masked.join("\n")).not.toContain(AWS_KEY);
  });
});
