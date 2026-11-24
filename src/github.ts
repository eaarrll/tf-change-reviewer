/*
 * The few GitHub REST calls the Action makes, behind a small port so tests can fake them: the sticky
 * comment (find by marker, create, update), the pull request's base/head, and its file patches.
 */
import {
  isReviewComment,
  parseCommentKey,
  parseCommentPlans,
  parseCommentScope,
  parseRunStamp,
} from "./report/markdown.js";
import type { PullFile, PullFiles } from "./pr-diff.js";

const PER_PAGE = 100;
/** pulls.listFiles returns at most 3000 files; stop there. */
const MAX_FILE_PAGES = 30;

interface Data<T> {
  data: T;
}

interface RawComment {
  id: number;
  body?: string | null;
  html_url: string;
  created_at: string;
  author_association?: string;
  user?: { type?: string } | null;
}

interface RawFile {
  filename: string;
  previous_filename?: string;
  status: string;
  patch?: string;
}

interface RawPull {
  number: number;
  base: { sha: string; repo: { full_name: string } | null };
  head: { sha: string; repo: { full_name: string } | null };
}

/** The Octokit surface used here (the real client from @actions/github satisfies it). */
export interface ReviewOctokit {
  rest: {
    issues: {
      listComments(p: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page: number;
        page: number;
      }): Promise<Data<RawComment[]>>;
      createComment(p: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }): Promise<Data<{ id: number; html_url: string }>>;
      updateComment(p: {
        owner: string;
        repo: string;
        comment_id: number;
        body: string;
      }): Promise<Data<{ id: number; html_url: string }>>;
    };
    pulls: {
      get(p: { owner: string; repo: string; pull_number: number }): Promise<Data<RawPull>>;
      listFiles(p: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page: number;
        page: number;
      }): Promise<Data<RawFile[]>>;
    };
  };
}

export interface ExistingComment {
  id: number;
  body: string;
  htmlUrl: string;
}

export interface PullInfo {
  number: number;
  baseSha: string;
  headSha: string;
  /** owner/name of the repository the head branch lives in (null when GitHub no longer knows it). */
  headRepo: string | null;
  /** The head branch lives in another repository: the token is read-only there. */
  isFork: boolean;
}

/** Which workflow job is looking for its comment, so it can take over one its own job left behind. */
export interface CommentOwner {
  /** Hash of the workflow file and job id (see commentScope in action.ts). */
  scope: string;
  /** The run looking: a comment this run wrote belongs to another job of it (a matrix sibling). */
  runId: number;
  /** Hashes of this run's plan-json entries (see commentPlans in action.ts). */
  plans: readonly string[];
}

export interface GitHubPort {
  /**
   * The newest trusted sticky comment for `key` (one per plan set, see commentKey); without a
   * comment for `key`, the newest one written before comments had keys; failing that, with `owner`,
   * the one comment an earlier run of the same workflow job wrote under another key for the same
   * plans in other words, or for fewer or more of them (its plan-json changed), unless that job keeps
   * several keys (a matrix). No key: the newest of all.
   */
  findComment(pr: number, key?: string, owner?: CommentOwner): Promise<ExistingComment | null>;
  createComment(pr: number, body: string): Promise<{ id: number; htmlUrl: string }>;
  updateComment(id: number, body: string): Promise<{ id: number; htmlUrl: string }>;
  getPull(pr: number): Promise<PullInfo>;
  listPullFiles(pr: number): Promise<PullFiles>;
}

const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * The marker is public, and anyone can comment on a public PR: editing an outsider's marker comment
 * would publish the review under their name. Our own comments come from a bot (GITHUB_TOKEN, app
 * tokens) or a collaborator's token.
 */
export function isTrustedAuthor(c: {
  author_association?: string;
  user?: { type?: string } | null;
}): boolean {
  return c.user?.type === "Bot" || TRUSTED_ASSOCIATIONS.has(c.author_association ?? "");
}

/**
 * The comment a single-plan-set job wrote under its previous key, once its plan-json changed: taken
 * over so the PR does not keep a stale review. Only when one plan set contains the other (an entry
 * added, removed or respelled): a matrix leg or a second action step in the same job reviews other
 * plans, and must not take over a sibling's comment even when that sibling was the only one to
 * comment last time. Never when the job keeps several keys (matrix jobs, one plan set each), nor one
 * this run wrote (a matrix sibling that just started).
 */
function leftBehind(
  sameJob: ReadonlyMap<string, RawComment>,
  owner: CommentOwner | undefined,
): RawComment | null {
  if (owner === undefined || owner.plans.length === 0 || sameJob.size !== 1) return null;
  const [only] = sameJob.values();
  if (only === undefined) return null;
  const stamp = parseRunStamp(only.body ?? "");
  if (stamp === null || stamp.runId >= owner.runId) return null;
  const theirs = parseCommentPlans(only.body ?? "");
  return theirs !== null && nested(theirs, owner.plans) ? only : null;
}

/** One list's entries all appear in the other. */
function nested(a: readonly string[], b: readonly string[]): boolean {
  const within = (x: readonly string[], y: readonly string[]) => x.every((e) => y.includes(e));
  return within(a, b) || within(b, a);
}

export function createGitHubPort(octokit: ReviewOctokit, owner: string, repo: string): GitHubPort {
  const base = { owner, repo };
  return {
    async findComment(pr, key, owner) {
      let newest: RawComment | null = null;
      let legacy: RawComment | null = null;
      // Newest comment per other key written by the same workflow job.
      const sameJob = new Map<string, RawComment>();
      for (let page = 1; page <= 50; page++) {
        const { data } = await octokit.rest.issues.listComments({
          ...base,
          issue_number: pr,
          per_page: PER_PAGE,
          page,
        });
        const newer = (c: RawComment, than: RawComment | null): boolean =>
          than === null || Date.parse(c.created_at) >= Date.parse(than.created_at);
        for (const c of data) {
          if (!isTrustedAuthor(c) || !isReviewComment(c.body ?? "")) continue;
          const own = key === undefined ? true : parseCommentKey(c.body ?? "");
          if (own === true || own === key) {
            if (newer(c, newest)) newest = c;
          } else if (own === null) {
            if (newer(c, legacy)) legacy = c;
          } else if (owner !== undefined && parseCommentScope(c.body ?? "") === owner.scope) {
            const seen = sameJob.get(own);
            if (seen === undefined || newer(c, seen)) sameJob.set(own, c);
          }
        }
        if (data.length < PER_PAGE) break;
      }
      const found = newest ?? legacy ?? leftBehind(sameJob, owner);
      return found && { id: found.id, body: found.body ?? "", htmlUrl: found.html_url };
    },
    async createComment(pr, body) {
      const { data } = await octokit.rest.issues.createComment({ ...base, issue_number: pr, body });
      return { id: data.id, htmlUrl: data.html_url };
    },
    async updateComment(id, body) {
      const { data } = await octokit.rest.issues.updateComment({ ...base, comment_id: id, body });
      return { id: data.id, htmlUrl: data.html_url };
    },
    async getPull(pr) {
      const { data } = await octokit.rest.pulls.get({ ...base, pull_number: pr });
      const headRepo = data.head.repo?.full_name;
      const baseRepo = data.base.repo?.full_name;
      return {
        number: data.number,
        baseSha: data.base.sha,
        headSha: data.head.sha,
        headRepo: headRepo ?? null,
        isFork: !headRepo || !baseRepo || headRepo.toLowerCase() !== baseRepo.toLowerCase(),
      };
    },
    async listPullFiles(pr) {
      const out: PullFile[] = [];
      let truncated = false;
      for (let page = 1; page <= MAX_FILE_PAGES; page++) {
        const { data } = await octokit.rest.pulls.listFiles({
          ...base,
          pull_number: pr,
          per_page: PER_PAGE,
          page,
        });
        for (const f of data) {
          out.push({
            filename: f.filename,
            ...(f.previous_filename !== undefined && { previousFilename: f.previous_filename }),
            status: f.status,
            ...(f.patch !== undefined && { patch: f.patch }),
          });
        }
        if (data.length < PER_PAGE) break;
        // A full last page: GitHub stops listing at 3000 files, so there may be more.
        if (page === MAX_FILE_PAGES) truncated = true;
      }
      return { files: out, truncated };
    },
  };
}
