import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PlanError, decodePlanBytes, loadPlan, normalizeAction, parsePlanText } from "../../src/plan/load.js";
import { SENSITIVE_PLACEHOLDER, type ResourceChange } from "../../src/types.js";

const S = SENSITIVE_PLACEHOLDER;

/*
 * Fixtures under test/fixtures/plan are real `terraform show -json` output (terraform 1.10.5,
 * built-in terraform_data only, so they were made offline; `timestamp` dropped):
 * - lifecycle.json: moved block (new_name), removed block with destroy = false (forget_me),
 *   create_before_destroy + triggers_replace (cbd), destroy-before-create (dbd), -replace (by_request),
 *   tainted, count shrink (counted[2]), removed resource and module, sensitive variable/output/input,
 *   a for_each module with a sensitive argument, a data source read deferred to apply.
 * - import.json: import blocks (no-op and update while importing).
 * - modules.json: nested modules (for_each → count) removed, variable default with a token.
 * - foreach.json: for_each / count on module calls and resources referencing a variable.
 * - deposed.json: a create_before_destroy leftover (deposed object added to state by hand).
 * - state.json: `terraform show -json` of a state file (not a plan).
 * - human-plan.txt: human-readable `terraform plan` output.
 */
const fixtureText = (name: string): string =>
  readFileSync(new URL(`../fixtures/plan/${name}`, import.meta.url), "utf8");
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(fixtureText(name)) as Record<string, unknown>;
const dbPlanText = (): string =>
  readFileSync(new URL("../../evals/fixtures/db-encryption-replace/plan.json", import.meta.url), "utf8");

const byAddress = (changes: ResourceChange[], address: string): ResourceChange => {
  const found = changes.find((c) => c.address === address);
  if (!found) throw new Error(`no change ${address}`);
  return found;
};

const expectPlanError = (fn: () => unknown, message: RegExp): void => {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(PlanError);
  expect((caught as Error).name).toBe("PlanError");
  expect((caught as Error).message).toMatch(message);
};

// ───────────────────────────── parsePlanText ─────────────────────────────

describe("parsePlanText", () => {
  it("parses plain `terraform show -json` output", () => {
    const text = fixtureText("import.json");
    expect(parsePlanText(text)).toEqual(JSON.parse(text));
  });

  it("tolerates surrounding whitespace and a UTF-8 BOM", () => {
    const text = fixtureText("import.json");
    expect(parsePlanText(`﻿\n  ${text}\n\n`)).toEqual(JSON.parse(text));
  });

  it("strips hashicorp/setup-terraform wrapper noise", () => {
    const json = fixtureText("lifecycle.json").trim();
    const wrapped = [
      "[command]/home/runner/work/_temp/3b1d2c/terraform-bin show -json plan.out",
      json,
      "::debug::Terraform exited with code 0.",
      `::debug::stdout: ${json.slice(0, 200).replace(/\n/g, "%0A")}`,
      "::debug::stderr: ",
      "::debug::exitcode: 0",
    ].join("\n");
    expect(parsePlanText(wrapped)).toEqual(JSON.parse(json));
  });

  it("finds a pretty-printed plan among other JSON lines, preferring the plan", () => {
    const plan = JSON.parse(fixtureText("import.json")) as unknown;
    const text = [
      '{"@level":"info","@message":"Terraform 1.10.5","type":"version"}',
      "some stderr line with a { brace",
      JSON.stringify(plan, null, 2),
      "Error: exit status 0",
    ].join("\n");
    expect(parsePlanText(text)).toEqual(plan);
  });

  it("handles braces and escaped quotes inside JSON strings when locating the object", () => {
    const plan = { format_version: "1.2", resource_changes: [], note: 'a } brace and a \\" quote {' };
    expect(parsePlanText(`noise\n${JSON.stringify(plan)}\ntrailer }`)).toEqual(plan);
  });

  it("returns a non-plan object found in noise so loadPlan can explain what it is", () => {
    expect(parsePlanText('[command]x\n{"hello":"world"}\ndone')).toEqual({ hello: "world" });
    expectPlanError(() => loadPlan(parsePlanText('[command]x\n{"hello":"world"}')), /Not a Terraform plan/);
  });

  it("decodes UTF-16 plan bytes (Windows PowerShell 5.1 `>` redirection), with or without a BOM", () => {
    const text = fixtureText("import.json");
    const le = Buffer.from(text, "utf16le");
    const be = Buffer.from(le).swap16();
    const expected = JSON.parse(text) as unknown;
    expect(parsePlanText(Buffer.concat([Buffer.from([0xff, 0xfe]), le]))).toEqual(expected);
    expect(parsePlanText(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).toEqual(expected);
    expect(parsePlanText(le)).toEqual(expected);
    expect(parsePlanText(be)).toEqual(expected);
    expect(parsePlanText(Buffer.from(`\ufeff${text}`, "utf8"))).toEqual(expected);
    expect(
      decodePlanBytes(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"é":1}', "utf16le")])),
    ).toBe('{"é":1}');
  });

  it("names the encoding when UTF-16 plan text was read as UTF-8", () => {
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(fixtureText("import.json"), "utf16le"),
    ]);
    expectPlanError(() => parsePlanText(bytes.toString("utf8")), /UTF-16 encoded.*Out-File -Encoding utf8/);
    // No BOM: the NUL bytes give it away.
    expectPlanError(() => parsePlanText(bytes.subarray(2).toString("utf8")), /UTF-16 encoded/);
  });

  it("rejects empty input", () => {
    expectPlanError(() => parsePlanText(""), /empty/);
    expectPlanError(() => parsePlanText(" \n\t﻿ "), /empty/);
  });

  it("rejects a binary plan file with the conversion command", () => {
    expectPlanError(
      () => parsePlanText("PK\u0003\u0004\u0014\u0000\u0008binarystuff"),
      /binary plan file.*show -json/,
    );
  });

  it("rejects human-readable plan output", () => {
    expectPlanError(() => parsePlanText(fixtureText("human-plan.txt")), /human-readable plan output/);
    expectPlanError(
      () => parsePlanText("OpenTofu will perform the following actions:\n  # x will be created"),
      /human-readable/,
    );
    expectPlanError(
      () => parsePlanText("No changes. Your infrastructure matches the configuration."),
      /human/,
    );
  });

  it("rejects state JSON (terraform show -json of state, and a raw .tfstate)", () => {
    expectPlanError(() => parsePlanText(fixtureText("state.json")), /state, not a plan/);
    const tfstate = JSON.stringify({ version: 4, serial: 3, lineage: "abc", resources: [], outputs: {} });
    expectPlanError(() => parsePlanText(tfstate), /state, not a plan/);
    expectPlanError(() => parsePlanText(`[command]terraform show -json\n${tfstate}`), /state, not a plan/);
  });

  it("reports truncated JSON without quoting the input", () => {
    const text = '{"format_version":"1.2","variables":{"db_password":{"value":"hunter2-secret';
    let message = "";
    try {
      parsePlanText(text);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/invalid or truncated/);
    expect(message).not.toContain("hunter2");
  });

  it("rejects text without any JSON object", () => {
    expectPlanError(() => parsePlanText("just some words"), /Could not find a JSON plan/);
    expectPlanError(
      () => parsePlanText("[command]terraform show -json\n::debug::exitcode: 1"),
      /Could not find/,
    );
  });

  it("returns non-object JSON as is (loadPlan rejects it)", () => {
    expect(parsePlanText("[1,2]")).toEqual([1, 2]);
    expectPlanError(() => loadPlan(parsePlanText("[1,2]")), /must be an object/);
  });

  it("stays fast on large noisy input", () => {
    const noise = "{ not json\n".repeat(20_000);
    const start = performance.now();
    expectPlanError(() => parsePlanText(noise), /invalid or truncated|Could not find/);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

// ───────────────────────────── loadPlan: validation ─────────────────────────────

describe("loadPlan: validation", () => {
  it("rejects non-objects", () => {
    for (const input of [null, undefined, 1, "plan", [], true]) {
      expectPlanError(() => loadPlan(input), /must be an object/);
    }
  });

  it("rejects state and other non-plan objects with a clear message", () => {
    expectPlanError(() => loadPlan(fixture("state.json")), /state, not a plan/);
    expectPlanError(() => loadPlan({ format_version: "1.2" }), /no resource_changes or planned_values/);
  });

  it("requires format_version", () => {
    expectPlanError(() => loadPlan({ resource_changes: [] }), /format_version/);
  });

  it("rejects resource_changes that is not a list", () => {
    expectPlanError(() => loadPlan({ format_version: "1.2", resource_changes: {} }), /not a list/);
  });

  it("accepts every format version terraform and OpenTofu have shipped", () => {
    for (const fv of ["0.1", "0.2", "1.0", "1.1", "1.2", "1.3", 1]) {
      const m = loadPlan({ format_version: fv, planned_values: {} });
      expect(m.formatVersion).toBe(String(fv));
      expect(m.changes).toEqual([]);
      expect(m.terraformVersion).toBe("unknown");
    }
  });

  it("rejects a format_version major it does not know, naming the version", () => {
    for (const fv of ["2.0", "10.1", 2, "", "v1"]) {
      expectPlanError(
        () => loadPlan({ format_version: fv, planned_values: {} }),
        /Unsupported plan format_version/,
      );
    }
    expectPlanError(
      () => loadPlan({ format_version: "2.0", resource_changes: [] }),
      /format_version "2\.0".*0\.x and 1\.x/,
    );
  });

  it("loads an OpenTofu-shaped plan", () => {
    const m = loadPlan({
      format_version: "1.2",
      terraform_version: "1.8.3",
      planned_values: { root_module: {} },
      resource_changes: [
        {
          address: "aws_s3_bucket.b",
          mode: "managed",
          type: "aws_s3_bucket",
          name: "b",
          provider_name: "registry.opentofu.org/hashicorp/aws",
          change: { actions: ["create"], before: null, after: { bucket: "b" }, after_unknown: { id: true } },
        },
      ],
      configuration: { provider_config: { aws: { name: "aws", version_constraint: ">= 5.0" } } },
      errored: false,
    });
    expect(m.terraformVersion).toBe("1.8.3");
    expect(m.changes[0]).toMatchObject({
      action: "create",
      providerName: "registry.opentofu.org/hashicorp/aws",
      after: { bucket: "b" },
      afterUnknown: { id: true },
    });
    expect(m.providerConstraints).toEqual({ aws: ">= 5.0" });
  });

  it("skips malformed resource change entries instead of throwing", () => {
    const m = loadPlan({
      format_version: "1.2",
      resource_changes: [
        null,
        42,
        { change: { actions: ["create"] } },
        { address: "terraform_data.ok", change: null },
        { address: "terraform_data.weird", change: { actions: "create", replace_paths: "x" } },
      ],
      resource_drift: "nope",
      output_changes: [],
      variables: null,
      configuration: { root_module: { resources: [null, { type: "x" }], module_calls: { m: null } } },
    });
    expect(m.changes.map((c) => c.address)).toEqual(["terraform_data.ok", "terraform_data.weird"]);
    expect(m.changes[0]).toMatchObject({
      action: "no-op",
      actions: [],
      before: null,
      after: null,
      replacePaths: [],
      changedPaths: [],
      type: "terraform_data",
      name: "ok",
      mode: "managed",
      moduleAddress: null,
      configModulePath: [],
    });
    expect(m.drift).toEqual([]);
    expect(m.outputChanges).toEqual([]);
    expect(m.variables).toEqual({});
    expect(m.modules[""]?.resources).toEqual({});
    expect(m.counts).toEqual({});
  });

  it("carries errored", () => {
    expect(loadPlan({ format_version: "1.2", planned_values: {}, errored: true }).errored).toBe(true);
    expect(loadPlan({ format_version: "1.2", planned_values: {} }).errored).toBe(false);
  });

  it("does not mutate its input", () => {
    const raw = fixture("lifecycle.json");
    const copy = structuredClone(raw);
    loadPlan(raw);
    expect(raw).toEqual(copy);
  });
});

// ───────────────────────────── loadPlan: actions ─────────────────────────────

describe("normalizeAction", () => {
  it.each([
    [["create"], {}, "create", undefined],
    [["delete"], {}, "delete", undefined],
    [["update"], {}, "update", undefined],
    [["read"], {}, "read", undefined],
    [["no-op"], {}, "no-op", undefined],
    [[], {}, "no-op", undefined],
    [["delete", "create"], {}, "replace", "destroy-before-create"],
    [["create", "delete"], {}, "replace", "create-before-destroy"],
    [["forget"], {}, "forget", undefined],
    [["create", "forget"], {}, "forget", undefined],
    [["forget", "create"], {}, "forget", undefined],
    [["no-op"], { moved: true }, "move", undefined],
    [["no-op"], { importing: true }, "import", undefined],
    [["no-op"], { importing: true, moved: true }, "import", undefined],
    [["update"], { importing: true }, "import", undefined],
    [["update"], { moved: true }, "update", undefined],
    [["delete", "update", "create"], {}, "replace", "destroy-before-create"],
    [["create", "read", "delete"], {}, "replace", "create-before-destroy"],
    [["something-new"], {}, "update", undefined],
  ] as const)("%j %j → %s %s", (actions, opts, action, order) => {
    const out = normalizeAction(actions, opts);
    expect(out.action).toBe(action);
    expect(out.replaceOrder).toBe(order);
  });
});

describe("loadPlan: real lifecycle plan (terraform_data)", () => {
  const plan = loadPlan(fixture("lifecycle.json"));
  const get = (address: string) => byAddress(plan.changes, address);

  it("reads versions and keeps every change, no-ops included", () => {
    expect(plan.formatVersion).toBe("1.2");
    expect(plan.terraformVersion).toBe("1.10.5");
    expect(plan.errored).toBe(false);
    expect(plan.changes).toHaveLength(16);
    expect(plan.changes.filter((c) => c.action === "no-op").map((c) => c.address)).toEqual([
      "terraform_data.counted[0]",
      "terraform_data.counted[1]",
    ]);
  });

  it("normalizes replacements with their order and reason", () => {
    expect(get("terraform_data.dbd")).toMatchObject({
      actions: ["delete", "create"],
      action: "replace",
      replaceOrder: "destroy-before-create",
      actionReason: "replace_because_cannot_update",
      replacePaths: [["triggers_replace"]],
      changedPaths: [["triggers_replace"]],
    });
    expect(get("terraform_data.cbd")).toMatchObject({
      actions: ["create", "delete"],
      action: "replace",
      replaceOrder: "create-before-destroy",
      replacePaths: [["triggers_replace"]],
    });
    expect(get("terraform_data.by_request")).toMatchObject({
      action: "replace",
      actionReason: "replace_by_request",
      replacePaths: [],
      changedPaths: [],
    });
    expect(get("terraform_data.tainted")).toMatchObject({
      action: "replace",
      actionReason: "replace_because_tainted",
    });
  });

  it("marks computed attributes of a replacement as unknown", () => {
    expect(get("terraform_data.cbd").unknownPaths).toEqual([["id"], ["output"]]);
  });

  it("recognizes moved, forgotten, removed and count-shrunk resources", () => {
    expect(get("terraform_data.new_name")).toMatchObject({
      actions: ["no-op"],
      action: "move",
      previousAddress: "terraform_data.old_name",
    });
    expect(get("terraform_data.forget_me")).toMatchObject({ actions: ["forget"], action: "forget" });
    expect(get("terraform_data.gone")).toMatchObject({
      action: "delete",
      actionReason: "delete_because_no_resource_config",
    });
    expect(get("terraform_data.counted[2]")).toMatchObject({
      action: "delete",
      actionReason: "delete_because_count_index",
      index: 2,
      name: "counted",
    });
    expect(get("module.removed_mod.terraform_data.this")).toMatchObject({
      action: "delete",
      moduleAddress: "module.removed_mod",
      configModulePath: ["removed_mod"],
    });
  });

  it("recognizes a deferred data source read", () => {
    expect(get("data.terraform_remote_state.deferred")).toMatchObject({
      mode: "data",
      type: "terraform_remote_state",
      name: "deferred",
      action: "read",
      actionReason: "read_because_config_unknown",
    });
  });

  it("fills module addresses for module instances", () => {
    expect(get('module.child["a"].terraform_data.this')).toMatchObject({
      moduleAddress: 'module.child["a"]',
      configModulePath: ["child"],
      type: "terraform_data",
      name: "this",
      providerName: "terraform.io/builtin/terraform",
    });
  });

  it("counts non-no-op changes by action", () => {
    expect(plan.counts).toEqual({ read: 1, replace: 4, delete: 3, forget: 1, create: 1, move: 1, update: 3 });
    expect(plan.counts["no-op"]).toBeUndefined();
  });

  it("computes changed paths on raw values and hides the values", () => {
    const holder = get("terraform_data.secret_holder");
    // Both sides are sensitive and differ: the path is reported, the values are not.
    expect(holder.changedPaths).toEqual([["input"]]);
    expect(holder.sensitiveChangedPaths).toEqual([["input"]]);
    expect(holder.before).toMatchObject({ input: S, output: S });
    expect(holder.after).toMatchObject({ input: S });

    const child = get('module.child["a"].terraform_data.this');
    expect(child.changedPaths).toEqual([["input", "pw"]]);
    expect(child.sensitiveChangedPaths).toEqual([["input", "pw"]]);
    expect((child.after as { input: { pw: unknown } }).input.pw).toBe(S);
  });

  it("does not report sensitive paths for an ordinary update", () => {
    const update = get("terraform_data.update");
    expect(update.changedPaths).toEqual([
      ["input", "plain"],
      ["input", "size"],
    ]);
    expect(update.sensitiveChangedPaths).toEqual([]);
    // unmarked but credential-named: hidden by the name heuristic
    expect(update.before).toMatchObject({ input: { password: S, plain: "p1", size: 1 } });
  });

  it("masks sensitive variables and outputs and keeps the plain ones", () => {
    expect(plan.variables).toEqual({
      db_password: { value: S, sensitive: true },
      plain: { value: "p2", sensitive: false },
    });
    expect(plan.outputChanges).toEqual([
      { name: "plain_out", actions: ["update"], sensitive: false },
      { name: "secret_out", actions: ["update"], sensitive: true },
    ]);
  });

  it("indexes the configuration per module", () => {
    expect(Object.keys(plan.modules).sort()).toEqual(["", "child"]);
    const root = plan.modules[""]!;
    expect(root.path).toEqual([]);
    expect(root.source).toBeUndefined();
    expect(Object.keys(root.resources)).toContain("data.terraform_remote_state.deferred");
    expect(root.resources["terraform_data.counted"]).toMatchObject({
      mode: "managed",
      type: "terraform_data",
      name: "counted",
      countExpression: { constant_value: 2 },
      expressions: { input: { references: ["count.index"] } },
    });
    expect(root.resources["terraform_data.cbd"]?.expressions).toEqual({
      input: { constant_value: "x" },
      triggers_replace: { constant_value: ["v2"] },
    });
    expect(root.moduleCalls.child).toEqual({
      name: "child",
      source: "./child",
      expressions: { name: { references: ["each.key"] }, password: { references: ["var.db_password"] } },
    });
    expect(root.variables).toEqual({
      db_password: { default: S, sensitive: true },
      plain: { default: "p2" },
    });
    expect(root.outputs.secret_out).toEqual({
      expression: { references: ["var.db_password"] },
      sensitive: true,
    });

    const child = plan.modules.child!;
    expect(child).toMatchObject({ path: ["child"], source: "./child" });
    expect(child.variables).toEqual({ name: {}, password: { sensitive: true } });
    expect(Object.keys(child.resources)).toEqual(["terraform_data.this"]);
  });

  it("never exposes a secret from the fixture", () => {
    const text = JSON.stringify(plan);
    for (const secret of [
      "v1-secret-value-AAA",
      "v2-secret-value-BBB",
      "plain-in-map-123",
      "zzz-password-999",
    ]) {
      expect(text, secret).not.toContain(secret);
    }
  });
});

describe("loadPlan: other real plans", () => {
  it("import blocks: no-op and update while importing", () => {
    const plan = loadPlan(fixture("import.json"));
    expect(byAddress(plan.changes, "terraform_data.imported")).toMatchObject({
      actions: ["no-op"],
      action: "import",
      importing: { id: "ext-123" },
    });
    expect(byAddress(plan.changes, "terraform_data.imported_update")).toMatchObject({
      actions: ["update"],
      action: "import",
      importing: { id: "ext-456" },
      changedPaths: [["input"]],
    });
    // As in Terraform's "Plan: 2 to import, 0 to add, 1 to change": the import+update also counts as a change.
    expect(plan.counts).toEqual({ import: 2, update: 1 });
  });

  it("nested modules: removed for_each module, nested count module, masked defaults", () => {
    const plan = loadPlan(fixture("modules.json"));
    expect(byAddress(plan.changes, 'module.svc["b"].module.inner[0].terraform_data.leaf')).toMatchObject({
      action: "delete",
      actionReason: "delete_because_no_module",
      moduleAddress: 'module.svc["b"].module.inner[0]',
      configModulePath: ["svc", "inner"],
    });
    expect(plan.counts).toEqual({ delete: 2 });
    expect(Object.keys(plan.modules).sort()).toEqual(["", "svc", "svc.inner"]);
    expect(plan.modules.svc).toMatchObject({ path: ["svc"], source: "./svc" });
    expect(plan.modules.svc?.variables.api_token).toEqual({ default: S });
    expect(plan.modules.svc?.moduleCalls.inner).toMatchObject({
      source: "./inner",
      countExpression: { constant_value: 1 },
      expressions: { tag: { references: ["var.key"] } },
    });
    expect(plan.modules["svc.inner"]).toMatchObject({ path: ["svc", "inner"], source: "./inner" });
    expect(JSON.stringify(plan)).not.toContain("svc-default-token-Q7");
    expect(JSON.stringify(plan)).not.toContain("inline-client-secret-77");
  });

  it("for_each and count expressions on module calls and resources", () => {
    const plan = loadPlan(fixture("foreach.json"));
    const root = plan.modules[""]!;
    expect(root.moduleCalls.m).toMatchObject({ forEachExpression: { references: ["var.names"] } });
    expect(root.moduleCalls.m?.countExpression).toBeUndefined();
    expect(root.moduleCalls.c).toMatchObject({ countExpression: { references: ["var.names"] } });
    expect(root.resources["terraform_data.r"]).toMatchObject({
      forEachExpression: { references: ["var.names"] },
    });
    expect(byAddress(plan.changes, 'module.m["a"].terraform_data.x')).toMatchObject({
      action: "create",
      moduleAddress: 'module.m["a"]',
      configModulePath: ["m"],
    });
    expect(byAddress(plan.changes, 'terraform_data.r["b"]')).toMatchObject({ index: "b", action: "create" });
    expect(byAddress(plan.changes, "module.c[1].terraform_data.x").configModulePath).toEqual(["c"]);
    expect(plan.counts).toEqual({ create: 6 });
  });

  it("deposed objects left by create_before_destroy", () => {
    const plan = loadPlan(fixture("deposed.json"));
    const deposed = plan.changes.find((c) => c.deposed !== undefined);
    expect(deposed).toMatchObject({
      address: "terraform_data.cbd",
      deposed: "00000001",
      action: "delete",
      before: { id: "old-id-1", input: "v1" },
    });
    const current = plan.changes.find((c) => c.deposed === undefined);
    expect(current?.action).toBe("no-op");
    expect(plan.counts).toEqual({ delete: 1 });
  });
});

describe("loadPlan: real AWS plan (db-encryption-replace)", () => {
  const plan = loadPlan(parsePlanText(dbPlanText()));

  it("finds the database replacement and the attribute that forces it", () => {
    const db = byAddress(plan.changes, "module.orders_db.aws_db_instance.this");
    expect(db).toMatchObject({
      action: "replace",
      replaceOrder: "destroy-before-create",
      actionReason: "replace_because_cannot_update",
      replacePaths: [["storage_encrypted"]],
      moduleAddress: "module.orders_db",
      configModulePath: ["orders_db"],
      type: "aws_db_instance",
      name: "this",
      providerName: "registry.terraform.io/hashicorp/aws",
    });
    expect(db.changedPaths).toContainEqual(["storage_encrypted"]);
    // the password is marked on both sides and unchanged
    expect(db.sensitiveChangedPaths).toEqual([]);
    expect(db.before).toMatchObject({ password: S, storage_encrypted: true, identifier: "orders-prod" });
    expect(db.after).toMatchObject({ password: S, storage_encrypted: false });
    expect(db.unknownPaths).toContainEqual(["id"]);
  });

  it("summarizes the plan", () => {
    // the eval fixture may be regenerated with more noise; the replacement is the point
    expect(plan.counts.replace).toBe(1);
    expect(plan.counts.update).toBeGreaterThan(0);
    expect(plan.counts["no-op"]).toBeUndefined();
    expect(plan.providerConstraints).toEqual({ aws: "~> 6.0" });
    expect(plan.variables).toEqual({ orders_db_encrypted: { value: false, sensitive: false } });
    expect(Object.keys(plan.modules).sort()).toEqual(["", "orders_db", "platform"]);
    expect(plan.modules.orders_db).toMatchObject({ source: "./modules/db", path: ["orders_db"] });
    expect(Object.keys(plan.modules.orders_db!.resources)).toEqual(["aws_db_instance.this"]);
    expect(plan.modules[""]!.moduleCalls.orders_db?.expressions).toHaveProperty("encrypted");
  });

  it("hides the RDS password and the provider credentials everywhere", () => {
    const text = JSON.stringify(plan);
    expect(text).not.toContain("not-a-real-password-123");
    expect(text).not.toContain("mock_secret_key");
    expect(text).not.toContain("mock_access_key");
    expect(plan.modules.orders_db!.resources["aws_db_instance.this"]?.expressions.password).toEqual({
      constant_value: S,
    });
  });
});

describe("loadPlan: handcrafted edge cases", () => {
  const rc = (change: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    address: "aws_db_instance.db",
    mode: "managed",
    type: "aws_db_instance",
    name: "db",
    provider_name: "registry.terraform.io/hashicorp/aws",
    change: { actions: ["update"], after_unknown: {}, before_sensitive: {}, after_sensitive: {}, ...change },
    ...extra,
  });

  it("reports a changed sensitive value without revealing either side", () => {
    const m = loadPlan({
      format_version: "1.2",
      resource_changes: [
        rc({
          before: { password: "old-pass-1", port: 5432 },
          after: { password: "new-pass-2", port: 5432 },
          before_sensitive: { password: true },
          after_sensitive: { password: true },
        }),
      ],
    });
    const c = m.changes[0]!;
    expect(c.changedPaths).toEqual([["password"]]);
    expect(c.sensitiveChangedPaths).toEqual([["password"]]);
    expect(c.before).toEqual({ password: S, port: 5432 });
    expect(c.after).toEqual({ password: S, port: 5432 });
    expect(JSON.stringify(m)).not.toMatch(/old-pass-1|new-pass-2/);
  });

  it("reports a sensitivity change even when the value is the same", () => {
    const m = loadPlan({
      format_version: "1.2",
      resource_changes: [
        rc({
          before: { tag: "same-value" },
          after: { tag: "same-value" },
          before_sensitive: {},
          after_sensitive: { tag: true },
        }),
      ],
    });
    expect(m.changes[0]!.changedPaths).toEqual([]);
    expect(m.changes[0]!.sensitiveChangedPaths).toEqual([["tag"]]);
  });

  it("reports a sensitive value that becomes unknown", () => {
    const m = loadPlan({
      format_version: "1.2",
      resource_changes: [
        rc({
          before: { secret: "abc-123-xyz" },
          after: {},
          after_unknown: { secret: true },
          before_sensitive: { secret: true },
          after_sensitive: { secret: true },
        }),
      ],
    });
    expect(m.changes[0]!.sensitiveChangedPaths).toEqual([["secret"]]);
    expect(m.changes[0]!.unknownPaths).toEqual([["secret"]]);
  });

  it("does not leak map keys or list lengths of a sensitive value through paths", () => {
    const m = loadPlan({
      format_version: "1.2",
      resource_changes: [
        rc({
          before: { env: { SECRET_NAME_A: "1" }, list: ["a"] },
          after: { env: { SECRET_NAME_B: "2" }, list: ["a", "b"] },
          before_sensitive: { env: true, list: true },
          after_sensitive: { env: true, list: true },
        }),
      ],
    });
    const c = m.changes[0]!;
    expect(c.changedPaths).toEqual([["env"], ["list"]]);
    expect(JSON.stringify(m)).not.toContain("SECRET_NAME");
  });

  it("skips sensitive paths on create and delete (every value changes anyway)", () => {
    const m = loadPlan({
      format_version: "1.2",
      resource_changes: [
        rc({
          actions: ["create"],
          before: null,
          after: { password: "x-pass-123" },
          before_sensitive: false,
          after_sensitive: { password: true },
        }),
      ],
    });
    expect(m.changes[0]!.sensitiveChangedPaths).toEqual([]);
    // diffPaths reports no paths when a whole side is null (see plan/paths.ts)
    expect(m.changes[0]!.changedPaths).toEqual([]);
    expect(m.changes[0]!.after).toEqual({ password: S });
  });

  it("loads drift and masks it like changes", () => {
    const m = loadPlan({
      format_version: "1.2",
      resource_changes: [],
      resource_drift: [
        rc({
          before: { instance_class: "db.t3.micro", password: "drift-pass-1" },
          after: { instance_class: "db.t3.large", password: "drift-pass-2" },
          before_sensitive: { password: true },
          after_sensitive: { password: true },
        }),
      ],
    });
    expect(m.drift).toHaveLength(1);
    expect(m.drift[0]).toMatchObject({ action: "update", changedPaths: [["instance_class"], ["password"]] });
    expect(JSON.stringify(m)).not.toContain("drift-pass");
    expect(m.counts).toEqual({});
  });

  it("treats previous_address equal to address as no move", () => {
    const m = loadPlan({
      format_version: "1.2",
      resource_changes: [
        rc({ actions: ["no-op"], before: {}, after: {} }, { previous_address: "aws_db_instance.db" }),
      ],
    });
    expect(m.changes[0]!.action).toBe("no-op");
  });

  it("keeps an import without id, and the index from the address when the field is missing", () => {
    const m = loadPlan({
      format_version: "1.2",
      resource_changes: [
        {
          address: 'module.a["x"].aws_s3_bucket.b["k"]',
          change: { actions: ["no-op"], importing: {}, before: {}, after: {} },
        },
      ],
    });
    expect(m.changes[0]).toMatchObject({
      action: "import",
      importing: {},
      index: "k",
      type: "aws_s3_bucket",
      name: "b",
      moduleAddress: 'module.a["x"]',
      configModulePath: ["a"],
      providerName: "",
    });
  });

  it("treats an output as sensitive when the declaration says so, even with no marks", () => {
    const m = loadPlan({
      format_version: "1.2",
      planned_values: {},
      output_changes: { dsn: { actions: ["create"], before: null, after: "x", after_unknown: false } },
      configuration: { root_module: { outputs: { dsn: { sensitive: true, expression: {} } } } },
    });
    expect(m.outputChanges).toEqual([{ name: "dsn", actions: ["create"], sensitive: true }]);
  });

  it("indexes module calls with version and stops at absurd nesting", () => {
    let mod: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) mod = { module_calls: { m: { source: "./m", module: mod } } };
    const root = {
      module_calls: {
        vpc: { source: "terraform-aws-modules/vpc/aws", version: "~> 5.0", expressions: {}, module: {} },
        deep: { source: "./m", module: mod },
      },
    };
    const m = loadPlan({ format_version: "1.2", planned_values: {}, configuration: { root_module: root } });
    expect(m.modules.vpc).toMatchObject({ source: "terraform-aws-modules/vpc/aws", version: "~> 5.0" });
    expect(m.modules[""]!.moduleCalls.vpc).toMatchObject({ version: "~> 5.0", expressions: {} });
    expect(Object.keys(m.modules).length).toBeLessThan(80);
  });

  it("collects provider constraints from every provider config key", () => {
    const m = loadPlan({
      format_version: "1.2",
      planned_values: {},
      configuration: {
        provider_config: {
          aws: { name: "aws", version_constraint: "~> 6.0" },
          "aws.us": { name: "aws", alias: "us" },
          "module.x:random": { name: "random", version_constraint: ">= 3.0", module_address: "module.x" },
        },
      },
    });
    expect(m.providerConstraints).toEqual({ aws: "~> 6.0", "module.x:random": ">= 3.0" });
  });
});

describe("plan counts like Terraform's Plan: line", () => {
  it("counts a forget+create as a forget and a create", () => {
    const plan = loadPlan({
      format_version: "1.2",
      terraform_version: "1.14.0",
      configuration: { root_module: {} },
      resource_changes: [
        {
          address: "terraform_data.a",
          mode: "managed",
          type: "terraform_data",
          name: "a",
          provider_name: "terraform.io/builtin/terraform",
          change: { actions: ["forget", "create"], before: {}, after: {}, after_unknown: {} },
        },
      ],
    });
    expect(plan.changes[0]?.action).toBe("forget");
    expect(plan.counts).toEqual({ forget: 1, create: 1 });
  });
});
