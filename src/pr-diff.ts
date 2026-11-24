/*
 * The PR diff for the Action, best source first:
 *   1. `git diff base...head` in the checkout (needs both commits: fetch-depth 0, or a base fetch);
 *   2. after `git fetch --no-tags --depth=1 origin <base> <head>`: two-dot `git diff base head`
 *      (no merge base in a shallow clone, so changes the base branch made since the fork point
 *      show up too);
 *   3. the pull request's file patches from the API (pulls.listFiles). GitHub omits the patch of
 *      large or binary files: those files count as changed with unknown lines.
 */
import { gitDiff, gitDiffTwoDot, gitFetchCommits, runGit } from "./git/diff.js";

export interface PullFile {
  filename: string;
  previousFilename?: string;
  /** added | removed | modified | renamed | copied | changed | unchanged */
  status: string;
  patch?: string;
}

/** pulls.listFiles result; `truncated` when the list hit GitHub's 3000-file cap and may be incomplete. */
export interface PullFiles {
  files: PullFile[];
  truncated: boolean;
}

export interface DiffSources {
  gitDiff(root: string, base: string, head: string): Promise<string>;
  gitFetch(root: string, shas: readonly string[]): Promise<void>;
  gitDiffTwoDot(root: string, base: string, head: string): Promise<string>;
  /** null when there is no pull request to ask. */
  listPullFiles: (() => Promise<PullFiles>) | null;
}

export interface ResolvedDiff {
  text: string | null;
  source: "git" | "git-two-dot" | "api" | "none";
  warnings: string[];
}

export const GIT_SOURCES: Omit<DiffSources, "listPullFiles"> = {
  gitDiff,
  gitFetch: gitFetchCommits,
  gitDiffTwoDot,
};

const SHA = /^[0-9a-f]{7,64}$/i;

export async function resolvePrDiff(
  root: string,
  base: string | null,
  head: string | null,
  sources: DiffSources,
): Promise<ResolvedDiff> {
  const warnings: string[] = [];
  const shas = base !== null && head !== null && SHA.test(base) && SHA.test(head);
  if (shas) {
    try {
      return { text: await sources.gitDiff(root, base, head), source: "git", warnings };
    } catch {
      // Usually a shallow checkout without the base commit.
    }
    try {
      await sources.gitFetch(root, [base, head]);
      const text = await sources.gitDiffTwoDot(root, base, head);
      warnings.push(
        "The checkout is shallow, so the PR diff is a two-dot diff of the base and head commits: changes merged into the base branch since this PR branched off show up as PR changes. Use actions/checkout with fetch-depth: 0 for an exact diff.",
      );
      return { text, source: "git-two-dot", warnings };
    } catch {
      // No network access or no permission to fetch: try the API.
    }
  }
  if (sources.listPullFiles) {
    try {
      const { files, truncated } = await sources.listPullFiles();
      const { text, unknown } = patchesToDiff(files);
      warnings.push(
        `The PR diff comes from the GitHub API${shas ? " because git could not diff the base and head commits" : ""}.`,
      );
      if (truncated) {
        warnings.push(
          `The GitHub API lists at most ${files.length} changed files and this PR may have more: changed lines in files past that are unknown (counted as unchanged). Use actions/checkout with fetch-depth: 0 for the full diff.`,
        );
      }
      if (unknown.length) {
        const shown = unknown.slice(0, 10).join(", ");
        warnings.push(
          `GitHub sent no patch for ${unknown.length} changed file(s) (large or binary): ${shown}${unknown.length > 10 ? ", …" : ""}. Changed lines in them are unknown.`,
        );
      }
      return { text, source: "api", warnings };
    } catch (err) {
      warnings.push(`Could not list the PR's files: ${err instanceof Error ? err.message : String(err)}.`);
    }
  }
  return { text: null, source: "none", warnings };
}

/** File patches from pulls.listFiles as one unified diff; files without a patch are listed apart. */
export function patchesToDiff(files: readonly PullFile[]): { text: string; unknown: string[] } {
  const parts: string[] = [];
  const unknown: string[] = [];
  for (const f of files) {
    const newPath = f.filename;
    const oldPath = f.previousFilename ?? f.filename;
    if (f.patch === undefined || f.patch === "") {
      if (f.status !== "renamed" && f.status !== "unchanged") unknown.push(newPath);
      if (f.status === "renamed") {
        parts.push(`diff --git a/${oldPath} b/${newPath}\nrename from ${oldPath}\nrename to ${newPath}`);
      }
      continue;
    }
    const minus = f.status === "added" ? "/dev/null" : `a/${oldPath}`;
    const plus = f.status === "removed" ? "/dev/null" : `b/${newPath}`;
    const header = [`diff --git a/${oldPath} b/${newPath}`];
    if (f.status === "added") header.push("new file mode 100644");
    if (f.status === "removed") header.push("deleted file mode 100644");
    if (f.status === "renamed") header.push(`rename from ${oldPath}`, `rename to ${newPath}`);
    parts.push([...header, `--- ${minus}`, `+++ ${plus}`, f.patch.replace(/\n$/, "")].join("\n"));
  }
  return { text: parts.length ? `${parts.join("\n")}\n` : "", unknown };
}

/**
 * A warning when the checkout is not the PR head (actions/checkout without `ref:` checks out the
 * merge commit): lineage then reads other files than the diff and the permalinks describe, so line
 * numbers can be off. Null when HEAD is the PR head, or when git cannot tell.
 */
export async function checkoutHeadWarning(
  root: string,
  headSha: string,
  revParse: (root: string) => Promise<string> = (r) => runGit(r, ["rev-parse", "HEAD"]),
): Promise<string | null> {
  let head: string;
  try {
    head = (await revParse(root)).trim();
  } catch {
    return null;
  }
  if (!SHA.test(head) || !SHA.test(headSha)) return null;
  const n = Math.min(head.length, headSha.length);
  if (head.slice(0, n).toLowerCase() === headSha.slice(0, n).toLowerCase()) return null;
  return `The checkout is not the pull request's head commit (HEAD is ${head.slice(0, 12)}, the PR head is ${headSha.slice(0, 12)}; actions/checkout without \`ref:\` checks out the merge commit): source lines and links can point at the wrong line. Check out \`ref: \${{ github.event.pull_request.head.sha }}\`.`;
}
