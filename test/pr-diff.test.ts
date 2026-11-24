import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../src/git/diff.js";
import { checkoutHeadWarning, patchesToDiff, resolvePrDiff, type DiffSources } from "../src/pr-diff.js";

const BASE = "1111111111111111111111111111111111111111";
const HEAD = "2222222222222222222222222222222222222222";

function sources(over: Partial<DiffSources> = {}): DiffSources & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    gitDiff: async () => {
      calls.push("three-dot");
      throw new Error("fatal: bad revision");
    },
    gitFetch: async () => {
      calls.push("fetch");
      throw new Error("could not fetch");
    },
    gitDiffTwoDot: async () => {
      calls.push("two-dot");
      return "two-dot diff";
    },
    listPullFiles: async () => {
      calls.push("api");
      return {
        files: [{ filename: "main.tf", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" }],
        truncated: false,
      };
    },
    ...over,
  };
}

describe("resolvePrDiff", () => {
  it("uses the three-dot git diff when both commits are there", async () => {
    const s = sources({ gitDiff: async () => "exact" });
    expect(await resolvePrDiff("/r", BASE, HEAD, s)).toEqual({ text: "exact", source: "git", warnings: [] });
  });

  it("fetches and falls back to a two-dot diff in a shallow checkout, with a warning", async () => {
    const s = sources({ gitFetch: async () => {} });
    const r = await resolvePrDiff("/r", BASE, HEAD, s);
    expect(r.source).toBe("git-two-dot");
    expect(r.text).toBe("two-dot diff");
    expect(r.warnings[0]).toMatch(/two-dot diff/);
  });

  it("falls back to the API's file patches when git cannot help", async () => {
    const s = sources();
    const r = await resolvePrDiff("/r", BASE, HEAD, s);
    expect(s.calls).toEqual(["three-dot", "fetch", "api"]);
    expect(r.source).toBe("api");
    expect(parseUnifiedDiff(r.text ?? "").files.get("main.tf")?.addedLines).toEqual(new Set([1]));
  });

  it("does not run git without valid SHAs, and gives up without a pull request", async () => {
    const s = sources({ listPullFiles: null });
    expect(await resolvePrDiff("/r", null, "not-a-sha", s)).toEqual({
      text: null,
      source: "none",
      warnings: [],
    });
    expect(s.calls).toEqual([]);
  });
});

describe("resolvePrDiff with a truncated API file list", () => {
  it("says the diff may be incomplete when the API list hit its cap", async () => {
    const s = sources({
      listPullFiles: async () => ({
        files: [{ filename: "main.tf", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" }],
        truncated: true,
      }),
    });
    const r = await resolvePrDiff("/r", BASE, HEAD, s);
    expect(r.source).toBe("api");
    expect(r.warnings.join("\n")).toMatch(/may have more: changed lines in files past that are unknown/);
  });
});

describe("checkoutHeadWarning", () => {
  it("warns only when HEAD is another commit than the PR head", async () => {
    expect(await checkoutHeadWarning("/r", HEAD, async () => `${HEAD}\n`)).toBeNull();
    expect(await checkoutHeadWarning("/r", HEAD.toUpperCase(), async () => HEAD)).toBeNull();
    const w = await checkoutHeadWarning("/r", HEAD, async () => BASE);
    expect(w).toMatch(
      /not the pull request's head commit \(HEAD is 111111111111, the PR head is 222222222222/,
    );
    expect(w).toContain("ref: ${{ github.event.pull_request.head.sha }}");
    expect(
      await checkoutHeadWarning("/r", HEAD, async () => {
        throw new Error("not a git repository");
      }),
    ).toBeNull();
  });
});

describe("patchesToDiff", () => {
  it("builds headers for added, removed and renamed files and lists files without a patch", () => {
    const { text, unknown } = patchesToDiff([
      { filename: "new.tf", status: "added", patch: "@@ -0,0 +1,2 @@\n+a\n+b" },
      { filename: "gone.tf", status: "removed", patch: "@@ -1 +0,0 @@\n-x" },
      { filename: "b.tf", previousFilename: "a.tf", status: "renamed", patch: "@@ -1 +1 @@\n-x\n+y" },
      { filename: "big.json", status: "modified" },
    ]);
    const idx = parseUnifiedDiff(text);
    expect(idx.files.get("new.tf")).toMatchObject({ status: "added" });
    expect(idx.files.get("gone.tf")).toMatchObject({ status: "deleted" });
    expect(idx.files.get("b.tf")).toMatchObject({ status: "renamed", oldPath: "a.tf" });
    expect(unknown).toEqual(["big.json"]);
  });
});
