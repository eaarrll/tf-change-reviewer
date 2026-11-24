import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitDiff, parseUnifiedDiff, unquote } from "../../src/git/diff.js";

const lines = (fd: { addedLines: Set<number>; removedLines: Set<number> } | undefined) => ({
  added: [...(fd?.addedLines ?? [])],
  removed: [...(fd?.removedLines ?? [])],
});

describe("parseUnifiedDiff: plain (non-git) unified diffs", () => {
  // `diff -ru a b` style: no `diff --git` lines between files.
  const plain = [
    "--- a/one.tf\t2026-11-24 10:00:00",
    "+++ b/one.tf\t2026-11-24 10:00:00",
    "@@ -1,2 +1,2 @@",
    ' resource "x" "y" {',
    "-  a = 1",
    "+  a = 2",
    "--- a/two.tf\t2026-11-24 10:00:00",
    "+++ b/two.tf\t2026-11-24 10:00:00",
    "@@ -5 +5 @@",
    "-  b = 1",
    "+  b = 2",
    "",
  ].join("\n");

  it("starts a new file at each ---/+++ header pair once the hunk's line counts are used up", () => {
    const idx = parseUnifiedDiff(plain);
    expect([...idx.files.keys()]).toEqual(["one.tf", "two.tf"]);
    expect(lines(idx.files.get("one.tf"))).toEqual({ added: [2], removed: [2] });
    expect(lines(idx.files.get("two.tf"))).toEqual({ added: [5], removed: [5] });
    expect(idx.files.get("two.tf")?.status).toBe("modified");
    expect(idx.touches("two.tf", 5, 5)).toBe(true);
  });

  it("keeps lines that look like headers as content while the hunk still expects lines", () => {
    // Removing "-- a/x" and adding "++ b/x" gives content lines that start with --- / +++.
    const text = [
      "diff --git a/f.tf b/f.tf",
      "--- a/f.tf",
      "+++ b/f.tf",
      "@@ -1,3 +1,3 @@",
      " keep",
      "--- a/x",
      "+++ b/x",
      " keep",
    ].join("\n");
    const idx = parseUnifiedDiff(text);
    expect([...idx.files.keys()]).toEqual(["f.tf"]);
    expect(lines(idx.files.get("f.tf"))).toEqual({ added: [2], removed: [2] });
  });

  it("handles several hunks per file, /dev/null with a timestamp, and '\\ No newline' markers", () => {
    const text = [
      "--- a/m.tf",
      "+++ b/m.tf",
      "@@ -1,1 +1,2 @@",
      " a",
      "+b",
      "\\ No newline at end of file",
      "@@ -10,2 +11,1 @@",
      " c",
      "-d",
      "--- /dev/null\t1970-01-01 00:00:00",
      "+++ b/new.tf\t2026-11-24",
      "@@ -0,0 +1,1 @@",
      "+x",
      "--- a/gone.tf\t2026-11-24",
      "+++ /dev/null\t1970-01-01 00:00:00",
      "@@ -1 +0,0 @@",
      "-y",
    ].join("\n");
    const idx = parseUnifiedDiff(text);
    expect(lines(idx.files.get("m.tf"))).toEqual({ added: [2], removed: [11] });
    expect(idx.files.get("new.tf")?.status).toBe("added");
    expect(idx.files.get("gone.tf")?.status).toBe("deleted");
    expect([...idx.files.keys()]).toEqual(["m.tf", "new.tf", "gone.tf"]);
  });
});

describe("parseUnifiedDiff: git-quoted paths", () => {
  it("decodes octal (UTF-8) and C escapes in ---/+++ headers", () => {
    const text = [
      'diff --git "a/envs/caf\\303\\251/main.tf" "b/envs/caf\\303\\251/main.tf"',
      "index 1..2 100644",
      '--- "a/envs/caf\\303\\251/main.tf"',
      '+++ "b/envs/caf\\303\\251/main.tf"',
      "@@ -2 +2 @@",
      "-b = 2",
      "+b = 3",
    ].join("\n");
    const idx = parseUnifiedDiff(text);
    expect([...idx.files.keys()]).toEqual(["envs/café/main.tf"]);
    expect(idx.touches("envs/café/main.tf", 2, 2)).toBe(true);
  });

  it("decodes quoted rename and diff --git headers", () => {
    const text = [
      'diff --git "a/old \\"q\\".tf" "b/n\\303\\251w.tf"',
      "similarity index 100%",
      'rename from "old \\"q\\".tf"',
      'rename to "n\\303\\251w.tf"',
      // No rename or ---/+++ lines: the paths come from the diff --git header.
      'diff --git "a/x\\303\\251.tf" "b/y\\303\\251.tf"',
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n");
    const idx = parseUnifiedDiff(text);
    expect(idx.files.get("néw.tf")).toMatchObject({ status: "renamed", oldPath: 'old "q".tf' });
    expect(idx.files.get("yé.tf")).toMatchObject({ oldPath: "xé.tf", addedLines: new Set([1]) });
    expect([...idx.files.keys()]).toEqual(["néw.tf", "yé.tf"]);
  });

  it("unquote handles every C escape and leaves unquoted paths alone", () => {
    expect(unquote('"a\\tb\\\\c\\"d\\n"')).toBe('a\tb\\c"d\n');
    expect(unquote('"caf\\303\\251"')).toBe("café");
    expect(unquote('"raw é"')).toBe("raw é");
    expect(unquote("plain/path.tf")).toBe("plain/path.tf");
    expect(unquote('"')).toBe('"');
  });

  it("matches the paths of a real git diff with non-ASCII and spaced file names", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tfcr-diff-"));
    try {
      const git = (...args: string[]): string =>
        execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo }).toString();
      git("init", "-q");
      mkdirSync(join(repo, "envs", "café"), { recursive: true });
      writeFileSync(join(repo, "envs", "café", "main.tf"), "a = 1\nb = 2\n");
      writeFileSync(join(repo, "sp ace.tf"), "x\n");
      git("add", "-A");
      git("commit", "-qm", "one");
      writeFileSync(join(repo, "envs", "café", "main.tf"), "a = 1\nb = 3\n");
      writeFileSync(join(repo, "sp ace.tf"), "y\n");
      git("commit", "-qam", "two");
      const idx = parseUnifiedDiff(await gitDiff(repo, "HEAD~1", "HEAD"));
      expect([...idx.files.keys()].sort()).toEqual(["envs/café/main.tf", "sp ace.tf"]);
      expect(idx.touches("envs/café/main.tf", 2, 2)).toBe(true);
      expect(idx.touches("sp ace.tf", 1, 1)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
