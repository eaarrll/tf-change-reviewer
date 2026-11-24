import { describe, expect, it } from "vitest";
import { ConfigError, meetsThreshold, parsePlanEntries, readConfig } from "../src/config.js";

const FAKE_API_KEY = "sk-ant-api03-FAKE-KEY-FOR-TESTS-ONLY-000000000000000000000000";
const FAKE_TOKEN = "ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";

function inputs(values: Record<string, string>) {
  return { getInput: (name: string) => values[name] ?? "" };
}

const base = { "plan-json": "plan.json", "github-token": FAKE_TOKEN };

function errorOf(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("expected the call to throw");
}

describe("readConfig", () => {
  it("fills every default", () => {
    expect(readConfig(inputs(base))).toEqual({
      plans: [{ pattern: "plan.json", rootDir: null }],
      githubToken: FAKE_TOKEN,
      apiKey: null,
      model: "claude-opus-5-5",
      effort: "high",
      maxFindings: 7,
      maxCostUsd: 1,
      timeoutMinutes: 5,
      failOn: "none",
      comment: true,
      extraInstructions: null,
      prNumber: null,
      commentKey: null,
    });
  });

  it("reads every input", () => {
    const config = readConfig(
      inputs({
        ...base,
        "plan-json": "envs/*/plan.json\nlegacy/plan.json = legacy/stack\n# comment\n",
        "anthropic-api-key": ` ${FAKE_API_KEY} `,
        model: "claude-sonnet-5-5",
        effort: "XHIGH",
        "max-findings": "12",
        "max-cost-usd": "2.5",
        "timeout-minutes": "10",
        "fail-on": "high",
        comment: "no",
        "extra-instructions": "prod is envs/prod",
        "pr-number": "42",
      }),
    );
    expect(config).toMatchObject({
      plans: [
        { pattern: "envs/*/plan.json", rootDir: null },
        { pattern: "legacy/plan.json", rootDir: "legacy/stack" },
      ],
      apiKey: FAKE_API_KEY,
      model: "claude-sonnet-5-5",
      effort: "xhigh",
      maxFindings: 12,
      maxCostUsd: 2.5,
      timeoutMinutes: 10,
      failOn: "high",
      comment: false,
      extraInstructions: "prod is envs/prod",
      prNumber: 42,
    });
  });

  it.each([
    ["plan-json", ""],
    ["plan-json", "/etc/plan.json"],
    ["plan-json", "../outside/plan.json"],
    ["effort", "extreme"],
    ["fail-on", "low"],
    ["max-findings", "0"],
    ["max-cost-usd", "1e3"],
    ["timeout-minutes", "61"],
    ["comment", "maybe"],
    ["model", "claude opus"],
    ["pr-number", "-1"],
    ["plan-json", "/tmp/plan/plan.json=/abs/root"],
    ["plan-json", "/tmp/plan/../plan.json=infra"],
    ["comment-key", "x".repeat(201)],
    ["comment-key", "two\u0007bells"],
  ])("rejects %s=%j without echoing the value", (name, value) => {
    const err = errorOf(() => readConfig(inputs({ ...base, [name]: value })));
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toContain(name);
    if (value.length > 3) expect(err.message).not.toContain(value);
  });

  it("requires a token", () => {
    expect(errorOf(() => readConfig(inputs({ "plan-json": "p.json" }))).message).toMatch(/github-token/);
  });
});

describe("parsePlanEntries / meetsThreshold", () => {
  it("accepts an absolute plan path (e.g. under RUNNER_TEMP) only with its root module dir", () => {
    expect(parsePlanEntries("/runner/_temp/plan/infra/plan.json=infra")).toEqual([
      { pattern: "/runner/_temp/plan/infra/plan.json", rootDir: "infra" },
    ]);
    expect(parsePlanEntries("/runner/_temp/plan.json=")).toEqual([
      { pattern: "/runner/_temp/plan.json", rootDir: "." },
    ]);
    expect(errorOf(() => parsePlanEntries("/runner/_temp/plan/infra/plan.json")).message).toMatch(
      /root module dir for an absolute plan path/,
    );
  });

  it("reads comment-key", () => {
    expect(readConfig(inputs({ ...base, "comment-key": " prod " })).commentKey).toBe("prod");
  });

  it("defaults an empty root dir to the repository root", () => {
    expect(parsePlanEntries("plan.json=")).toEqual([{ pattern: "plan.json", rootDir: "." }]);
  });

  it("compares severities against fail-on", () => {
    expect(meetsThreshold("critical", "high")).toBe(true);
    expect(meetsThreshold("high", "high")).toBe(true);
    expect(meetsThreshold("medium", "high")).toBe(false);
    expect(meetsThreshold("critical", "none")).toBe(false);
  });
});
