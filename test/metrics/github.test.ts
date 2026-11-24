import { describe, expect, it } from "vitest";
import { computeMetrics } from "../../src/metrics/feedback.js";
import type { IssueComment, MetricsOctokit, PullSummary } from "../../src/metrics/github.js";
import { collectFeedback, renderMetrics } from "../../src/metrics/github.js";
import { renderReviewComment } from "../../src/report/markdown.js";
import { dbFinding, makeMeta, makeReview, sgFinding } from "../report/builders.js";

const ZWSP = "​";

function botBody(run = 1): string {
  return renderReviewComment(
    [makeReview({ findings: [dbFinding(), sgFinding()] })],
    makeMeta({ run: { id: run, attempt: 1 } }),
  );
}

function ticked(body: string): string {
  return body.replace(
    "- [ ] Confirmed: this needs attention <!-- finding:f-3a9c1e07 -->",
    "- [x] Confirmed: this needs attention <!-- finding:f-3a9c1e07 -->",
  );
}

interface Calls {
  pulls: { page: number; per_page: number; state: string; sort: string; direction: string }[];
  comments: { issue_number: number; page: number }[];
}

/** Fake Octokit over an in-memory list of PRs (newest first), their comments, reviews and inline comments. */
function fakeOctokit(
  prs: PullSummary[],
  comments: Record<number, IssueComment[]>,
  reviews: Record<number, IssueComment[]> = {},
  inline: Record<number, IssueComment[]> = {},
): { octokit: MetricsOctokit; calls: Calls } {
  const calls: Calls = { pulls: [], comments: [] };
  const octokit: MetricsOctokit = {
    rest: {
      pulls: {
        list: async (p) => {
          calls.pulls.push({
            page: p.page,
            per_page: p.per_page,
            state: p.state,
            sort: p.sort,
            direction: p.direction,
          });
          return { data: prs.slice((p.page - 1) * p.per_page, p.page * p.per_page) };
        },
        listReviews: async (p) => ({
          data: (reviews[p.pull_number] ?? []).slice((p.page - 1) * p.per_page, p.page * p.per_page),
        }),
        listReviewComments: async (p) => ({
          data: (inline[p.pull_number] ?? []).slice((p.page - 1) * p.per_page, p.page * p.per_page),
        }),
      },
      issues: {
        listComments: async (p) => {
          calls.comments.push({ issue_number: p.issue_number, page: p.page });
          const all = comments[p.issue_number] ?? [];
          return { data: all.slice((p.page - 1) * p.per_page, p.page * p.per_page) };
        },
      },
    },
  };
  return { octokit, calls };
}

function pull(number: number, updated: string): PullSummary {
  return { number, updated_at: updated, html_url: `https://github.com/example-org/infra/pull/${number}` };
}

/** A comment by `login`: a bot for "bot" and "*[bot]" logins, else a repository member unless `association` says otherwise. */
function comment(
  id: number,
  body: string,
  login = "alice",
  updated = "2026-11-20T00:00:00Z",
  association?: string,
): IssueComment {
  const bot = login === "bot" || login.endsWith("[bot]");
  return {
    id,
    body,
    user: { login, type: bot ? "Bot" : "User" },
    author_association: association ?? (bot ? "NONE" : "MEMBER"),
    updated_at: updated,
  };
}

describe("collectFeedback", () => {
  it("lists PRs by most recently updated and parses each one's feedback", async () => {
    const { octokit, calls } = fakeOctokit(
      [pull(7, "2026-11-23T10:00:00Z"), pull(6, "2026-11-22T10:00:00Z")],
      {
        7: [
          comment(1, ticked(botBody()), "github-actions[bot]"),
          comment(2, "missed: `aws_s3_bucket.logs`", "alice"),
        ],
        6: [comment(3, "LGTM", "bob")],
      },
    );
    const out = await collectFeedback(octokit, { owner: "example-org", repo: "infra" });
    expect(calls.pulls[0]).toEqual({
      page: 1,
      per_page: 100,
      state: "all",
      sort: "updated",
      direction: "desc",
    });
    expect(out.map((f) => f.pr?.number)).toEqual([7, 6]);
    const [seven, six] = out;
    expect(seven?.pr).toEqual({
      number: 7,
      updatedAt: "2026-11-23T10:00:00Z",
      url: "https://github.com/example-org/infra/pull/7",
    });
    expect(seven?.hasReview).toBe(true);
    expect(seven?.hasFeedback).toBe(true);
    expect(seven?.findings.map((f) => f.confirmed)).toEqual([true, false]);
    expect(seven?.missed).toEqual(["aws_s3_bucket.logs"]);
    expect(six?.hasReview).toBe(false);
    expect(six?.hasFeedback).toBe(false);
  });

  it("never reads the bot's own comment as a reply", async () => {
    // The footer says "Reply `missed: <address>`"; a body that names an address must not count either.
    const body = `${botBody()}\nmissed: aws_s3_bucket.logs`;
    const { octokit } = fakeOctokit([pull(1, "2026-11-23T00:00:00Z")], { 1: [comment(1, body, "bot")] });
    const [fb] = await collectFeedback(octokit, { owner: "o", repo: "r" });
    expect(fb?.missed).toEqual([]);
    expect(fb?.hasFeedback).toBe(false);
  });

  it("uses the most recently updated bot comment and ignores older ones", async () => {
    const old = ticked(botBody(1)).replace(/f-3a9c1e07/g, "f-old");
    const { octokit } = fakeOctokit([pull(1, "2026-11-23T00:00:00Z")], {
      1: [
        comment(1, old, "bot", "2026-11-20T00:00:00Z"),
        comment(2, botBody(2), "bot", "2026-11-22T00:00:00Z"),
        comment(3, "missed: aws_iam_role.app", "alice", "2026-11-21T00:00:00Z"),
      ],
    });
    const [fb] = await collectFeedback(octokit, { owner: "o", repo: "r" });
    expect(fb?.findings.map((f) => f.id)).toEqual(["f-3a9c1e07", "f-77b2d410"]);
    expect(fb?.findings.every((f) => !f.confirmed)).toBe(true);
    expect(fb?.missed).toEqual(["aws_iam_role.app"]);
  });

  it("paginates PRs and comments", async () => {
    const prs = Array.from({ length: 150 }, (_, i) =>
      pull(1000 - i, `2026-11-${String(23 - Math.floor(i / 10)).padStart(2, "0")}T00:00:00Z`),
    );
    const many = Array.from({ length: 230 }, (_, i) => comment(i + 10, `note ${i}`));
    many.push(comment(9999, "missed: aws_kms_key.k"));
    const { octokit, calls } = fakeOctokit(prs, { 1000: [comment(1, botBody()), ...many] });
    const out = await collectFeedback(octokit, { owner: "o", repo: "r", maxPrs: 500 });
    expect(out).toHaveLength(150);
    expect(calls.pulls.map((c) => c.page)).toEqual([1, 2]);
    expect(calls.comments.filter((c) => c.issue_number === 1000).map((c) => c.page)).toEqual([1, 2, 3]);
    expect(out[0]?.missed).toEqual(["aws_kms_key.k"]);
  });

  it("stops at maxPrs", async () => {
    const prs = Array.from({ length: 30 }, (_, i) => pull(i + 1, "2026-11-23T00:00:00Z"));
    const { octokit, calls } = fakeOctokit(prs, {});
    const out = await collectFeedback(octokit, { owner: "o", repo: "r", maxPrs: 5 });
    expect(out).toHaveLength(5);
    expect(calls.comments).toHaveLength(5);
    expect(await collectFeedback(octokit, { owner: "o", repo: "r", maxPrs: 0 })).toEqual([]);
  });

  it("stops at the first PR last updated before `since`", async () => {
    const prs = [
      pull(3, "2026-11-23T00:00:00Z"),
      pull(2, "2026-11-10T00:00:00Z"),
      pull(1, "2026-11-01T00:00:00Z"),
    ];
    const { octokit, calls } = fakeOctokit(prs, {});
    const out = await collectFeedback(octokit, {
      owner: "o",
      repo: "r",
      since: new Date("2026-11-05T00:00:00Z"),
    });
    expect(out.map((f) => f.pr?.number)).toEqual([3, 2]);
    expect(calls.comments.map((c) => c.issue_number)).toEqual([3, 2]);
  });

  it("caps comment pages per PR", async () => {
    const many = Array.from({ length: 500 }, (_, i) => comment(i, `c${i}`));
    const { octokit, calls } = fakeOctokit([pull(1, "2026-11-23T00:00:00Z")], { 1: many });
    await collectFeedback(octokit, { owner: "o", repo: "r", maxCommentPages: 2 });
    expect(calls.comments.map((c) => c.page)).toEqual([1, 2]);
  });

  it("tolerates comments without body or user", async () => {
    const { octokit } = fakeOctokit([pull(1, "2026-11-23T00:00:00Z")], {
      1: [{ id: 1, body: null, user: null }, { id: 2 }, comment(3, botBody())],
    });
    const [fb] = await collectFeedback(octokit, { owner: "o", repo: "r" });
    expect(fb?.hasReview).toBe(true);
  });

  it("propagates API errors", async () => {
    const octokit: MetricsOctokit = {
      rest: {
        pulls: {
          list: async () => Promise.reject(new Error("HTTP 403")),
          listReviews: async () => ({ data: [] }),
          listReviewComments: async () => ({ data: [] }),
        },
        issues: { listComments: async () => ({ data: [] }) },
      },
    };
    await expect(collectFeedback(octokit, { owner: "o", repo: "r" })).rejects.toThrow("HTTP 403");
  });
});

describe("collectFeedback trust", () => {
  it("ignores a marker comment forged by an outsider, and outsiders' missed: replies", async () => {
    const forged = ticked(botBody(9)).replace(/f-3a9c1e07/g, "f-forged");
    const { octokit } = fakeOctokit([pull(1, "2026-11-23T00:00:00Z")], {
      1: [
        comment(1, botBody(1), "github-actions[bot]", "2026-11-01T00:00:00Z"),
        comment(
          2,
          forged.replace("- [ ] Confirmed", "- [x] Confirmed"),
          "mallory",
          "2026-11-02T00:00:00Z",
          "NONE",
        ),
        comment(3, "missed: aws_x.y aws_z.w", "drive-by", "2026-11-03T00:00:00Z", "CONTRIBUTOR"),
        comment(4, "missed: aws_q.r", "other-app[bot]", "2026-11-03T00:00:00Z"),
      ],
    });
    const [fb] = await collectFeedback(octokit, { owner: "o", repo: "r" });
    expect(fb?.findings.map((f) => [f.id, f.confirmed])).toEqual([
      ["f-3a9c1e07", false],
      ["f-77b2d410", false],
    ]);
    expect(fb?.missed).toEqual([]);
    expect(fb?.hasFeedback).toBe(false);
  });

  it("reads missed: in review bodies and inline review comments", async () => {
    const { octokit } = fakeOctokit(
      [pull(1, "2026-11-23T00:00:00Z")],
      { 1: [comment(1, botBody(), "github-actions[bot]")] },
      {
        1: [
          {
            id: 5,
            body: "missed: aws_iam_policy.admin",
            submitted_at: "2026-11-21T00:00:00Z",
            user: { login: "alice", type: "User" },
            author_association: "OWNER",
          },
        ],
      },
      {
        1: [
          comment(6, "missed: `aws_kms_key.k`", "bob"),
          comment(7, "missed: aws_x.y", "eve", undefined, "NONE"),
        ],
      },
    );
    const [fb] = await collectFeedback(octokit, { owner: "o", repo: "r" });
    expect(fb?.missed).toEqual(["aws_iam_policy.admin", "aws_kms_key.k"]);
    expect(fb?.hasFeedback).toBe(true);
  });

  it("pools the latest comment of each key", async () => {
    const keyed = (key: string, body: string) =>
      body.replace(
        "<!-- tf-change-reviewer -->",
        `<!-- tf-change-reviewer -->\n<!-- tf-change-reviewer:key=${key} -->`,
      );
    const prod = renderReviewComment(
      [makeReview({ rootModuleDir: "envs/prod", findings: [dbFinding()] })],
      makeMeta(),
    );
    const staging = renderReviewComment(
      [makeReview({ rootModuleDir: "envs/staging", findings: [sgFinding()] })],
      makeMeta(),
    );
    const { octokit } = fakeOctokit([pull(1, "2026-11-23T00:00:00Z")], {
      1: [
        comment(1, keyed("aaaaaaaaaaaa", prod), "github-actions[bot]", "2026-11-02T00:00:00Z"),
        comment(2, keyed("bbbbbbbbbbbb", staging), "github-actions[bot]", "2026-11-03T00:00:00Z"),
      ],
    });
    const [fb] = await collectFeedback(octokit, { owner: "o", repo: "r" });
    expect(fb?.findings.map((f) => f.root)).toEqual(["envs/prod", "envs/staging"]);
  });
});

describe("renderMetrics", () => {
  it("renders headline, breakdown tables and missed changes", () => {
    const md = renderMetrics(
      computeMetrics([
        {
          pr: { number: 12 },
          hasReview: true,
          hasFeedback: true,
          findings: [
            { id: "a", address: "x.a", severity: "critical", origin: "both", confirmed: true },
            { id: "b", address: "x.b", severity: "high", origin: "rules", confirmed: false },
            { id: "c", address: "x.c", severity: "medium", origin: "agent", confirmed: true },
          ],
          missed: ["aws_s3_bucket.logs"],
        },
      ]),
    );
    expect(md).toContain("PRs looked at: 1 · reviewed by the bot: 1 · with reviewer feedback (counted): 1");
    expect(md).toContain("| Precision | 66.7% | 2 confirmed of 3 flagged |");
    expect(md).toContain("| Recall | 66.7% | 2 confirmed, 1 missed |");
    expect(md).toContain("### By severity");
    const sev = md.indexOf("| critical | 1 | 1 | 100.0% |");
    expect(sev).toBeGreaterThan(0);
    expect(md.indexOf("| high | 1 | 0 | 0.0% |")).toBeGreaterThan(sev);
    expect(md.indexOf("| medium | 1 | 1 | 100.0% |")).toBeGreaterThan(md.indexOf("| high |"));
    expect(md).toContain("### By origin");
    expect(md).toContain("- PR 12: `aws_s3_bucket.logs`");
  });

  it("shows n/a without data and omits empty sections", () => {
    const md = renderMetrics(computeMetrics([]));
    expect(md).toContain("| Precision | n/a | 0 confirmed of 0 flagged |");
    expect(md).toContain("| Recall | n/a |");
    expect(md).not.toContain("### By severity");
    expect(md).not.toContain("### Missed changes");
  });

  it("shows reviewer-supplied text inertly and caps the missed list", () => {
    const missed = ["@octocat", ...Array.from({ length: 60 }, (_, i) => `x.r${i}`)];
    const md = renderMetrics(
      computeMetrics([{ pr: { number: 1 }, hasReview: true, hasFeedback: true, findings: [], missed }]),
    );
    expect(md).toContain("- PR 1: `@octocat`");
    expect(md).toContain("- …and 11 more");
    const evilSeverity = renderMetrics(
      computeMetrics([
        {
          hasReview: true,
          hasFeedback: true,
          findings: [{ id: "a", address: "x.a", severity: "<b>@x|y", origin: "rules", confirmed: true }],
          missed: [],
        },
      ]),
    );
    expect(evilSeverity).toContain(`| &lt;b&gt;@${ZWSP}x\\|y | 1 | 1 | 100.0% |`);
  });
});
