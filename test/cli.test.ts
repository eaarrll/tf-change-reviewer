import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main, type CliDeps } from "../src/cli.js";
import type { MetricsOctokit } from "../src/metrics/github.js";
import { renderReviewComment } from "../src/report/markdown.js";
import { scriptedClient, verdictReply } from "./helpers/anthropic.js";
import { dbFinding, makeMeta, makeReview } from "./report/builders.js";

const FIXTURE = join(import.meta.dirname, "..", "evals", "fixtures", "db-encryption-replace");
const PLAN = join(FIXTURE, "plan.json");
const DIFF = join(FIXTURE, "pr.diff");
const REPO = join(FIXTURE, "repo");
const DB = "module.orders_db.aws_db_instance.this";

function harness(over: Partial<CliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: Partial<CliDeps> = {
    env: {},
    cwd: FIXTURE,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    readStdin: async () => readFileSync(PLAN, "utf8"),
    gitDiff: async () => {
      throw new Error("git not used");
    },
    isTTY: false,
    ...over,
  };
  return { deps, out: () => out.join(""), err: () => err.join("") };
}

const reviewArgs = ["review", "--plan", PLAN, "--repo", REPO, "--root-dir", "."];

describe("tf-change-reviewer review", () => {
  it("prints the text report and exits 0", async () => {
    const h = harness();
    expect(await main([...reviewArgs, "--diff", DIFF], h.deps)).toBe(0);
    expect(h.out()).toContain("Terraform change review: 1 finding needs your attention (of 25 in the plan)");
    expect(h.out()).toContain("main.tf:12");
    expect(h.out()).not.toContain("not-a-real-password-123");
    expect(h.err()).toMatch(/ANTHROPIC_API_KEY is not set/);
  });

  it("reads a UTF-16 plan file (Windows PowerShell 5.1 `>` redirection)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tfcr-cli-utf16-"));
    const utf16 = join(dir, "plan.json");
    writeFileSync(
      utf16,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(readFileSync(PLAN, "utf8"), "utf16le")]),
    );
    const h = harness();
    expect(
      await main(["review", "--plan", utf16, "--repo", REPO, "--root-dir", ".", "--diff", DIFF], h.deps),
    ).toBe(0);
    expect(h.out()).toContain("Terraform change review: 1 finding needs your attention (of 25 in the plan)");
  });

  it("never shows a green check for an errored plan", async () => {
    const plan = JSON.parse(readFileSync(PLAN, "utf8")) as Record<string, unknown>;
    const errored = JSON.stringify({ ...plan, resource_changes: [], errored: true, complete: false });
    const h = harness({ readStdin: async () => errored });
    await main(["review", "--plan", "-", "--repo", REPO, "--format", "markdown"], h.deps);
    expect(h.out()).not.toContain("✅");
    expect(h.out()).toContain("⚠️ **No changes in this plan**");
    // Nor a summary sentence saying the opposite, in any format; JSON says the plan is incomplete.
    expect(h.out()).not.toMatch(/No changes: the infrastructure matches/);
    const text = harness({ readStdin: async () => errored });
    await main(["review", "--plan", "-", "--repo", REPO], text.deps);
    expect(text.out()).toMatch(/plan is incomplete/);
    expect(text.out()).not.toMatch(/No changes: the infrastructure matches/);
    const json = harness({ readStdin: async () => errored });
    await main(["review", "--plan", "-", "--repo", REPO, "--format", "json"], json.deps);
    expect(
      (JSON.parse(json.out()) as { reviews: { planIncomplete?: boolean }[] }).reviews[0]?.planIncomplete,
    ).toBe(true);
    const complete = harness();
    await main([...reviewArgs, "--diff", DIFF, "--format", "json"], complete.deps);
    expect(complete.out()).not.toContain("planIncomplete");
  });

  it("fails --fail-on for an errored plan with no findings, but not a partial one", async () => {
    const plan = JSON.parse(readFileSync(PLAN, "utf8")) as Record<string, unknown>;
    const exitFor = async (extra: Record<string, unknown>, failOn: string) => {
      const h = harness({
        readStdin: async () => JSON.stringify({ ...plan, resource_changes: [], ...extra }),
      });
      return main(["review", "--plan", "-", "--repo", REPO, "--fail-on", failOn], h.deps);
    };
    expect(await exitFor({ errored: true, complete: false }, "critical")).toBe(3);
    expect(await exitFor({ errored: true, complete: false }, "none")).toBe(0);
    expect(await exitFor({ errored: false, complete: false }, "critical")).toBe(0);
    expect(await exitFor({ errored: false }, "critical")).toBe(0);
  });

  it("exits 3 when a finding meets --fail-on", async () => {
    const h = harness();
    expect(await main([...reviewArgs, "--diff", DIFF, "--fail-on", "critical"], h.deps)).toBe(3);
    expect(await main([...reviewArgs, "--diff", DIFF, "--fail-on", "none"], harness().deps)).toBe(0);
  });

  it("writes JSON and markdown", async () => {
    const j = harness();
    await main([...reviewArgs, "--diff", DIFF, "--format", "json"], j.deps);
    const report = JSON.parse(j.out()) as { reviews: { findings: { address: string }[] }[] };
    expect(report.reviews[0]?.findings[0]?.address).toBe(DB);
    const m = harness();
    await main([...reviewArgs, "--diff", DIFF, "--format", "markdown"], m.deps);
    expect(m.out().startsWith("<!-- tf-change-reviewer -->")).toBe(true);
  });

  it("diffs against --base with git, and reads the plan from stdin", async () => {
    let asked: [string, string] | null = null;
    const h = harness({
      gitDiff: async (repo, base) => {
        asked = [repo, base];
        return readFileSync(DIFF, "utf8");
      },
    });
    expect(
      await main(
        ["review", "--plan", "-", "--repo", REPO, "--base", "origin/main", "--format", "json"],
        h.deps,
      ),
    ).toBe(0);
    expect(asked).toEqual([REPO, "origin/main"]);
    const report = JSON.parse(h.out()) as {
      reviews: { findings: { causeLinks: { changedInDiff: boolean }[] }[] }[];
    };
    expect(report.reviews[0]?.findings[0]?.causeLinks.some((l) => l.changedInDiff)).toBe(true);
  });

  it("defaults the root module dir to the plan file's directory", async () => {
    const h = harness();
    // plan.json sits in the fixture dir, which is not the repo: the repo root is used.
    expect(
      await main(["review", "--plan", PLAN, "--repo", REPO, "--diff", DIFF, "--rules-only"], h.deps),
    ).toBe(0);
    expect(h.err()).not.toMatch(/ANTHROPIC_API_KEY/);
  });

  it("runs the AI review when a key (or client) is there, unless --rules-only", async () => {
    const { client, requests } = scriptedClient([
      verdictReply({ summary: "The orders database is replaced.", findings: [], dismissed: [] }),
    ]);
    const h = harness({ env: { ANTHROPIC_API_KEY: "sk-test" }, anthropicClient: client });
    await main([...reviewArgs, "--diff", DIFF, "--format", "json", "--effort", "low"], h.deps);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.raw).toContain('"effort":"low"');
    const report = JSON.parse(h.out()) as { reviews: { summary: string; agent: { status: string } }[] };
    expect(report.reviews[0]).toMatchObject({
      summary: "The orders database is replaced.",
      agent: { status: "complete" },
    });

    const r = harness({ env: { ANTHROPIC_API_KEY: "sk-test" }, anthropicClient: client });
    await main([...reviewArgs, "--diff", DIFF, "--format", "json", "--rules-only"], r.deps);
    expect(requests).toHaveLength(1);
  });

  it.each([
    [["review"], /--plan is required/],
    [[...reviewArgs, "--base", "main", "--diff", DIFF], /conflict/],
    [["review", "--plan", "-", "--diff", "-"], /both read stdin/],
    [[...reviewArgs, "--format", "html"], /--format must be one of/],
    [[...reviewArgs, "--max-findings", "0"], /--max-findings must be an integer/],
    [["deploy"], /unknown command/],
    [["review", "--nope"], /Unknown option/],
  ])("exits 2 on usage errors: %j", async (args, message) => {
    const h = harness();
    expect(await main(args, h.deps)).toBe(2);
    expect(h.err()).toMatch(message);
  });

  it("exits 1 with a clear message on a plan that is not a plan", async () => {
    const h = harness({ readStdin: async () => "Terraform will perform the following actions:\n" });
    expect(await main(["review", "--plan", "-", "--repo", REPO], h.deps)).toBe(1);
    expect(h.err()).toMatch(/human-readable plan output, not JSON/);
  });

  it("prints help and the version", async () => {
    const h = harness();
    expect(await main(["--help"], h.deps)).toBe(0);
    expect(h.out()).toContain("tf-change-reviewer review --plan");
    expect(await main(["--version"], harness().deps)).toBe(0);
  });
});

describe("tf-change-reviewer metrics", () => {
  function fakeOctokit(): MetricsOctokit {
    const body = renderReviewComment([makeReview({ findings: [dbFinding()] })], makeMeta()).replace(
      "- [ ] Confirmed",
      "- [x] Confirmed",
    );
    return {
      rest: {
        pulls: {
          list: async ({ page }) => ({
            data: page === 1 ? [{ number: 3, updated_at: "2026-11-20T00:00:00Z" }] : [],
          }),
          listReviews: async () => ({ data: [] }),
          listReviewComments: async () => ({ data: [] }),
        },
        issues: {
          listComments: async ({ page }) => ({
            data:
              page === 1
                ? [
                    { id: 1, body, updated_at: "2026-11-20T00:00:00Z", user: { type: "Bot" } },
                    {
                      id: 2,
                      body: "missed: aws_s3_bucket.forgotten",
                      updated_at: "2026-11-21T00:00:00Z",
                      author_association: "MEMBER",
                    },
                  ]
                : [],
          }),
        },
      },
    };
  }

  it("reads PR feedback through the API and prints precision and recall", async () => {
    let token = "";
    const h = harness({
      env: { GITHUB_TOKEN: "ghp_test" },
      octokit: async (t) => {
        token = t;
        return fakeOctokit();
      },
    });
    expect(await main(["metrics", "--repo", "example-org/infra", "--since", "2026-11-01"], h.deps)).toBe(0);
    expect(token).toBe("ghp_test");
    expect(h.out()).toContain("feedback metrics");
    expect(h.out()).toContain("aws_s3_bucket.forgotten");
  });

  it("needs a token and a valid repo", async () => {
    const h = harness();
    expect(await main(["metrics", "--repo", "example-org/infra"], h.deps)).toBe(1);
    expect(h.err()).toMatch(/GITHUB_TOKEN is not set/);
    expect(await main(["metrics", "--repo", "nope"], harness().deps)).toBe(2);
    expect(await main(["metrics", "--repo", "a/b", "--since", "yesterday"], harness().deps)).toBe(2);
  });
});
