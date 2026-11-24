// End-to-end test of the Action's control flow: real config parsing, git diff, review, rendering
// and comment logic; only the Actions toolkit and the GitHub API are faked.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AgentModule from "../src/agent/agent.js";
import { parseFeedback } from "../src/metrics/feedback.js";
import { checkboxId, parseCommentKey, renderReviewComment } from "../src/report/markdown.js";
import { dbFinding, makeMeta, makeReview } from "./report/builders.js";

const state = vi.hoisted(() => ({
  inputs: {} as Record<string, string>,
  outputs: {} as Record<string, string>,
  failed: [] as string[],
  warnings: [] as string[],
  notices: [] as string[],
  logs: [] as string[],
  secrets: [] as string[],
  summary: "",
  context: {
    eventName: "pull_request",
    payload: {} as Record<string, unknown>,
    repo: { owner: "example-org", repo: "infra" },
    runId: 500,
    runAttempt: 1,
    serverUrl: "https://github.com",
  },
  octokit: null as unknown,
}));

vi.mock("@actions/core", () => ({
  getInput: (name: string) => state.inputs[name] ?? "",
  setOutput: (name: string, value: string) => {
    state.outputs[name] = value;
  },
  setFailed: (msg: string) => {
    state.failed.push(msg);
  },
  setSecret: (s: string) => {
    state.secrets.push(s);
  },
  warning: (msg: string) => {
    state.warnings.push(msg);
  },
  notice: (msg: string) => {
    state.notices.push(msg);
  },
  info: (msg: string) => {
    state.logs.push(msg);
  },
  debug: (msg: string) => {
    state.logs.push(msg);
  },
  summary: {
    addRaw(text: string) {
      state.summary += text;
      return this;
    },
    async write() {
      return this;
    },
  },
}));

vi.mock("@actions/github", () => ({
  context: state.context,
  getOctokit: () => state.octokit,
}));

// The agent is never called over the network here: a stub answers like a failed AI review.
const runAgentReview = vi.hoisted(() => vi.fn());
vi.mock("../src/agent/agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof AgentModule>()),
  runAgentReview,
}));

const { run, upsertComment } = await import("../src/action.js");

const FIXTURE = join(import.meta.dirname, "..", "evals", "fixtures", "db-encryption-replace");
const NOISE_PLAN = join(import.meta.dirname, "..", "evals", "fixtures", "noise-only", "plan.json");
const PASSWORD = "not-a-real-password-123";
const FAKE_API_KEY = "sk-ant-api03-FAKE-KEY-FOR-TESTS-ONLY-000000000000000000000000";
const FAKE_TOKEN = "ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
}

/** A checkout of the fixture: the base commit (PR reverted), then the head commit, plus plan.json. */
function checkout(): { root: string; base: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "tfcr-action-"));
  cpSync(join(FIXTURE, "repo"), root, { recursive: true });
  const diff = join(root, "..", `${root.split("/").pop()}.diff`);
  writeFileSync(diff, readFileSync(join(FIXTURE, "pr.diff")));
  git(root, "init", "-q");
  git(root, "apply", "-R", diff);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "apply", diff);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "head");
  const head = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "plan.json"), readFileSync(join(FIXTURE, "plan.json")));
  return { root, base, head };
}

interface Comment {
  id: number;
  body: string;
  html_url: string;
  created_at: string;
  user: { type: string };
  author_association: string;
}

function fakeOctokit(
  opts: { comments?: Comment[]; failWrite?: boolean; files?: unknown[]; pull?: Record<string, unknown> } = {},
) {
  const comments = opts.comments ?? [];
  const calls: string[] = [];
  const octokit = {
    calls,
    comments,
    rest: {
      issues: {
        listComments: async ({ page }: { page: number }) => {
          calls.push("listComments");
          return { data: page === 1 ? comments : [] };
        },
        createComment: async ({ body }: { body: string }) => {
          calls.push("createComment");
          if (opts.failWrite) throw new Error("Resource not accessible by integration");
          const c: Comment = {
            id: 900 + comments.length,
            body,
            html_url: `https://github.com/example-org/infra/pull/7#issuecomment-${900 + comments.length}`,
            created_at: new Date().toISOString(),
            user: { type: "Bot" },
            author_association: "NONE",
          };
          comments.push(c);
          return { data: { id: c.id, html_url: c.html_url } };
        },
        updateComment: async ({ comment_id, body }: { comment_id: number; body: string }) => {
          calls.push("updateComment");
          const c = comments.find((x) => x.id === comment_id);
          if (!c) throw new Error("not found");
          c.body = body;
          return { data: { id: c.id, html_url: c.html_url } };
        },
      },
      pulls: {
        get: async () => {
          calls.push("pulls.get");
          if (!opts.pull) throw new Error("not used");
          return { data: opts.pull };
        },
        listFiles: async ({ page }: { page: number }) => {
          calls.push("listFiles");
          return { data: page === 1 ? (opts.files ?? []) : [] };
        },
      },
    },
  };
  state.octokit = octokit;
  return octokit;
}

function prPayload(base: string, head: string, headRepo = "example-org/infra") {
  return {
    pull_request: {
      number: 7,
      base: { sha: base, repo: { full_name: "example-org/infra" } },
      head: { sha: head, repo: { full_name: headRepo } },
    },
  };
}

function allText(): string {
  return [
    ...state.logs,
    ...state.warnings,
    ...state.notices,
    ...state.failed,
    state.summary,
    JSON.stringify(state.outputs),
  ].join("\n");
}

beforeEach(() => {
  state.inputs = { "plan-json": "plan.json", "github-token": FAKE_TOKEN };
  state.outputs = {};
  state.failed = [];
  state.warnings = [];
  state.notices = [];
  state.logs = [];
  state.secrets = [];
  state.summary = "";
  state.context.eventName = "pull_request";
  state.context.runId = 500;
  process.env.RUNNER_TEMP = mkdtempSync(join(tmpdir(), "tfcr-runner-"));
  // Set by the runner when this suite itself runs in Actions: tests choose their own.
  delete process.env.GITHUB_WORKFLOW_REF;
  delete process.env.GITHUB_WORKFLOW;
  delete process.env.GITHUB_JOB;
});

describe("run", () => {
  it("reviews the plan, posts one sticky comment and sets every output", async () => {
    const { root, base, head } = checkout();
    process.env.GITHUB_WORKSPACE = root;
    state.context.payload = prPayload(base, head);
    state.inputs["anthropic-api-key"] = "";
    const octokit = fakeOctokit();

    await run();

    expect(state.failed).toEqual([]);
    expect(octokit.calls).toEqual(["listComments", "createComment"]);
    const body = octokit.comments[0]?.body ?? "";
    expect(body.startsWith("<!-- tf-change-reviewer -->\n<!-- tf-change-reviewer:run=500.1 -->")).toBe(true);
    expect(body).toContain("module.orders_db.aws_db_instance.this");
    // Permalinks at the head SHA, and the cause line from the real three-dot git diff.
    expect(body).toContain(`/blob/${head}/main.tf#L12`);
    expect(state.outputs).toMatchObject({ "findings-count": "1", "max-severity": "critical" });
    expect(state.outputs["comment-url"]).toMatch(/issuecomment-900$/);
    const report = JSON.parse(readFileSync(state.outputs["report-json"] ?? "", "utf8")) as {
      totals: { findings: number };
    };
    expect(report.totals.findings).toBe(1);
    expect(state.summary).toContain("Terraform change review");
    expect(state.logs.join("\n")).toMatch(/rules-only review/);
    expect(state.secrets).toContain(FAKE_TOKEN);
    expect(allText()).not.toContain(PASSWORD);
  });

  it("updates its comment on the next run and keeps the reviewers' ticks", async () => {
    const { root, base, head } = checkout();
    process.env.GITHUB_WORKSPACE = root;
    state.context.payload = prPayload(base, head);
    const octokit = fakeOctokit();
    await run();
    const first = octokit.comments[0] as Comment;
    first.body = first.body.replace("- [ ] Confirmed", "- [x] Confirmed");
    state.context.runId = 501;

    await run();

    expect(octokit.calls.filter((c) => c === "createComment")).toHaveLength(1);
    expect(octokit.calls).toContain("updateComment");
    expect(first.body).toContain("tf-change-reviewer:run=501.1");
    expect(first.body).toContain("- [x] Confirmed");
  });

  it("leaves a comment written by a newer run alone", async () => {
    const { root, base, head } = checkout();
    process.env.GITHUB_WORKSPACE = root;
    state.context.payload = prPayload(base, head);
    const newer = "<!-- tf-change-reviewer -->\n<!-- tf-change-reviewer:run=999.1 -->\nnewer";
    const octokit = fakeOctokit({
      comments: [
        {
          id: 1,
          body: newer,
          html_url: "https://github.com/c/1",
          created_at: "2026-11-01T00:00:00Z",
          user: { type: "Bot" },
          author_association: "NONE",
        },
      ],
    });
    await run();
    expect(octokit.calls).toEqual(["listComments"]);
    expect(octokit.comments[0]?.body).toBe(newer);
  });

  it("skips the comment on a fork pull request but still writes the summary", async () => {
    const { root, base, head } = checkout();
    process.env.GITHUB_WORKSPACE = root;
    state.context.payload = prPayload(base, head, "someone/infra-fork");
    const octokit = fakeOctokit();
    await run();
    expect(octokit.calls).toEqual([]);
    expect(state.notices.join("\n")).toMatch(/comes from a fork/);
    expect(state.summary).toContain("module.orders_db.aws_db_instance.this");
    expect(state.failed).toEqual([]);
  });

  describe("workflow_run with a pr-number input (fork pattern)", () => {
    const pull = (base: string, head: string, headRepo = "someone/infra-fork") => ({
      number: 7,
      base: { sha: base, repo: { full_name: "example-org/infra" } },
      head: { sha: head, repo: { full_name: headRepo } },
    });
    const runPayload = (headSha: string, headRepo = "someone/infra-fork") => ({
      workflow_run: { head_sha: headSha, head_repository: { full_name: headRepo }, pull_requests: [] },
    });

    it("comments when the PR's head is the commit the triggering run built", async () => {
      const { root, base, head } = checkout();
      process.env.GITHUB_WORKSPACE = root;
      state.context.eventName = "workflow_run";
      state.context.payload = runPayload(head);
      state.inputs["pr-number"] = "7";
      const octokit = fakeOctokit({ pull: pull(base, head) });
      await run();
      expect(octokit.calls).toContain("createComment");
      expect(state.warnings.join("\n")).not.toMatch(/Not commenting/);
    });

    it("refuses a PR number whose head is another commit (a fork naming someone else's PR)", async () => {
      const { root, base, head } = checkout();
      process.env.GITHUB_WORKSPACE = root;
      state.context.eventName = "workflow_run";
      state.context.payload = runPayload(head);
      state.inputs["pr-number"] = "7";
      const octokit = fakeOctokit({ pull: pull(base, "f".repeat(40)) });
      await run();
      expect(octokit.calls).not.toContain("createComment");
      expect(octokit.calls).not.toContain("updateComment");
      expect(octokit.calls).not.toContain("listFiles");
      expect(state.warnings.join("\n")).toMatch(
        /Not commenting on pull request #7: its head commit ffffffffffff/,
      );
      expect(state.summary).toContain("module.orders_db.aws_db_instance.this");
      expect(state.failed).toEqual([]);
    });

    it("refuses a PR whose head repository is not the triggering run's", async () => {
      const { root, base, head } = checkout();
      process.env.GITHUB_WORKSPACE = root;
      state.context.eventName = "workflow_run";
      state.context.payload = runPayload(head, "someone/infra-fork");
      state.inputs["pr-number"] = "7";
      const octokit = fakeOctokit({ pull: pull(base, head, "other/infra-fork") });
      await run();
      expect(octokit.calls).not.toContain("createComment");
      expect(state.warnings.join("\n")).toMatch(/head repository other\/infra-fork/);
    });
  });

  it("reports a comment it cannot post as a notice, not a failure", async () => {
    const { root, base, head } = checkout();
    process.env.GITHUB_WORKSPACE = root;
    state.context.payload = prPayload(base, head);
    fakeOctokit({ failWrite: true });
    await run();
    expect(state.failed).toEqual([]);
    expect(state.notices.join("\n")).toMatch(/Could not post the PR comment/);
    expect(state.outputs["findings-count"]).toBe("1");
  });

  it("fails the step when a finding meets fail-on", async () => {
    const { root, base, head } = checkout();
    process.env.GITHUB_WORKSPACE = root;
    state.context.payload = prPayload(base, head);
    state.inputs["fail-on"] = "critical";
    fakeOctokit();
    await run();
    expect(state.failed).toEqual([
      'tf-change-reviewer: 1 finding at or above "critical" severity (fail-on).',
    ]);
  });

  it("fails the step under fail-on when a plan errored, even with no findings", async () => {
    const { root, base, head } = checkout();
    const plan = JSON.parse(readFileSync(join(root, "plan.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(
      join(root, "plan.json"),
      JSON.stringify({ ...plan, resource_changes: [], errored: true, complete: false }),
    );
    process.env.GITHUB_WORKSPACE = root;
    state.context.payload = prPayload(base, head);
    fakeOctokit();
    await run();
    expect(state.failed).toEqual([]);
    state.inputs["fail-on"] = "critical";
    state.context.runId = 501;
    await run();
    expect(state.failed).toEqual([
      "tf-change-reviewer: the plan for . errored, so it could not be fully reviewed (fail-on).",
    ]);
  });

  it("reads a UTF-16 plan file (Windows PowerShell 5.1 `>` redirection)", async () => {
    const { root, base, head } = checkout();
    const text = readFileSync(join(root, "plan.json"), "utf8");
    writeFileSync(
      join(root, "plan.json"),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]),
    );
    process.env.GITHUB_WORKSPACE = root;
    state.context.payload = prPayload(base, head);
    const octokit = fakeOctokit();
    await run();
    expect(state.failed).toEqual([]);
    expect(octokit.comments[0]?.body).toMatch(/main\.tf#L12/);
  });

  it("falls back to the API's patches when git has neither commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "tfcr-nogit-"));
    cpSync(join(FIXTURE, "repo"), root, { recursive: true });
    writeFileSync(join(root, "plan.json"), readFileSync(join(FIXTURE, "plan.json")));
    process.env.GITHUB_WORKSPACE = root;
    state.context.payload = prPayload("a".repeat(40), "b".repeat(40));
    const files = readFileSync(join(FIXTURE, "pr.diff"), "utf8")
      .split(/^diff --git /m)
      .filter((part) => part.trim() !== "")
      .map((part) => {
        const name = /^a\/(\S+)/.exec(part)?.[1] ?? "";
        const patch = part.slice(part.indexOf("@@"));
        return { filename: name, status: "modified", patch };
      });
    const octokit = fakeOctokit({ files });
    await run();
    expect(octokit.calls).toContain("listFiles");
    expect(state.warnings.join("\n")).toMatch(/comes from the GitHub API/);
    expect(octokit.comments[0]?.body).toMatch(/main\.tf#L12/);
  });

  it.each([
    ["a binary plan file", "PK\u0003\u0004binary", /binary plan file/],
    [
      "setup-terraform wrapper output",
      "[command]/home/runner/terraform-bin show -json plan.out\nnot json\n::debug::exit 1",
      /terraform_wrapper: false/,
    ],
    [
      "Terraform state",
      JSON.stringify({ version: 4, lineage: "x", resources: [] }),
      /Terraform state, not a plan/,
    ],
  ])("fails with a clear message on %s", async (_what, text, message) => {
    const root = mkdtempSync(join(tmpdir(), "tfcr-bad-"));
    writeFileSync(join(root, "plan.json"), text);
    process.env.GITHUB_WORKSPACE = root;
    state.context.payload = {};
    state.context.eventName = "push";
    fakeOctokit();
    await run();
    expect(state.failed).toHaveLength(1);
    expect(state.failed[0]).toMatch(message);
  });

  it("fails clearly when plan-json matches nothing, and on bad inputs", async () => {
    process.env.GITHUB_WORKSPACE = mkdtempSync(join(tmpdir(), "tfcr-empty-"));
    state.inputs["plan-json"] = "envs/*/plan.json";
    fakeOctokit();
    await run();
    expect(state.failed[0]).toMatch(/matches no file/);
    state.failed = [];
    state.inputs["effort"] = "extreme";
    await run();
    expect(state.failed[0]).toMatch(/Invalid input "effort"/);
  });

  it("masks the API key and runs without a PR outside pull requests", async () => {
    const { root } = checkout();
    process.env.GITHUB_WORKSPACE = root;
    state.context.eventName = "push";
    state.context.payload = {};
    state.inputs["anthropic-api-key"] = FAKE_API_KEY;
    state.inputs["max-cost-usd"] = "0.01";
    state.inputs["timeout-minutes"] = "1";
    const octokit = fakeOctokit();
    runAgentReview.mockResolvedValueOnce({
      verdict: null,
      info: {
        model: "claude-opus-5-5",
        turns: 0,
        toolCalls: 0,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 1,
        status: "error",
        error: `401 invalid x-api-key ${FAKE_API_KEY}`,
      },
    });
    await run();
    expect(runAgentReview).toHaveBeenCalledTimes(1);
    const opts = runAgentReview.mock.calls[0]?.[1] as {
      maxCostUsd: number;
      timeoutMs: number;
      apiKey: string;
    };
    expect(opts).toMatchObject({ maxCostUsd: 0.01, apiKey: FAKE_API_KEY });
    expect(opts.timeoutMs).toBeLessThanOrEqual(60_000);
    expect(state.secrets).toContain(FAKE_API_KEY);
    expect(octokit.calls).toEqual([]);
    expect(state.logs.join("\n")).toMatch(/Not a pull request run/);
    expect(existsSync(state.outputs["report-json"] ?? "")).toBe(true);
    expect(allText()).not.toContain(FAKE_API_KEY);
  });

  describe("plan files the fork controls (workflow_run pattern)", () => {
    it("refuses a plan path that is a symlink, and never writes into it", async () => {
      const { root, base, head } = checkout();
      process.env.GITHUB_WORKSPACE = root;
      state.context.payload = prPayload(base, head);
      // A fork commits plan.json as a link to a file outside the checkout (e.g. the action's own code).
      const victim = join(mkdtempSync(join(tmpdir(), "tfcr-victim-")), "index.js");
      writeFileSync(victim, "original");
      const linkDir = join(root, "infra");
      mkdirSync(linkDir);
      symlinkSync(victim, join(linkDir, "plan.json"));
      state.inputs["plan-json"] = "infra/plan.json";
      const octokit = fakeOctokit();
      await run();
      expect(state.failed).toHaveLength(1);
      expect(state.failed[0]).toMatch(/infra\/plan\.json: the plan file is a symbolic link/);
      expect(octokit.calls).not.toContain("createComment");
      expect(readFileSync(victim, "utf8")).toBe("original");
    });

    it("refuses a plan reached through a symlinked directory that leaves the checkout", async () => {
      const { root, base, head } = checkout();
      process.env.GITHUB_WORKSPACE = root;
      state.context.payload = prPayload(base, head);
      const outside = mkdtempSync(join(tmpdir(), "tfcr-outside-"));
      writeFileSync(join(outside, "plan.json"), readFileSync(join(FIXTURE, "plan.json")));
      symlinkSync(outside, join(root, "infra"));
      state.inputs["plan-json"] = "infra/plan.json";
      fakeOctokit();
      await run();
      expect(state.failed[0]).toMatch(/resolves outside the checkout and RUNNER_TEMP/);
    });

    it("reads a plan kept under RUNNER_TEMP, outside the checkout", async () => {
      const { root, base, head } = checkout();
      process.env.GITHUB_WORKSPACE = root;
      state.context.payload = prPayload(base, head);
      const temp = process.env.RUNNER_TEMP ?? "";
      mkdirSync(join(temp, "plan"));
      writeFileSync(join(temp, "plan", "plan.json"), readFileSync(join(FIXTURE, "plan.json")));
      state.inputs["plan-json"] = `${temp}/plan/plan.json=.`;
      const octokit = fakeOctokit();
      await run();
      expect(state.failed).toEqual([]);
      expect(octokit.comments[0]?.body).toContain(`/blob/${head}/main.tf#L12`);
    });

    it("refuses an absolute plan path outside the checkout and RUNNER_TEMP", async () => {
      const { root } = checkout();
      process.env.GITHUB_WORKSPACE = root;
      state.context.eventName = "push";
      state.context.payload = {};
      const elsewhere = mkdtempSync(join(tmpdir(), "tfcr-elsewhere-"));
      writeFileSync(join(elsewhere, "plan.json"), readFileSync(join(FIXTURE, "plan.json")));
      state.inputs["plan-json"] = `${elsewhere}/plan.json=.`;
      fakeOctokit();
      await run();
      expect(state.failed[0]).toMatch(/outside the checkout and RUNNER_TEMP/);
    });

    it("writes the report under RUNNER_TEMP, never into the checkout", async () => {
      const { root } = checkout();
      process.env.GITHUB_WORKSPACE = root;
      state.context.eventName = "push";
      state.context.payload = {};
      const saved = process.env.RUNNER_TEMP;
      delete process.env.RUNNER_TEMP;
      try {
        fakeOctokit();
        await run();
      } finally {
        process.env.RUNNER_TEMP = saved;
      }
      expect(state.failed).toEqual([]);
      expect(state.outputs["report-json"]?.startsWith(root)).toBe(false);
      expect(existsSync(join(root, "tf-change-reviewer"))).toBe(false);
    });
  });

  it("does not comment under workflow_run when the pull request cannot be read (fails closed)", async () => {
    const { root, head } = checkout();
    process.env.GITHUB_WORKSPACE = root;
    state.context.eventName = "workflow_run";
    state.context.payload = {
      workflow_run: {
        head_sha: head,
        head_repository: { full_name: "someone/infra-fork" },
        pull_requests: [],
      },
    };
    state.inputs["pr-number"] = "42"; // an issue number from the fork's artifact: pulls.get answers 404
    const octokit = fakeOctokit();
    await run();
    expect(octokit.calls).toEqual(["pulls.get"]);
    expect(state.warnings.join("\n")).toMatch(/Not commenting on pull request #42: could not read it/);
    expect(state.summary).toContain("module.orders_db.aws_db_instance.this");
    expect(state.failed).toEqual([]);
  });

  it("keeps one sticky comment per plan set: matrix jobs of one run do not overwrite each other", async () => {
    const { root, base, head } = checkout();
    mkdirSync(join(root, "envs", "prod"), { recursive: true });
    mkdirSync(join(root, "envs", "staging"), { recursive: true });
    writeFileSync(join(root, "envs", "prod", "plan.json"), readFileSync(join(FIXTURE, "plan.json")));
    writeFileSync(join(root, "envs", "staging", "plan.json"), readFileSync(NOISE_PLAN));
    process.env.GITHUB_WORKSPACE = root;
    state.context.payload = prPayload(base, head);
    const octokit = fakeOctokit();
    state.inputs["plan-json"] = "envs/prod/plan.json";
    await run();
    // Job B of the same run (same run id and attempt), another environment.
    state.inputs["plan-json"] = "envs/staging/plan.json";
    await run();
    expect(octokit.calls.filter((c) => c === "createComment")).toHaveLength(2);
    expect(octokit.comments).toHaveLength(2);
    expect(octokit.comments[0]?.body).toContain("orders_db");
    // Job A again (re-run): updates its own comment, not job B's.
    state.inputs["plan-json"] = "envs/prod/plan.json";
    state.context.runId = 501;
    await run();
    expect(octokit.comments).toHaveLength(2);
    expect(octokit.comments[0]?.body).toContain("run=501.1");
    expect(octokit.comments[1]?.body).toContain("run=500.1");
    // An explicit comment-key overrides the plan-derived one.
    state.inputs["comment-key"] = "prod";
    state.context.runId = 502;
    await run();
    expect(octokit.comments).toHaveLength(3);
  });

  it("keeps one sticky comment when plan-json names the same plans in other words", async () => {
    const { root, base, head } = checkout();
    process.env.GITHUB_WORKSPACE = root;
    state.context.payload = prPayload(base, head);
    const octokit = fakeOctokit();
    for (const [i, spelling] of [
      "plan.json",
      "./plan.json",
      "plan.json\n./plan.json",
      ".//plan.json",
    ].entries()) {
      state.inputs["plan-json"] = spelling;
      state.context.runId = 500 + i;
      await run();
    }
    expect(octokit.calls.filter((c) => c === "createComment")).toHaveLength(1);
    expect(octokit.comments).toHaveLength(1);
    expect(octokit.comments[0]?.body).toContain("run=503.1");
  });

  it("takes over its own job's comment after plan-json changes, never another job's", async () => {
    const { root, base, head } = checkout();
    mkdirSync(join(root, "envs", "qa"), { recursive: true });
    writeFileSync(join(root, "envs", "qa", "plan.json"), readFileSync(NOISE_PLAN));
    process.env.GITHUB_WORKSPACE = root;
    process.env.GITHUB_WORKFLOW_REF = "example-org/infra/.github/workflows/tf.yml@refs/pull/7/merge";
    process.env.GITHUB_JOB = "review";
    state.context.payload = prPayload(base, head);
    const octokit = fakeOctokit();
    await run();
    // The PR adds an environment to the job's plan-json: same job, new plan set.
    state.inputs["plan-json"] = "plan.json\nenvs/qa/plan.json";
    state.context.runId = 501;
    await run();
    expect(octokit.comments).toHaveLength(1);
    expect(octokit.comments[0]?.body).toContain("run=501.1");
    expect(octokit.comments[0]?.body).toContain("envs/qa");
    // Another workflow (its own plan set) gets its own comment, and does not take this one over.
    process.env.GITHUB_WORKFLOW_REF = "example-org/infra/.github/workflows/other.yml@refs/pull/7/merge";
    state.inputs["plan-json"] = "envs/qa/plan.json";
    state.context.runId = 502;
    await run();
    expect(octokit.comments).toHaveLength(2);
    expect(octokit.comments[0]?.body).toContain("run=501.1");
    // Nor does the first workflow take the other one's over on its next run.
    process.env.GITHUB_WORKFLOW_REF = "example-org/infra/.github/workflows/tf.yml@refs/pull/7/merge";
    state.inputs["plan-json"] = "plan.json\nenvs/qa/plan.json";
    state.context.runId = 503;
    await run();
    expect(octokit.comments).toHaveLength(2);
    expect(octokit.comments[0]?.body).toContain("run=503.1");
    expect(octokit.comments[1]?.body).toContain("run=502.1");
  });

  it("matrix jobs of one workflow job never take over each other's comments", async () => {
    const { root, base, head } = checkout();
    for (const env of ["prod", "staging", "qa"]) {
      mkdirSync(join(root, "envs", env), { recursive: true });
      writeFileSync(join(root, "envs", env, "plan.json"), readFileSync(NOISE_PLAN));
    }
    process.env.GITHUB_WORKSPACE = root;
    process.env.GITHUB_WORKFLOW_REF = "example-org/infra/.github/workflows/tf.yml@refs/heads/main";
    process.env.GITHUB_JOB = "review";
    state.context.payload = prPayload(base, head);
    const octokit = fakeOctokit();
    // Run 500: one matrix job, then a sibling of the same run with another plan set.
    state.inputs["plan-json"] = "envs/prod/plan.json";
    await run();
    state.inputs["plan-json"] = "envs/staging/plan.json";
    await run();
    expect(octokit.comments).toHaveLength(2);
    // Run 501 adds a third environment to the matrix: it runs first and must not take one over.
    state.context.runId = 501;
    state.inputs["plan-json"] = "envs/qa/plan.json";
    await run();
    expect(octokit.comments).toHaveLength(3);
    expect(octokit.comments.map((c) => /run=(\d+)/.exec(c.body)?.[1])).toEqual(["500", "500", "501"]);
  });

  it("a matrix leg never takes over the only comment a sibling left in an earlier run", async () => {
    const { root, base, head } = checkout();
    for (const env of ["prod", "staging"]) {
      mkdirSync(join(root, "envs", env), { recursive: true });
      writeFileSync(join(root, "envs", env, "plan.json"), readFileSync(join(FIXTURE, "plan.json")));
    }
    process.env.GITHUB_WORKSPACE = root;
    process.env.GITHUB_WORKFLOW_REF = "example-org/infra/.github/workflows/tf.yml@refs/heads/main";
    process.env.GITHUB_JOB = "review";
    state.context.payload = prPayload(base, head);
    const octokit = fakeOctokit();
    // Run 500: only the prod leg comments (the staging leg failed before the action ran).
    state.inputs["plan-json"] = "envs/prod/plan.json";
    await run();
    expect(octokit.comments).toHaveLength(1);
    const prod = octokit.comments[0]!;
    prod.body = prod.body.replace("- [ ] Confirmed", "- [x] Confirmed");
    const prodKey = parseCommentKey(prod.body);
    // Run 501: the staging leg finishes first and gets its own comment.
    state.context.runId = 501;
    state.inputs["plan-json"] = "envs/staging/plan.json";
    await run();
    expect(octokit.comments).toHaveLength(2);
    expect(parseCommentKey(octokit.comments[0]!.body)).toBe(prodKey);
    expect(octokit.comments[0]!.body).toContain("run=500.1");
    expect(octokit.comments[1]!.body).not.toContain("envs/prod");
    // Then the prod leg updates its own comment and keeps the reviewer's tick.
    state.inputs["plan-json"] = "envs/prod/plan.json";
    await run();
    expect(octokit.comments).toHaveLength(2);
    expect(octokit.comments[0]!.body).toContain("run=501.1");
    expect(octokit.comments[0]!.body).toContain("- [x] Confirmed");
    // A job that gains a second action step, placed before its existing one, with other plans.
    const steps = fakeOctokit();
    state.context.runId = 600;
    state.inputs["plan-json"] = "envs/prod/plan.json";
    await run();
    state.context.runId = 601;
    state.inputs["plan-json"] = "envs/staging/plan.json";
    await run();
    state.inputs["plan-json"] = "envs/prod/plan.json";
    await run();
    expect(steps.comments.map((c) => [parseCommentKey(c.body), /run=(\d+)/.exec(c.body)?.[1]])).toEqual([
      [prodKey, "601"],
      [parseCommentKey(octokit.comments[1]!.body), "601"],
    ]);
  });

  it("adopts a comment written before comments had keys", async () => {
    const { root, base, head } = checkout();
    process.env.GITHUB_WORKSPACE = root;
    state.context.payload = prPayload(base, head);
    const octokit = fakeOctokit({
      comments: [
        {
          id: 1,
          body: "<!-- tf-change-reviewer -->\n<!-- tf-change-reviewer:run=400.1 -->\nold",
          html_url: "https://github.com/c/1",
          created_at: "2026-11-01T00:00:00Z",
          user: { type: "Bot" },
          author_association: "NONE",
        },
      ],
    });
    await run();
    expect(octokit.calls).toEqual(["listComments", "updateComment"]);
    expect(octokit.comments[0]?.body).toMatch(/tf-change-reviewer:key=[0-9a-f]{12}/);
  });

  it("keeps a confirmed finding in the data marker after the next push fixes it", async () => {
    const { root, base, head } = checkout();
    process.env.GITHUB_WORKSPACE = root;
    state.context.payload = prPayload(base, head);
    const octokit = fakeOctokit();
    await run();
    const c = octokit.comments[0] as Comment;
    c.body = c.body.replace("- [ ] Confirmed", "- [x] Confirmed");
    // The author fixes it: the next plan has no finding.
    writeFileSync(join(root, "plan.json"), readFileSync(NOISE_PLAN));
    state.context.runId = 501;
    await run();
    expect(octokit.comments).toHaveLength(1);
    const fb = parseFeedback(c.body, []);
    expect(fb.findings).toMatchObject([
      { address: "module.orders_db.aws_db_instance.this", confirmed: true, earlier: true },
    ]);
    expect(fb.hasFeedback).toBe(true);
    // And it stays there on the run after.
    state.context.runId = 502;
    await run();
    expect(parseFeedback(c.body, []).findings).toMatchObject([{ confirmed: true, earlier: true }]);
  });

  it("shows a PR-level diff warning once, not once per root module", async () => {
    const root = mkdtempSync(join(tmpdir(), "tfcr-nogit-"));
    cpSync(join(FIXTURE, "repo"), root, { recursive: true });
    for (const env of ["a", "b", "c"]) {
      mkdirSync(join(root, "envs", env), { recursive: true });
      writeFileSync(join(root, "envs", env, "plan.json"), readFileSync(NOISE_PLAN));
    }
    process.env.GITHUB_WORKSPACE = root;
    state.context.payload = prPayload("a".repeat(40), "b".repeat(40));
    state.inputs["plan-json"] = "envs/*/plan.json";
    const octokit = fakeOctokit({ files: [] });
    await run();
    const body = octokit.comments[0]?.body ?? "";
    expect(body.match(/comes from the GitHub API/g)).toHaveLength(1);
    const report = JSON.parse(readFileSync(state.outputs["report-json"] ?? "", "utf8")) as {
      warnings?: string[];
      reviews: { warnings: string[] }[];
    };
    expect(report.warnings?.join("\n")).toMatch(/comes from the GitHub API/);
    expect(report.reviews.every((r) => !r.warnings.join("\n").includes("GitHub API"))).toBe(true);
  });

  it("warns when the checkout is not the PR head (e.g. the merge commit)", async () => {
    const { root, base, head } = checkout();
    git(root, "commit", "-q", "--allow-empty", "-m", "merge-ish");
    process.env.GITHUB_WORKSPACE = root;
    state.context.payload = prPayload(base, head);
    const octokit = fakeOctokit();
    await run();
    expect(state.warnings.join("\n")).toMatch(/checkout is not the pull request's head commit/);
    expect(octokit.comments[0]?.body).toMatch(/checkout is not the pull request/);
  });

  it("carries a tick over from a comment written with bare (pre-root) checkbox keys", async () => {
    const review = makeReview({ rootModuleDir: "infra", findings: [dbFinding()] });
    const key = checkboxId("f-3a9c1e07", "infra");
    const legacy = renderReviewComment([review], makeMeta())
      .replaceAll(key, "f-3a9c1e07")
      .replace("- [ ] Confirmed", "- [x] Confirmed");
    let written = "";
    const port = {
      findComment: async () => ({ id: 1, body: legacy, htmlUrl: "u" }),
      updateComment: async (_id: number, body: string) => {
        written = body;
        return { id: 1, htmlUrl: "u" };
      },
      createComment: async () => ({ id: 2, htmlUrl: "u2" }),
      getPull: async () => {
        throw new Error("unused");
      },
      listPullFiles: async () => ({ files: [], truncated: false }),
    };
    await upsertComment(port, 7, [review], makeMeta({ run: { id: 9002, attempt: 1 } }));
    expect(written).toContain(`- [x] Confirmed: this needs attention <!-- finding:${key} -->`);
    const fb = parseFeedback(written, []);
    expect(fb.findings.map((f) => [f.id, f.confirmed])).toEqual([[key, true]]);
  });

  it("does not hand a legacy bare-key tick of a subdirectory root to the repository root's finding", async () => {
    // Before root-qualified keys the first root rendered got the bare id, so with `**/plan.json`
    // ordering envs/a held `f-3a9c1e07` and the repository root held `f-3a9c1e07~2`.
    const sub = makeReview({ rootModuleDir: "envs/a", findings: [dbFinding()] });
    const top = makeReview({ rootModuleDir: ".", findings: [dbFinding()] });
    const subKey = checkboxId("f-3a9c1e07", "envs/a");
    const legacy = renderReviewComment([sub, top], makeMeta())
      .replace(/f-3a9c1e07(?![:~\w])/g, "f-3a9c1e07~2")
      .replaceAll(subKey, "f-3a9c1e07")
      .replace("- [ ] Confirmed", "- [x] Confirmed");
    expect(legacy).toMatch(/- \[x\] Confirmed: this needs attention <!-- finding:f-3a9c1e07 -->/);
    let written = "";
    const port = {
      findComment: async () => ({ id: 1, body: legacy, htmlUrl: "u" }),
      updateComment: async (_id: number, body: string) => {
        written = body;
        return { id: 1, htmlUrl: "u" };
      },
      createComment: async () => ({ id: 2, htmlUrl: "u2" }),
      getPull: async () => {
        throw new Error("unused");
      },
      listPullFiles: async () => ({ files: [], truncated: false }),
    };
    await upsertComment(port, 7, [sub, top], makeMeta({ run: { id: 9002, attempt: 1 } }));
    const fb = parseFeedback(written, []);
    expect(fb.findings.map((f) => [f.root, f.confirmed])).toEqual([
      ["envs/a", true],
      [".", false],
    ]);
  });
});
