import { spawn } from "node:child_process";
import type { DiffIndex, FileDiff } from "../types.js";

/**
 * Parse a unified diff (`git diff` output, any -U context) into per-file line sets on the NEW side.
 * Tolerant: unknown lines are skipped, never throws.
 */
export function parseUnifiedDiff(text: string): DiffIndex {
  const files = new Map<string, FileDiff>();
  let current: FileDiff | null = null;
  let oldLine = 0;
  let newLine = 0;
  let pendingOld: string | null = null;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let inHunk = false;
  // Lines still expected in the current hunk (from its @@ header). When both reach 0 the hunk is
  // over, so the next file's ---/+++ headers are recognised even without a `diff --git` line
  // (plain `diff -ru` output).
  let oldLeft = 0;
  let newLeft = 0;

  const begin = (): void => {
    current = null;
    pendingOld = null;
    renameFrom = null;
    renameTo = null;
    inHunk = false;
  };

  const ensure = (path: string, oldPath: string | null, status: FileDiff["status"]): FileDiff => {
    const existing = files.get(path);
    if (existing) return existing;
    const fd: FileDiff = {
      path,
      ...(oldPath && oldPath !== path && { oldPath }),
      status,
      addedLines: new Set(),
      removedLines: new Set(),
      removalAnchors: new Set(),
    };
    files.set(path, fd);
    return fd;
  };

  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      begin();
      // Fallback for pure renames (no hunks, no ---/+++ lines).
      const m = line.includes('"')
        ? /^diff --git ("(?:[^"\\]|\\.)*"|a\/.+?) ("(?:[^"\\]|\\.)*"|b\/.+)$/.exec(line)
        : /^diff --git (a\/.+) (b\/.+)$/.exec(line);
      if (m) {
        renameFrom = stripPrefix(m[1]!);
        renameTo = stripPrefix(m[2]!);
      }
      continue;
    }
    if (!inHunk && line.startsWith("rename from ")) {
      renameFrom = normalizePath(unquote(line.slice("rename from ".length)));
      continue;
    }
    if (!inHunk && line.startsWith("rename to ")) {
      renameTo = normalizePath(unquote(line.slice("rename to ".length)));
      if (renameFrom && renameTo) current = ensure(renameTo, renameFrom, "renamed");
      continue;
    }
    if (!inHunk && line.startsWith("--- ")) {
      pendingOld = stripPrefix(line.slice(4));
      if (pendingOld === "/dev/null") pendingOld = null;
      continue;
    }
    if (!inHunk && line.startsWith("+++ ")) {
      const stripped = stripPrefix(line.slice(4));
      const newPath = stripped === "/dev/null" ? null : stripped;
      if (newPath === null && pendingOld) current = ensure(pendingOld, null, "deleted");
      else if (newPath && pendingOld === null) current = ensure(newPath, null, "added");
      else if (newPath) {
        const renamed = pendingOld !== newPath || (renameFrom !== null && renameFrom !== renameTo);
        current = ensure(newPath, pendingOld, renamed && pendingOld !== newPath ? "renamed" : "modified");
      }
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      // An omitted count means 1.
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      inHunk = oldLeft > 0 || newLeft > 0;
      // A zero-length new range ("+12,0") means content was removed after new line 12.
      if (!current && renameTo) current = ensure(renameTo, renameFrom, "modified");
      continue;
    }
    if (!inHunk) continue;
    const fd: FileDiff | null = current;
    if (line.startsWith("+")) {
      fd?.addedLines.add(newLine);
      newLine++;
      newLeft--;
    } else if (line.startsWith("-")) {
      if (fd) {
        fd.removedLines.add(oldLine);
        // The removed text sat just before the current new line (or after the last line at EOF).
        fd.removalAnchors.add(Math.max(newLine, 1));
        if (newLine > 1) fd.removalAnchors.add(newLine - 1);
      }
      oldLine++;
      oldLeft--;
    } else if (line.startsWith(" ") || line === "") {
      // "" too: some tools strip the leading space of empty context lines.
      oldLine++;
      newLine++;
      oldLeft--;
      newLeft--;
    }
    // Anything else ("\ No newline at end of file", unknown lines) does not count.
    if (oldLeft <= 0 && newLeft <= 0) inHunk = false;
  }

  return {
    files,
    touches(file: string, startLine: number, endLine: number): boolean {
      const fd = files.get(normalizePath(file));
      if (!fd) return false;
      if (fd.status === "added") return true;
      for (let l = startLine; l <= endLine; l++) if (fd.addedLines.has(l)) return true;
      // A removal counts only strictly inside the span: anchors on both sides of the gap. The line
      // just before a deletion is not itself changed (the lineage tracer uses the same rule).
      for (let l = startLine; l < endLine; l++) {
        if (fd.removalAnchors.has(l) && fd.removalAnchors.has(l + 1)) return true;
      }
      return false;
    },
  };
}

function stripPrefix(path: string): string {
  // git quotes paths with special characters ("a/caf\303\251.tf") → unquote first.
  const p = unquote(path.replace(/\t.*$/, ""));
  return normalizePath(p.replace(/^[ab]\//, ""));
}

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/**
 * Undo git's C-style path quoting (core.quotePath): `\"`, `\\`, `\t`… and octal byte escapes
 * (`\303\251` = "é" in UTF-8). A path without surrounding quotes is returned as is.
 */
export function unquote(path: string): string {
  if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) return path;
  const bytes: number[] = [];
  for (const [, octal, escaped, text] of path
    .slice(1, -1)
    .matchAll(/\\([0-3][0-7]{2})|\\(.)|([^\\]+|\\)/gsu)) {
    if (octal !== undefined) bytes.push(parseInt(octal, 8));
    else if (escaped !== undefined && C_ESCAPES[escaped] !== undefined) bytes.push(C_ESCAPES[escaped]);
    else bytes.push(...Buffer.from(escaped !== undefined ? `\\${escaped}` : (text ?? ""), "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Repo-relative, forward slashes, no leading "./". */
export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/");
}

/** An empty diff index, for runs without a diff. */
export function emptyDiff(): DiffIndex {
  return parseUnifiedDiff("");
}

/** Runs git in `repoRoot` and resolves with stdout; rejects with git's stderr on a non-zero exit. */
export function runGit(repoRoot: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else
        reject(
          new Error(
            `git ${args[0] ?? ""} failed (${code}): ${Buffer.concat(err).toString("utf8").trim().slice(0, 500)}`,
          ),
        );
    });
  });
}

const DIFF_FLAGS = ["diff", "--no-color", "--no-ext-diff", "--unified=3", "--find-renames"] as const;

/**
 * `git diff --find-renames <base>...<head>` in `repoRoot` (changes since the merge base). Rejects
 * when git fails (e.g. the base is not fetched: a shallow checkout needs `fetch-depth: 0` or an
 * explicit fetch of the base).
 */
export function gitDiff(repoRoot: string, base: string, head = "HEAD"): Promise<string> {
  return runGit(repoRoot, [...DIFF_FLAGS, `${base}...${head}`]);
}

/** `git diff <base> <head>` (two-dot: no merge base needed, but base-branch changes show too). */
export function gitDiffTwoDot(repoRoot: string, base: string, head: string): Promise<string> {
  return runGit(repoRoot, [...DIFF_FLAGS, base, head]);
}

/** `git fetch --no-tags --depth=1 origin <sha…>`: makes commits of a shallow checkout available. */
export async function gitFetchCommits(repoRoot: string, shas: readonly string[]): Promise<void> {
  await runGit(repoRoot, ["fetch", "--no-tags", "--depth=1", "origin", ...shas]);
}
