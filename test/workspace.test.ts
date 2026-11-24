import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFsWorkspace, MAX_WORKSPACE_FILE_BYTES, normalizeRepoPath } from "../src/workspace.js";

let base: string;
let repo: string;
let outside: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "tfcr-ws-"));
  repo = join(base, "repo");
  outside = join(base, "outside");
  mkdirSync(join(repo, "infra", "modules", "db"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(repo, "infra", "main.tf"), 'module "db" {}\n');
  writeFileSync(join(repo, "infra", "variables.tf"), 'variable "x" {}\n');
  writeFileSync(join(repo, "infra", "terraform.tfvars"), "x = 1\n");
  writeFileSync(join(repo, "infra", "notes.md"), "# notes\n");
  writeFileSync(join(repo, "infra", "modules", "db", "main.tf"), 'resource "a_b" "c" {}\n');
  writeFileSync(join(repo, "README.md"), "readme\n");
  writeFileSync(join(outside, "secret.tf"), 'password = "hunter2"\n');
  // Symlinks: one pointing inside the repo, two escaping it.
  symlinkSync(join(repo, "infra", "main.tf"), join(repo, "infra", "linked.tf"));
  symlinkSync(join(outside, "secret.tf"), join(repo, "infra", "escape.tf"));
  symlinkSync(outside, join(repo, "infra", "outside-dir"));
  // Size limit: exactly at the limit is fine, one byte over is not.
  writeFileSync(join(repo, "at-limit.tf"), "a".repeat(MAX_WORKSPACE_FILE_BYTES));
  writeFileSync(join(repo, "too-big.tf"), "a".repeat(MAX_WORKSPACE_FILE_BYTES + 1));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("normalizeRepoPath", () => {
  it("normalizes to repo-relative forward-slash paths", () => {
    expect(normalizeRepoPath("infra/main.tf")).toBe("infra/main.tf");
    expect(normalizeRepoPath("./infra/./modules/../main.tf")).toBe("infra/main.tf");
    expect(normalizeRepoPath("infra\\modules\\db\\")).toBe("infra/modules/db");
    expect(normalizeRepoPath("infra//main.tf")).toBe("infra/main.tf");
    expect(normalizeRepoPath(".")).toBe("");
    expect(normalizeRepoPath("")).toBe("");
    expect(normalizeRepoPath("./")).toBe("");
  });

  it("rejects absolute, escaping and NUL paths", () => {
    expect(normalizeRepoPath("/etc/passwd")).toBeNull();
    expect(normalizeRepoPath("C:\\Windows")).toBeNull();
    expect(normalizeRepoPath("c:/x")).toBeNull();
    expect(normalizeRepoPath("..")).toBeNull();
    expect(normalizeRepoPath("../x")).toBeNull();
    expect(normalizeRepoPath("infra/../../x")).toBeNull();
    expect(normalizeRepoPath("infra\0.tf")).toBeNull();
  });
});

describe("createFsWorkspace", () => {
  it("exposes the absolute root and a normalized root module dir", () => {
    const ws = createFsWorkspace(repo, "./infra/");
    expect(ws.root).toBe(repo);
    expect(ws.rootModuleDir).toBe("infra");
    expect(createFsWorkspace(repo, ".").rootModuleDir).toBe("");
    expect(createFsWorkspace(repo, "").rootModuleDir).toBe("");
  });

  it("reads files by repo-relative path", async () => {
    const ws = createFsWorkspace(repo, "infra");
    expect(await ws.readFile("infra/main.tf")).toBe('module "db" {}\n');
    expect(await ws.readFile("./infra/modules/db/main.tf")).toBe('resource "a_b" "c" {}\n');
    expect(await ws.readFile("infra\\variables.tf")).toBe('variable "x" {}\n');
    expect(await ws.readFile("infra/modules/../main.tf")).toBe('module "db" {}\n');
  });

  it("returns null for missing files, directories and paths outside the root", async () => {
    const ws = createFsWorkspace(repo, "");
    expect(await ws.readFile("infra/missing.tf")).toBeNull();
    expect(await ws.readFile("infra")).toBeNull();
    expect(await ws.readFile("")).toBeNull();
    expect(await ws.readFile("../outside/secret.tf")).toBeNull();
    expect(await ws.readFile("infra/../../outside/secret.tf")).toBeNull();
    expect(await ws.readFile(join(outside, "secret.tf"))).toBeNull();
    expect(await ws.readFile("infra/main.tf\0")).toBeNull();
  });

  it("follows symlinks only when they resolve inside the root", async () => {
    const ws = createFsWorkspace(repo, "");
    expect(await ws.readFile("infra/linked.tf")).toBe('module "db" {}\n');
    expect(await ws.readFile("infra/escape.tf")).toBeNull();
    expect(await ws.readFile("infra/outside-dir/secret.tf")).toBeNull();
  });

  it("enforces the 1 MB size limit", async () => {
    const ws = createFsWorkspace(repo, "");
    expect((await ws.readFile("at-limit.tf"))?.length).toBe(MAX_WORKSPACE_FILE_BYTES);
    expect(await ws.readFile("too-big.tf")).toBeNull();
  });

  it("works when the root itself is reached through a symlink", async () => {
    const link = join(base, "repo-link");
    symlinkSync(repo, link);
    const ws = createFsWorkspace(link, "infra");
    expect(await ws.readFile("infra/main.tf")).toBe('module "db" {}\n');
    expect(await ws.readFile("infra/escape.tf")).toBeNull();
    expect(await ws.listFiles("infra", [".tf"])).toContain("infra/main.tf");
  });

  it("lists files non-recursively, sorted, repo-relative and filtered by suffix", async () => {
    const ws = createFsWorkspace(repo, "infra");
    expect(await ws.listFiles("infra", [".tf"])).toEqual([
      "infra/linked.tf",
      "infra/main.tf",
      "infra/variables.tf",
    ]);
    expect(await ws.listFiles("./infra/", [".tfvars", ".md"])).toEqual([
      "infra/notes.md",
      "infra/terraform.tfvars",
    ]);
    expect(await ws.listFiles("infra/modules/db", [".tf"])).toEqual(["infra/modules/db/main.tf"]);
  });

  it("lists the repository root with '' or '.', and everything when no suffix is given", async () => {
    const ws = createFsWorkspace(repo, "");
    expect(await ws.listFiles("", [".md"])).toEqual(["README.md"]);
    expect(await ws.listFiles(".", [".md"])).toEqual(["README.md"]);
    expect(await ws.listFiles("", [])).toEqual(["README.md", "at-limit.tf", "too-big.tf"]);
  });

  it("returns [] for missing, escaping or symlinked-outside directories", async () => {
    const ws = createFsWorkspace(repo, "");
    expect(await ws.listFiles("nope", [".tf"])).toEqual([]);
    expect(await ws.listFiles("..", [".tf"])).toEqual([]);
    expect(await ws.listFiles("../outside", [".tf"])).toEqual([]);
    expect(await ws.listFiles("infra/outside-dir", [".tf"])).toEqual([]);
    expect(await ws.listFiles("infra/main.tf", [".tf"])).toEqual([]);
  });

  it("returns null / [] for a root that does not exist", async () => {
    const ws = createFsWorkspace(join(base, "missing-root"), "");
    expect(await ws.readFile("main.tf")).toBeNull();
    expect(await ws.listFiles("", [".tf"])).toEqual([]);
  });

  it("reads a Terraform plan or state JSON as missing, whatever its name", async () => {
    const dir = join(base, "plans");
    mkdirSync(dir, { recursive: true });
    const plan = {
      format_version: "1.2",
      terraform_version: "1.10.5",
      variables: { api_token: { value: "correcthorsebattery" } },
      resource_changes: [],
    };
    const state = {
      version: 4,
      terraform_version: "1.10.5",
      serial: 3,
      lineage: "x",
      outputs: {},
      resources: [],
    };
    const shown = { format_version: "1.0", terraform_version: "1.10.5", values: { root_module: {} } };
    writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
    writeFileSync(join(dir, "pretty.txt"), JSON.stringify(plan, null, 2));
    writeFileSync(
      join(dir, "wrapped.log"),
      `[command]terraform show -json\n${JSON.stringify(plan)}\n::debug::exit 0\n`,
    );
    writeFileSync(join(dir, "backup.json"), JSON.stringify(state, null, 2));
    writeFileSync(join(dir, "shown.json"), JSON.stringify(shown));
    // Terraform JSON configuration, and JSON that only mentions the keys, stay readable.
    const config = '{"variable":{"x":{"default":"terraform_version"}},"output":{"values":{"value":1}}}\n';
    writeFileSync(join(dir, "main.tf.json"), config);
    const ws = createFsWorkspace(repo, "");
    const read = (name: string) => createFsWorkspace(base, "").readFile(`plans/${name}`);
    for (const name of ["plan.json", "pretty.txt", "wrapped.log", "backup.json", "shown.json"]) {
      expect(await read(name)).toBeNull();
    }
    expect(await read("main.tf.json")).toBe(config);
    expect(await ws.readFile("infra/main.tf")).toBe('module "db" {}\n');
  });
});
