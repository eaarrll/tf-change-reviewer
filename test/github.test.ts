import { describe, expect, it } from "vitest";
import { createGitHubPort, type ReviewOctokit } from "../src/github.js";

function octokit(comments: unknown[][], files: unknown[][] = []) {
  const calls: Record<string, unknown>[] = [];
  const fake = {
    rest: {
      issues: {
        listComments: async (p: { page: number }) => {
          calls.push({ listComments: p.page });
          return { data: comments[p.page - 1] ?? [] };
        },
        createComment: async () => ({ data: { id: 1, html_url: "u1" } }),
        updateComment: async (p: { comment_id: number }) => ({ data: { id: p.comment_id, html_url: "u2" } }),
      },
      pulls: {
        get: async () => ({
          data: {
            number: 9,
            base: { sha: "b".repeat(40), repo: { full_name: "o/r" } },
            head: { sha: "h".repeat(40), repo: { full_name: "fork/r" } },
          },
        }),
        listFiles: async (p: { page: number }) => ({ data: files[p.page - 1] ?? [] }),
      },
    },
  };
  return { fake: fake as unknown as ReviewOctokit, calls };
}

const marker = "<!-- tf-change-reviewer -->\nbody";
const comment = (id: number, extra: Record<string, unknown>) => ({
  id,
  body: marker,
  html_url: `c${id}`,
  created_at: `2026-11-0${id}T00:00:00Z`,
  ...extra,
});

describe("createGitHubPort", () => {
  it("finds the newest marker comment by a trusted author, across pages", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: 100 + i,
      body: "chat",
      html_url: "x",
      created_at: "2026-11-01T00:00:00Z",
    }));
    const { fake } = octokit([
      [
        ...page1.slice(0, 98),
        comment(1, { user: { type: "Bot" } }),
        comment(2, { author_association: "NONE", user: { type: "User" } }),
      ],
      [comment(3, { author_association: "MEMBER", user: { type: "User" } })],
    ]);
    const found = await createGitHubPort(fake, "o", "r").findComment(5);
    expect(found).toEqual({ id: 3, body: marker, htmlUrl: "c3" });
  });

  it("ignores marker comments written by outsiders", async () => {
    const { fake } = octokit([[comment(1, { author_association: "CONTRIBUTOR", user: { type: "User" } })]]);
    expect(await createGitHubPort(fake, "o", "r").findComment(5)).toBeNull();
  });

  it("reads the pull request's SHAs and fork status, and its files", async () => {
    const { fake } = octokit(
      [],
      [[{ filename: "a.tf", status: "renamed", previous_filename: "b.tf", patch: "@@" }]],
    );
    const port = createGitHubPort(fake, "o", "r");
    expect(await port.getPull(9)).toEqual({
      number: 9,
      baseSha: "b".repeat(40),
      headSha: "h".repeat(40),
      headRepo: expect.any(String),
      isFork: true,
    });
    expect(await port.listPullFiles(9)).toEqual({
      files: [{ filename: "a.tf", previousFilename: "b.tf", status: "renamed", patch: "@@" }],
      truncated: false,
    });
  });

  it("finds the comment for its key, and adopts an unkeyed one only when there is none", async () => {
    const body = (key: string | null) =>
      `<!-- tf-change-reviewer -->\n${key ? `<!-- tf-change-reviewer:key=${key} -->\n` : ""}body`;
    const bot = { user: { type: "Bot" } };
    const { fake } = octokit([
      [
        { ...comment(1, bot), body: body(null) },
        { ...comment(2, bot), body: body("aaaaaaaaaaaa") },
        { ...comment(3, bot), body: body("bbbbbbbbbbbb") },
      ],
    ]);
    const port = createGitHubPort(fake, "o", "r");
    expect((await port.findComment(5, "aaaaaaaaaaaa"))?.id).toBe(2);
    expect((await port.findComment(5, "bbbbbbbbbbbb"))?.id).toBe(3);
    expect((await port.findComment(5, "cccccccccccc"))?.id).toBe(1);
    expect((await port.findComment(5))?.id).toBe(3);
  });

  it("takes over the one comment its own job left under another key, from an earlier run", async () => {
    const body = (key: string, scope: string, run: number, plans = "11111111") =>
      `<!-- tf-change-reviewer -->\n<!-- tf-change-reviewer:run=${run}.1 -->\n<!-- tf-change-reviewer:key=${key} scope=${scope}${plans ? ` plans=${plans}` : ""} -->\nbody`;
    const bot = { user: { type: "Bot" } };
    const job = "aaaaaaaaaaaa";
    const other = "bbbbbbbbbbbb";
    const find = (comments: unknown[], runId = 10, plans = ["11111111", "22222222"]) =>
      createGitHubPort(octokit([comments]).fake, "o", "r").findComment(5, "kkkkkkkkkkkk", {
        scope: job,
        runId,
        plans,
      });
    // Its own job's comment under its old key, for a subset or superset of its plans: taken over.
    expect((await find([{ ...comment(1, bot), body: body("k1", job, 9) }]))?.id).toBe(1);
    expect(
      (await find([{ ...comment(1, bot), body: body("k1", job, 9, "11111111.22222222.33333333") }]))?.id,
    ).toBe(1);
    // Other plans (a matrix sibling that was the only one to comment last run), partly shared plans,
    // or a comment that records no plans: not.
    expect(await find([{ ...comment(1, bot), body: body("k1", job, 9, "33333333") }])).toBeNull();
    expect(await find([{ ...comment(1, bot), body: body("k1", job, 9, "11111111.33333333") }])).toBeNull();
    expect(await find([{ ...comment(1, bot), body: body("k1", job, 9, "") }])).toBeNull();
    // Without an owner, or written by this run (a matrix sibling): not.
    expect(
      await createGitHubPort(
        octokit([[{ ...comment(1, bot), body: body("k1", job, 9) }]]).fake,
        "o",
        "r",
      ).findComment(5, "kkkkkkkkkkkk"),
    ).toBeNull();
    expect(await find([{ ...comment(1, bot), body: body("k1", job, 10) }])).toBeNull();
    // Another workflow job's comment: never.
    expect(await find([{ ...comment(1, bot), body: body("k1", other, 9) }])).toBeNull();
    // The job keeps several keys (a matrix): not.
    expect(
      await find([
        { ...comment(1, bot), body: body("k1", job, 9) },
        { ...comment(2, bot), body: body("k2", job, 9) },
      ]),
    ).toBeNull();
    // An outsider's forged comment: never.
    expect(
      await find([{ ...comment(1, { author_association: "NONE" }), body: body("k1", job, 9) }]),
    ).toBeNull();
  });

  it("flags a file list cut off at GitHub's 3000-file cap", async () => {
    const page = (n: number) =>
      Array.from({ length: 100 }, (_, i) => ({ filename: `f${n}-${i}.tf`, status: "modified" }));
    const full = Array.from({ length: 30 }, (_, i) => page(i));
    const port = createGitHubPort(octokit([], full).fake, "o", "r");
    const listed = await port.listPullFiles(9);
    expect(listed.files).toHaveLength(3000);
    expect(listed.truncated).toBe(true);
    const short = createGitHubPort(octokit([], [...full.slice(0, 29), page(29).slice(0, 99)]).fake, "o", "r");
    expect((await short.listPullFiles(9)).truncated).toBe(false);
  });
});
