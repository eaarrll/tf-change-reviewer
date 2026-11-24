import { isTrustedAuthor } from "../github.js";
import { isReviewComment, parseCommentKey } from "../report/markdown.js";
import { codeSpan, escapeText } from "../report/sanitize.js";
import type { Breakdown, Metrics, PrFeedback } from "./feedback.js";
import { parseFeedback } from "./feedback.js";

/** The few Octokit REST methods the collector uses, typed minimally so tests can fake them. */
export interface MetricsOctokit {
  rest: {
    pulls: {
      list(params: {
        owner: string;
        repo: string;
        state: "all";
        sort: "updated";
        direction: "desc";
        per_page: number;
        page: number;
      }): Promise<{ data: PullSummary[] }>;
      listReviews(params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page: number;
        page: number;
      }): Promise<{ data: IssueComment[] }>;
      listReviewComments(params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page: number;
        page: number;
      }): Promise<{ data: IssueComment[] }>;
    };
    issues: {
      listComments(params: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page: number;
        page: number;
      }): Promise<{ data: IssueComment[] }>;
    };
  };
}

export interface PullSummary {
  number: number;
  updated_at: string;
  html_url?: string;
}

/** An issue comment, a PR review (its body) or a PR review comment: the fields used here. */
export interface IssueComment {
  id: number;
  body?: string | null;
  updated_at?: string;
  /** Reviews have submitted_at instead of updated_at. */
  submitted_at?: string | null;
  author_association?: string;
  user?: { login?: string; type?: string } | null;
}

export interface CollectOptions {
  owner: string;
  repo: string;
  /** Stop at PRs last updated before this. */
  since?: Date;
  /** Default 100. */
  maxPrs?: number;
  /** Max comment pages per PR (100 comments each); default 10. */
  maxCommentPages?: number;
}

const PER_PAGE = 100;

/**
 * Feedback for recently updated PRs, newest first. The bot's comments are the marker comments by a
 * trusted author (a bot, or the repository's owner, members and collaborators, as the action
 * checks), the most recently updated one per comment key; anyone can post a comment that starts with
 * the marker. Replies are the other conversation comments, review bodies and inline review comments
 * by owners, members and collaborators: on a public repository anyone else could skew the numbers.
 */
export async function collectFeedback(octokit: MetricsOctokit, opts: CollectOptions): Promise<PrFeedback[]> {
  const maxPrs = opts.maxPrs ?? 100;
  const since = opts.since?.getTime();
  const out: PrFeedback[] = [];
  if (maxPrs <= 0) return out;
  for (let page = 1; ; page++) {
    const { data } = await octokit.rest.pulls.list({
      owner: opts.owner,
      repo: opts.repo,
      state: "all",
      sort: "updated",
      direction: "desc",
      per_page: PER_PAGE,
      page,
    });
    for (const pr of data) {
      if (since !== undefined && Date.parse(pr.updated_at) < since) return out;
      const comments = await listAll(opts, (page) =>
        octokit.rest.issues.listComments({
          owner: opts.owner,
          repo: opts.repo,
          issue_number: pr.number,
          per_page: PER_PAGE,
          page,
        }),
      );
      const params = { owner: opts.owner, repo: opts.repo, pull_number: pr.number, per_page: PER_PAGE };
      const reviews = await listAll(opts, (page) => octokit.rest.pulls.listReviews({ ...params, page }));
      const inline = await listAll(opts, (page) =>
        octokit.rest.pulls.listReviewComments({ ...params, page }),
      );
      out.push(feedbackFor(pr, comments, [...reviews, ...inline]));
      if (out.length >= maxPrs) return out;
    }
    if (data.length < PER_PAGE) return out;
  }
}

const REPLY_ASSOCIATIONS: ReadonlySet<string> = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

function feedbackFor(
  pr: PullSummary,
  comments: readonly IssueComment[],
  reviewItems: readonly IssueComment[],
): PrFeedback {
  // Latest trusted marker comment per key (one per plan set; unkeyed comments share one slot).
  const latest = new Map<string, IssueComment>();
  for (const c of comments) {
    if (!isReviewComment(c.body ?? "") || !isTrustedAuthor(c)) continue;
    const key = parseCommentKey(c.body ?? "") ?? "";
    const prev = latest.get(key);
    if (prev === undefined || time(c.updated_at) >= time(prev.updated_at)) latest.set(key, c);
  }
  const replies = [...comments, ...reviewItems]
    .filter(
      (c) =>
        !isReviewComment(c.body ?? "") &&
        c.user?.type !== "Bot" &&
        REPLY_ASSOCIATIONS.has(c.author_association ?? ""),
    )
    .map((c) => {
      const reply: { body: string; author?: string } = { body: c.body ?? "" };
      if (c.user?.login) reply.author = c.user.login;
      return reply;
    });
  const bodies = [...latest.values()].map((c) => c.body ?? "");
  const feedback = parseFeedback(bodies.length > 0 ? bodies : null, replies);
  const ref: NonNullable<PrFeedback["pr"]> = { number: pr.number, updatedAt: pr.updated_at };
  if (pr.html_url) ref.url = pr.html_url;
  return { ...feedback, pr: ref };
}

async function listAll(
  opts: CollectOptions,
  fetchPage: (page: number) => Promise<{ data: IssueComment[] }>,
): Promise<IssueComment[]> {
  const all: IssueComment[] = [];
  const maxPages = opts.maxCommentPages ?? 10;
  for (let page = 1; page <= maxPages; page++) {
    const { data } = await fetchPage(page);
    all.push(...data);
    if (data.length < PER_PAGE) break;
  }
  return all;
}

function time(iso: string | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

// ───────────────────────────── rendering ─────────────────────────────

const MAX_MISSED_LISTED = 50;

/** Markdown report: headline table, per-severity and per-origin precision, and the missed changes. */
export function renderMetrics(metrics: Metrics): string {
  const lines = [
    "## tf-change-reviewer feedback metrics",
    "",
    `PRs looked at: ${metrics.prs.total} · reviewed by the bot: ${metrics.prs.reviewed} · with reviewer feedback (counted): ${metrics.prs.counted}`,
    "",
    "| Metric | Value | Basis |",
    "| --- | ---: | --- |",
    `| Precision | ${percent(metrics.precision)} | ${metrics.confirmed} confirmed of ${metrics.flagged} flagged |`,
    `| Recall | ${percent(metrics.recall)} | ${metrics.confirmed} confirmed, ${metrics.missed} missed |`,
  ];
  const section = (title: string, rows: Record<string, Breakdown>, order: readonly string[]): void => {
    const keys = Object.keys(rows).sort((a, b) => rank(order, a) - rank(order, b) || a.localeCompare(b));
    if (keys.length === 0) return;
    lines.push(
      "",
      `### ${title}`,
      "",
      "| | Flagged | Confirmed | Precision |",
      "| --- | ---: | ---: | ---: |",
    );
    for (const key of keys) {
      const b = rows[key] as Breakdown;
      lines.push(`| ${escapeText(key, 40)} | ${b.flagged} | ${b.confirmed} | ${percent(b.precision)} |`);
    }
  };
  section("By severity", metrics.bySeverity, ["critical", "high", "medium", "low"]);
  section("By origin", metrics.byOrigin, ["rules", "agent", "both"]);
  if (metrics.missedChanges.length > 0) {
    lines.push("", "### Missed changes", "");
    for (const m of metrics.missedChanges.slice(0, MAX_MISSED_LISTED)) {
      // Addresses come from reviewers' replies: shown as inert code.
      lines.push(`- ${m.pr === null ? "" : `PR ${m.pr}: `}${codeSpan(m.address, 300)}`);
    }
    if (metrics.missedChanges.length > MAX_MISSED_LISTED) {
      lines.push(`- …and ${metrics.missedChanges.length - MAX_MISSED_LISTED} more`);
    }
  }
  lines.push(
    "",
    "_Only PRs with feedback count. Precision is a lower bound: an unticked box means not confirmed, not wrong._",
  );
  return `${lines.join("\n")}\n`;
}

function percent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function rank(order: readonly string[], key: string): number {
  const i = order.indexOf(key);
  return i === -1 ? order.length : i;
}
