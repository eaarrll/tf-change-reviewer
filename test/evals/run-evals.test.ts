import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MODEL,
  DEFAULT_OUT_DIR,
  FIXTURES_DIR,
  UsageError,
  caseNotes,
  countChanges,
  errorMessage,
  fileStamp,
  listFixtures,
  loadFixture,
  loadFixtures,
  main,
  parseCliArgs,
  percentile,
  renderConsoleTable,
  renderMarkdownReport,
  reportHeader,
  summarize,
} from "../../evals/run-evals.js";
import type { CaseRecord, EvalDeps, EvalOptions } from "../../evals/run-evals.js";
import { gradeFixture, parseLabels } from "../../evals/grade.js";
import type { Finding, Review, ReviewInput, Workspace } from "../../src/types.js";

const REAL = "db-encryption-replace";
const DB = "module.orders_db.aws_db_instance.this";
const NOW = new Date("2026-11-24T10:11:12.345Z");
const KEY = "sk-ant-api03-test-value-not-real";

let scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  scratch = [];
  vi.restoreAllMocks();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tfcr-evals-"));
  scratch.push(dir);
  return dir;
}

/** A fixtures root with copies of the real fixture under each name. */
function fixturesRoot(names: string[] = [REAL]): string {
  const root = tempDir();
  for (const name of names) cpSync(join(FIXTURES_DIR, REAL), join(root, name), { recursive: true });
  return root;
}

function finding(address: string, overrides: Partial<Finding> = {}): Finding {
  return {
    id: address,
    address,
    action: "replace",
    severity: "critical",
    title: "t",
    impact: "i",
    cause: "c",
    causeLinks: [],
    signals: [],
    confidence: "high",
    origin: "rules",
    ...overrides,
  };
}

function review(findings: Finding[], agentCost?: number | null): Review {
  return {
    rootModuleDir: "",
    findings,
    others: [],
    stats: { totalChanges: 0, counts: {}, bySeverity: {} },
    summary: "",
    warnings: [],
    ...(agentCost !== undefined && {
      agent: {
        model: DEFAULT_MODEL,
        turns: 3,
        toolCalls: 4,
        costUsd: agentCost,
        inputTokens: 1,
        outputTokens: 1,
        durationMs: 1,
        status: "complete",
      },
    }),
  };
}

function fakeDeps(reviewPlan: (input: ReviewInput) => Promise<Review>): EvalDeps & {
  workspaces: { root: string; rootModuleDir: string }[];
} {
  const workspaces: { root: string; rootModuleDir: string }[] = [];
  return {
    workspaces,
    reviewPlan,
    createFsWorkspace(root: string, rootModuleDir: string): Workspace {
      workspaces.push({ root, rootModuleDir });
      return { root, rootModuleDir, readFile: async () => null, listFiles: async () => [] };
    },
  };
}

const perfect = (): Promise<Review> =>
  Promise.resolve(
    review([
      finding(DB, {
        causeLinks: [
          { location: { file: "main.tf", startLine: 12, endLine: 12 }, label: "", changedInDiff: true },
        ],
      }),
    ]),
  );

function options(overrides: Partial<EvalOptions> = {}): EvalOptions {
  return {
    mode: "rules",
    model: null,
    effort: "high",
    fixtures: null,
    set: "all",
    showHoldout: false,
    maxCostUsd: 0.5,
    budgetUsd: null,
    repeat: 1,
    outDir: "/tmp/x",
    label: "rules",
    ...overrides,
  };
}

// ───────────────────────────── CLI ─────────────────────────────

describe("parseCliArgs", () => {
  it("defaults to the model mode with the default model", () => {
    const cmd = parseCliArgs([], "/repo");
    expect(cmd).toEqual({
      kind: "run",
      options: {
        mode: "model",
        model: DEFAULT_MODEL,
        effort: "high",
        fixtures: null,
        set: "all",
        showHoldout: false,
        maxCostUsd: 0.5,
        budgetUsd: null,
        repeat: 1,
        outDir: DEFAULT_OUT_DIR,
        label: DEFAULT_MODEL,
      },
    });
  });

  it("parses every flag", () => {
    const cmd = parseCliArgs(
      [
        "--model",
        "claude-sonnet-5-5",
        "--fixtures",
        "a,b",
        "--fixtures",
        " c ,a",
        "--effort",
        "low",
        "--max-cost",
        "0.25",
        "--budget-usd",
        "3",
        "--repeat",
        "2",
        "--out",
        "out/x",
      ],
      "/repo",
    );
    expect(cmd).toEqual({
      kind: "run",
      options: {
        mode: "model",
        model: "claude-sonnet-5-5",
        effort: "low",
        fixtures: ["a", "b", "c"],
        set: "all",
        showHoldout: false,
        maxCostUsd: 0.25,
        budgetUsd: 3,
        repeat: 2,
        outDir: "/repo/out/x",
        label: "claude-sonnet-5-5",
      },
    });
  });

  it("--rules-only has no model and the label rules", () => {
    const cmd = parseCliArgs(["--rules-only"]);
    expect(cmd.kind === "run" && cmd.options).toMatchObject({ mode: "rules", model: null, label: "rules" });
  });

  it("makes the model id safe for file names", () => {
    const cmd = parseCliArgs(["--model", "us.anthropic/claude:opus"]);
    expect(cmd.kind === "run" && cmd.options.label).toBe("us.anthropic-claude-opus");
  });

  it("help", () => {
    expect(parseCliArgs(["-h"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["--help", "--rules-only"])).toEqual({ kind: "help" });
  });

  it.each([
    [["--model", "x", "--rules-only"], /conflict/],
    [["--model", "  "], /must not be empty/],
    [["--effort", "extreme"], /--effort must be one of/],
    [["--max-cost", "0"], /--max-cost must be a positive number/],
    [["--max-cost", "abc"], /--max-cost/],
    [["--budget-usd", "-1"], /--budget-usd/],
    [["--repeat", "0"], /--repeat must be a positive integer/],
    [["--repeat", "1.5"], /--repeat/],
    [["--fixtures", " , "], /at least one fixture/],
    [["--model", "..."], /file name/],
    [["--bogus"], /bogus/],
    [["positional"], /positional/i],
  ])("rejects %j", (argv, message) => {
    expect(() => parseCliArgs(argv)).toThrow(UsageError);
    expect(() => parseCliArgs(argv)).toThrow(message);
  });
});

// ───────────────────────────── fixtures ─────────────────────────────

describe("fixtures", () => {
  it("loads the real fixture", () => {
    const f = loadFixture(FIXTURES_DIR, REAL);
    expect(f.name).toBe(REAL);
    expect(f.labels.material[0]?.address).toBe(DB);
    expect(f.diffText).toContain("+  encrypted      = var.orders_db_encrypted");
    expect(f.planLines).toBeGreaterThan(300);
    expect(f.changes).toBeGreaterThan(1);
    expect((f.planJson as { format_version?: string }).format_version).toBeTypeOf("string");
  });

  it("counts non-no-op changes like the plan does", () => {
    const plan = JSON.parse(readFileSync(join(FIXTURES_DIR, REAL, "plan.json"), "utf8")) as {
      resource_changes: { change: { actions: string[] } }[];
    };
    const expected = plan.resource_changes.filter((rc) => rc.change.actions.join() !== "no-op").length;
    expect(countChanges(plan)).toBe(expected);
    expect(
      countChanges({
        resource_changes: [
          { change: { actions: ["no-op"] } },
          { change: { actions: ["delete", "create"] } },
          { change: { actions: ["update"] } },
          { change: {} },
          null,
        ],
      }),
    ).toBe(2);
    expect(countChanges(null)).toBe(0);
    expect(countChanges({ resource_changes: "x" })).toBe(0);
  });

  it("lists only directories with labels.json, sorted, skipping dot dirs", () => {
    const root = fixturesRoot(["b", "a"]);
    mkdirSync(join(root, "no-labels"));
    mkdirSync(join(root, ".work"));
    writeFileSync(join(root, ".work", "labels.json"), "{}");
    writeFileSync(join(root, "file.json"), "{}");
    expect(listFixtures(root)).toEqual(["a", "b"]);
    expect(listFixtures(join(root, "missing"))).toEqual([]);
  });

  it("loadFixtures filters by name and rejects unknown names", () => {
    const root = fixturesRoot(["a", "b"]);
    expect(loadFixtures(root, ["b"]).map((f) => f.name)).toEqual(["b"]);
    expect(loadFixtures(root, null).map((f) => f.name)).toEqual(["a", "b"]);
    expect(() => loadFixtures(root, ["b", "zzz"])).toThrow(/unknown fixture\(s\): zzz \(available: a, b\)/);
  });

  it("--set dev never parses a ho-* fixture: the name decides the set before anything is read", () => {
    const root = fixturesRoot(["a", "ho-a"]);
    writeFileSync(join(root, "ho-a", "labels.json"), '{"material": [{"address": "aws_x.secret_name"}, ');
    expect(loadFixtures(root, null, "dev").map((f) => f.name)).toEqual(["a"]);
    expect(loadFixtures(root, ["a", "ho-a"], "dev").map((f) => f.name)).toEqual(["a"]);
    expect(() => loadFixtures(root, ["zzz"], "dev")).toThrow(/available: a\)/);
  });

  it("a ho-* fixture is holdout without a set field, and a set that disagrees with the name fails", () => {
    const root = fixturesRoot(["a", "ho-a"]);
    expect(loadFixtures(root, null, "holdout").map((f) => [f.name, f.set])).toEqual([["ho-a", "holdout"]]);
    expect(loadFixtures(root, null).map((f) => f.set)).toEqual(["dev", "holdout"]);
    const labels = JSON.parse(readFileSync(join(root, "a", "labels.json"), "utf8")) as object;
    writeFileSync(join(root, "a", "labels.json"), JSON.stringify({ ...labels, set: "holdout" }));
    expect(() => loadFixtures(root, ["a"])).toThrow(/^a: labels.json says set "holdout"/);
    writeFileSync(join(root, "ho-a", "labels.json"), JSON.stringify({ ...labels, set: "dev" }));
    expect(() => loadFixtures(root, ["ho-a"], "holdout", true)).toThrow(/labels.json says set "dev"/);
  });

  it("a holdout fixture that fails to load does not print why unless --show-holdout", () => {
    const root = fixturesRoot(["ho-a"]);
    writeFileSync(
      join(root, "ho-a", "labels.json"),
      '{"material":[{"address":"aws_x.secret_name"}],"acceptable":["aws_x.secret_name"]}',
    );
    expect(() => loadFixtures(root, null)).toThrow("ho-a: failed to load (holdout: details hidden");
    expect(() => loadFixtures(root, null)).not.toThrow(/secret_name/);
    expect(() => loadFixtures(root, null, "all", true)).toThrow(
      /secret_name is both material and acceptable/,
    );
  });

  it("a missing pr.diff or plan.txt is tolerated", () => {
    const root = fixturesRoot();
    rmSync(join(root, REAL, "pr.diff"));
    rmSync(join(root, REAL, "plan.txt"));
    const f = loadFixture(root, REAL);
    expect(f.diffText).toBeNull();
    expect(f.planLines).toBeNull();
  });

  it.each([
    ["plan.json is missing", (dir: string) => rmSync(join(dir, "plan.json"))],
    ["repo/ is missing", (dir: string) => rmSync(join(dir, "repo"), { recursive: true })],
    ["plan.json is not JSON", (dir: string) => writeFileSync(join(dir, "plan.json"), "{")],
    ["labels.json is not JSON", (dir: string) => writeFileSync(join(dir, "labels.json"), "")],
    ["invalid labels", (dir: string) => writeFileSync(join(dir, "labels.json"), '{"material":{}}')],
  ])("fails clearly when %s", (message, breakIt) => {
    const root = fixturesRoot();
    breakIt(join(root, REAL));
    expect(() => loadFixture(root, REAL)).toThrow(`${REAL}: ${message}`);
  });
});

// ───────────────────────────── summary + rendering ─────────────────────────────

function record(overrides: Partial<CaseRecord> = {}): CaseRecord {
  const labels = parseLabels({ material: [{ address: DB, cause: [{ file: "main.tf", line: 12 }] }] });
  return {
    fixture: REAL,
    set: "dev",
    repeat: 1,
    planLines: 336,
    changes: 12,
    status: "ok",
    error: null,
    grade: gradeFixture(review([finding(DB)]), labels),
    flagged: [],
    costUsd: 0.1,
    latencyMs: 1000,
    agentStatus: "complete",
    warnings: [],
    ...overrides,
  };
}

describe("summarize", () => {
  it("adds cost and latency to the grade aggregate", () => {
    const s = summarize(
      [
        record({ costUsd: 0.1, latencyMs: 1000 }),
        record({ costUsd: null, latencyMs: 4000, status: "error" }),
        record({ costUsd: 0.3, latencyMs: 2000 }),
      ],
      2,
    );
    expect(s).toMatchObject({ cases: 3, errors: 1, skipped: 2, tp: 3, fp: 0, fn: 0, precision: 1 });
    expect(s.cost.total).toBeCloseTo(0.4);
    expect(s.cost.meanPerCase).toBeCloseTo(0.2);
    expect(s.cost.unpricedCases).toBe(1);
    expect(s.latencyMs).toEqual({ p50: 2000, max: 4000 });
    expect(s.trace).toEqual({ judged: 3, traced: 0, accuracy: 0 });
  });

  it("a crashed review is never a perfect case, even on a fixture with no material change", () => {
    const quiet = parseLabels({ material: [] });
    const empty = gradeFixture(review([]), quiet);
    const s = summarize([record({ grade: empty }), record({ grade: empty, status: "error", error: "boom" })]);
    expect(s).toMatchObject({ cases: 2, errors: 1, perfect: 1 });
    expect(renderMarkdownReport(reportHeader(options(), 2, NOW, false), s, [])).toContain(
      "| Perfect cases | 1/2 |",
    );
  });

  it("handles an empty run", () => {
    const s = summarize([]);
    expect(s).toMatchObject({ cases: 0, precision: null, cost: { total: 0, meanPerCase: null } });
    expect(s.latencyMs).toEqual({ p50: 0, max: 0 });
  });

  it("percentile is nearest-rank", () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([5], 50)).toBe(5);
    expect(percentile([4, 1, 3, 2], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 100)).toBe(5);
  });
});

describe("rendering", () => {
  it("caseNotes names FP, FN (with how the review listed it), untraced TP, duplicates and agent stops", () => {
    const labels = parseLabels({
      material: [{ address: DB, cause: [{ file: "main.tf", line: 12 }] }, { address: "aws_kms_key.k" }],
    });
    const r: Review = {
      ...review([finding(DB), finding("aws_s3_bucket.b"), finding(DB)]),
      others: [{ change: { address: "aws_kms_key.k" } as never, severity: "medium", score: 1, signals: [] }],
    };
    const notes = caseNotes(record({ grade: gradeFixture(r, labels), agentStatus: "budget" }));
    expect(notes).toEqual([
      "FP aws_s3_bucket.b",
      "FN aws_kms_key.k (listed as medium)",
      `untraced ${DB}`,
      `duplicates ${DB}`,
      "agent budget",
    ]);
    expect(caseNotes(record({ status: "error", error: "boom" }))[0]).toBe("error: boom");
    expect(caseNotes(record({ agentStatus: "skipped" }))).toEqual([`untraced ${DB}`]);
  });

  it("console table has one row per case and the expected columns", () => {
    const table = renderConsoleTable([record(), record({ repeat: 2, planLines: null, costUsd: null })]);
    const lines = table.split("\n");
    expect(lines[0]).toMatch(
      /^fixture\s+plan lines\s+changes\s+TP\/FP\/FN\s+traced\s+cost\s+seconds\s+notes$/,
    );
    expect(lines[1]).toContain(`${REAL} #1`);
    expect(lines[1]).toContain("336");
    expect(lines[1]).toContain("1/0/0");
    expect(lines[1]).toContain("0/1");
    expect(lines[1]).toContain("$0.1000");
    expect(lines[2]).toContain("n/a");
    expect(lines[2]).toContain("?");
  });

  it("markdown report has the metrics, the cases and escapes table cells", () => {
    const opts = options({ mode: "model", model: "m", label: "m", budgetUsd: 1 });
    const header = reportHeader(opts, 1, NOW, true);
    const records = [record({ status: "error", error: "a | b\nc" })];
    const md = renderMarkdownReport(header, summarize(records, 3), records);
    expect(md).toContain("# Eval results: m");
    expect(md).toContain("Run 2026-11-24T10:11:12.345Z · model `m` · effort `high`");
    expect(md).toContain("**Stopped early:** total cost passed the $1.00 budget; 3 cases not run.");
    expect(md).toContain("| Precision | 100% (1 TP, 0 FP); 1 crashed case graded as flagging nothing |");
    expect(md).toContain("| Recall | 100% (1 of 1 material) |");
    expect(md).toContain("| Trace accuracy | 0% (0/1 TP) |");
    expect(md).toContain("| Severity agreement | n/a |");
    expect(md).toContain("error: a \\| b c");
    expect(md).not.toMatch(/a \| b/);
  });

  it("rules-mode header leaves out model, effort and the agent budget", () => {
    expect(reportHeader(options(), 2, NOW, false)).toEqual({
      label: "rules",
      mode: "rules",
      model: null,
      effort: null,
      startedAt: NOW.toISOString(),
      fixtures: 2,
      repeat: 1,
      maxCostUsd: null,
      budgetUsd: null,
      stoppedByBudget: false,
    });
  });

  it("fileStamp has no characters that are unsafe in file names", () => {
    expect(fileStamp(NOW)).toBe("2026-11-24T10-11-12-345Z");
  });

  it("errorMessage cuts API keys and long text", () => {
    expect(errorMessage(new Error(`401 for key ${KEY}`))).toBe("401 for key (redacted)");
    expect(errorMessage("x".repeat(900))).toHaveLength(500);
    expect(errorMessage(42)).toBe("42");
  });
});

// ───────────────────────────── main ─────────────────────────────

describe("main", () => {
  let logs: string[];
  let errors: string[];
  beforeEach(() => {
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.join(" ")));
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void errors.push(a.join(" ")));
  });

  const run = (argv: string[], extra: Parameters<typeof main>[1] = {}): Promise<number> =>
    main(argv, { env: {}, now: () => NOW, ...extra });

  it("prints help", async () => {
    expect(await run(["--help"])).toBe(0);
    expect(logs.join("\n")).toContain("--rules-only");
  });

  it("prints usage on a bad flag", async () => {
    expect(await run(["--nope"])).toBe(1);
    expect(errors.join("\n")).toContain("Usage:");
  });

  it("refuses the model mode without ANTHROPIC_API_KEY, before touching anything", async () => {
    const reviewPlan = vi.fn(perfect);
    const out = join(tempDir(), "out");
    expect(await run(["--out", out], { deps: fakeDeps(reviewPlan), env: { ANTHROPIC_API_KEY: "  " } })).toBe(
      1,
    );
    expect(errors.join("\n")).toMatch(/ANTHROPIC_API_KEY is not set.*--rules-only/);
    expect(reviewPlan).not.toHaveBeenCalled();
    expect(() => readdirSync(out)).toThrow();
  });

  it("rules-only: reviews each fixture, grades it and writes JSON + markdown", async () => {
    const root = fixturesRoot(["a", "b"]);
    const out = join(tempDir(), "results");
    const deps = fakeDeps(vi.fn(perfect));
    expect(await run(["--rules-only", "--out", out], { fixturesDir: root, deps })).toBe(0);

    expect(deps.reviewPlan).toHaveBeenCalledTimes(2);
    const input = vi.mocked(deps.reviewPlan).mock.calls[0]?.[0];
    expect(input?.agent).toBeNull();
    expect(input?.maxFindings).toBe(7);
    expect(input?.diffText).toContain("orders_db_encrypted");
    expect((input?.planJson as { resource_changes: unknown[] }).resource_changes.length).toBeGreaterThan(0);
    expect(deps.workspaces).toEqual([
      { root: join(root, "a", "repo"), rootModuleDir: "" },
      { root: join(root, "b", "repo"), rootModuleDir: "" },
    ]);

    expect(readdirSync(out).sort()).toEqual(["latest-rules.md", "rules-2026-11-24T10-11-12-345Z.json"]);
    const json = JSON.parse(readFileSync(join(out, "rules-2026-11-24T10-11-12-345Z.json"), "utf8")) as {
      header: { mode: string };
      summary: { precision: number; recall: number; trace: { accuracy: number }; cost: { total: number } };
      records: CaseRecord[];
    };
    expect(json.header.mode).toBe("rules");
    expect(json.summary).toMatchObject({
      precision: 1,
      recall: 1,
      trace: { accuracy: 1 },
      cost: { total: 0 },
    });
    expect(json.records.map((r) => r.fixture)).toEqual(["a", "b"]);
    expect(json.records[0]?.flagged).toEqual([
      { address: DB, severity: "critical", origin: "rules", confidence: "high" },
    ]);
    const md = readFileSync(join(out, "latest-rules.md"), "utf8");
    expect(md).toContain("mode **rules only**");
    expect(md).toContain("| a | 336 |");

    const printed = logs.join("\n");
    expect(printed).toContain("Running 2 review(s) sequentially with rules only");
    expect(printed).toMatch(/precision 100% · recall 100% · F1 100% · trace 100% \(2\/2\)/);
  });

  it("model mode passes the agent options and the key, and never prints the key", async () => {
    const root = fixturesRoot();
    const out = join(tempDir(), "results");
    const deps = fakeDeps(vi.fn(() => Promise.resolve(review([finding(DB)], 0.12))));
    const code = await run(
      ["--model", "claude-sonnet-5-5", "--effort", "low", "--max-cost", "0.2", "--out", out],
      { fixturesDir: root, deps, env: { ANTHROPIC_API_KEY: KEY } },
    );
    expect(code).toBe(0);
    const agent = vi.mocked(deps.reviewPlan).mock.calls[0]?.[0].agent;
    expect(agent).toMatchObject({
      model: "claude-sonnet-5-5",
      apiKey: KEY,
      effort: "low",
      maxTurns: 12,
      maxCostUsd: 0.2,
      timeoutMs: 300_000,
    });
    const written = readdirSync(out).map((f) => readFileSync(join(out, f), "utf8"));
    expect(readdirSync(out).sort()).toEqual([
      "claude-sonnet-5-5-2026-11-24T10-11-12-345Z.json",
      "latest-claude-sonnet-5-5.md",
    ]);
    for (const text of [...written, ...logs, ...errors]) expect(text).not.toContain(KEY);
    expect(logs.join("\n")).toContain("$0.1200");
  });

  it("stops once the running cost passes --budget-usd and reports the skipped reviews", async () => {
    const root = fixturesRoot(["a", "b"]);
    const out = join(tempDir(), "results");
    const deps = fakeDeps(vi.fn(() => Promise.resolve(review([], 0.3))));
    const code = await run(["--budget-usd", "0.5", "--repeat", "3", "--out", out], {
      fixturesDir: root,
      deps,
      env: { ANTHROPIC_API_KEY: KEY },
    });
    expect(code).toBe(0);
    expect(deps.reviewPlan).toHaveBeenCalledTimes(2);
    expect(errors.join("\n")).toMatch(
      /Stopping: total cost \$0\.6000 passed the \$0\.50 budget; 4 review\(s\) not run/,
    );
    const json = JSON.parse(
      readFileSync(join(out, `${DEFAULT_MODEL}-2026-11-24T10-11-12-345Z.json`), "utf8"),
    ) as { header: { stoppedByBudget: boolean }; summary: { skipped: number; cases: number } };
    expect(json.header.stoppedByBudget).toBe(true);
    expect(json.summary).toMatchObject({ skipped: 4, cases: 2 });
  });

  it("does not report a budget stop when the last review is the one that passes it", async () => {
    const root = fixturesRoot();
    const deps = fakeDeps(vi.fn(() => Promise.resolve(review([], 0.9))));
    const out = join(tempDir(), "results");
    await run(["--budget-usd", "0.5", "--out", out], {
      fixturesDir: root,
      deps,
      env: { ANTHROPIC_API_KEY: KEY },
    });
    expect(errors.join("\n")).not.toContain("Stopping");
  });

  it("a crashing review is a graded error case, not a harness failure", async () => {
    const root = fixturesRoot();
    const out = join(tempDir(), "results");
    const deps = fakeDeps(vi.fn(() => Promise.reject(new Error(`boom with ${KEY}`))));
    expect(await run(["--rules-only", "--out", out], { fixturesDir: root, deps })).toBe(0);
    const json = JSON.parse(readFileSync(join(out, "rules-2026-11-24T10-11-12-345Z.json"), "utf8")) as {
      summary: { errors: number; recall: number };
      records: CaseRecord[];
    };
    expect(json.summary).toMatchObject({ errors: 1, recall: 0 });
    expect(json.records[0]).toMatchObject({ status: "error", error: "boom with (redacted)", costUsd: null });
    expect(json.records[0]?.grade.fn).toEqual([DB]);
  });

  it("fails before reviewing anything on an unknown fixture or an empty fixtures dir", async () => {
    const deps = fakeDeps(vi.fn(perfect));
    expect(await run(["--rules-only", "--fixtures", "nope"], { fixturesDir: fixturesRoot(), deps })).toBe(1);
    expect(errors.join("\n")).toContain("unknown fixture(s): nope");
    expect(await run(["--rules-only"], { fixturesDir: tempDir(), deps })).toBe(1);
    expect(errors.join("\n")).toContain("No fixtures found");
    expect(deps.reviewPlan).not.toHaveBeenCalled();
  });

  it("fails before reviewing anything when the output dir cannot be created", async () => {
    const blocker = join(tempDir(), "file");
    writeFileSync(blocker, "x");
    const deps = fakeDeps(vi.fn(perfect));
    expect(
      await run(["--rules-only", "--out", join(blocker, "out")], { fixturesDir: fixturesRoot(), deps }),
    ).toBe(1);
    expect(errors.join("\n")).toContain("Cannot write results");
    expect(deps.reviewPlan).not.toHaveBeenCalled();
  });
});

// ───────────────────────────── sets ─────────────────────────────

describe("dev / holdout reporting", () => {
  it("summarizes each set apart and keeps holdout addresses out of the report", async () => {
    const { blindRecords, caseNotes, renderMarkdownReport, renderSetLines, summarizeSets } =
      await import("../../evals/run-evals.js");
    const dev = record();
    const missLabels = parseLabels({ set: "holdout", material: [{ address: "aws_secret.hidden_name" }] });
    const holdout = record({
      fixture: "ho-x",
      set: "holdout",
      grade: gradeFixture(review([finding("aws_s3_bucket.flagged_name")]), missLabels),
    });
    const sets = summarizeSets([dev, holdout]);
    expect(sets.dev?.cases).toBe(1);
    expect(sets.holdout?.cases).toBe(1);
    expect(sets.combined.cases).toBe(2);
    expect(sets.holdout?.fn).toBe(1);
    expect(renderSetLines(sets)).toMatch(/^dev .*\nholdout .*\ncombined /);

    const shown = blindRecords([dev, holdout], false);
    const notes = caseNotes(shown[1]!).join("; ");
    expect(notes).toContain("1 FP (holdout: addresses hidden)");
    expect(notes).toContain("1 FN (holdout: addresses hidden)");
    const md = renderMarkdownReport(
      reportHeader(options(), 2, new Date(0), false),
      sets.combined,
      shown,
      sets,
    );
    expect(md).toContain("| holdout (blind) |");
    expect(md).not.toContain("hidden_name");
    expect(md).not.toContain("flagged_name");
    expect(JSON.stringify(shown)).not.toContain("hidden_name");
    expect(caseNotes(blindRecords([holdout], true)[0]!).join(" ")).toContain("aws_secret.hidden_name");
  });

  it("hides the error text and live warnings of a holdout case", async () => {
    const { blindRecords, caseLogger, caseNotes } = await import("../../evals/run-evals.js");
    const crashed = record({
      fixture: "ho-x",
      set: "holdout",
      status: "error",
      error: "aws_secret.hidden_name",
    });
    const [shown] = blindRecords([crashed], false);
    expect(shown?.error).toBe("(holdout: error text hidden)");
    expect(caseNotes(shown!).join(" ")).not.toContain("hidden_name");
    expect(blindRecords([record({ set: "holdout", status: "ok", error: null })], false)[0]?.error).toBeNull();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    caseLogger("ho-x #1", true).warn("aws_secret.hidden_name is odd");
    caseLogger("dev #1").warn("aws_db.visible is odd");
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      "  [ho-x #1] warning: (holdout: text hidden)",
      "  [dev #1] warning: aws_db.visible is odd",
    ]);
  });

  it("parses --set and --show-holdout", () => {
    const cmd = parseCliArgs(["--rules-only", "--set", "dev", "--show-holdout"]);
    expect(cmd.kind === "run" && cmd.options).toMatchObject({ set: "dev", showHoldout: true });
    expect(() => parseCliArgs(["--set", "train"])).toThrow(/--set must be one of/);
  });
});
