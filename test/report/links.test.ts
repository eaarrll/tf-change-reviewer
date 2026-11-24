import { describe, expect, it } from "vitest";
import { locationLabel, locationMarkdown, locationUrl, runUrl } from "../../src/report/links.js";
import type { ReportMeta, SourceLocation } from "../../src/types.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const BASE = "fedcba9876543210fedcba9876543210fedcba98";

function meta(overrides: Partial<ReportMeta> = {}): ReportMeta {
  return {
    repo: { owner: "example-org", name: "infra", serverUrl: "https://github.com" },
    headSha: HEAD,
    baseSha: BASE,
    version: "v0.1.0",
    ...overrides,
  };
}

const loc = (file: string, startLine: number, endLine = startLine, side?: "base"): SourceLocation =>
  side ? { file, startLine, endLine, side } : { file, startLine, endLine };

describe("locationUrl", () => {
  it("links head-side lines at the head SHA", () => {
    expect(locationUrl(loc("main.tf", 12), meta())).toBe(
      `https://github.com/example-org/infra/blob/${HEAD}/main.tf#L12`,
    );
    expect(locationUrl(loc("modules/db/main.tf", 20, 24), meta())).toBe(
      `https://github.com/example-org/infra/blob/${HEAD}/modules/db/main.tf#L20-L24`,
    );
  });

  it("links base-side lines at the base SHA, or not at all without one", () => {
    expect(locationUrl(loc("old.tf", 3, 9, "base"), meta())).toBe(
      `https://github.com/example-org/infra/blob/${BASE}/old.tf#L3-L9`,
    );
    expect(locationUrl(loc("old.tf", 3, 9, "base"), meta({ baseSha: undefined }))).toBeNull();
  });

  it("returns null without repo or SHA (local CLI runs)", () => {
    expect(locationUrl(loc("main.tf", 1), { version: "dev" })).toBeNull();
    expect(locationUrl(loc("main.tf", 1), meta({ headSha: undefined }))).toBeNull();
    expect(locationUrl(loc("main.tf", 1), meta({ headSha: "not-a-sha" }))).toBeNull();
  });

  it("follows GitHub Enterprise Server hosts and drops a trailing slash", () => {
    const ghes = meta({ repo: { owner: "o", name: "r", serverUrl: "https://ghe.example.com/" } });
    expect(locationUrl(loc("main.tf", 1), ghes)).toBe(`https://ghe.example.com/o/r/blob/${HEAD}/main.tf#L1`);
  });

  it("rejects non-https or credentialed server URLs", () => {
    for (const serverUrl of [
      "http://ghe.example.com",
      "javascript:alert(1)",
      "https://user:pw@ghe.example.com",
    ]) {
      expect(
        locationUrl(loc("main.tf", 1), meta({ repo: { owner: "o", name: "r", serverUrl } })),
        serverUrl,
      ).toBeNull();
    }
  });

  it("encodes path segments, owner and repo safely", () => {
    const m = meta({ repo: { owner: "o", name: "r (x)", serverUrl: "https://github.com" } });
    expect(locationUrl(loc("envs/prod (eu)/my file#1.tf", 2), m)).toBe(
      `https://github.com/o/r%20%28x%29/blob/${HEAD}/envs/prod%20%28eu%29/my%20file%231.tf#L2`,
    );
  });

  it("refuses traversal, absolute and scheme paths", () => {
    for (const file of ["../secrets.tf", "/etc/passwd", "https://evil.example/x", "a\\b.tf", ""]) {
      expect(locationUrl(loc(file, 1), meta()), file).toBeNull();
    }
  });

  it("drops the anchor for invalid lines and treats end < start as a single line", () => {
    expect(locationUrl(loc("main.tf", 0), meta())).toBe(
      `https://github.com/example-org/infra/blob/${HEAD}/main.tf`,
    );
    expect(locationUrl(loc("main.tf", 7, 3), meta())).toMatch(/#L7$/);
    expect(locationUrl({ file: "main.tf", startLine: 1.5, endLine: 2 }, meta())).not.toContain("#");
  });
});

describe("locationLabel", () => {
  it("formats single lines, ranges and deleted code", () => {
    expect(locationLabel(loc("main.tf", 12))).toBe("main.tf:12");
    expect(locationLabel(loc("main.tf", 12, 14))).toBe("main.tf:12-14");
    expect(locationLabel(loc("old.tf", 3, 9, "base"))).toBe("old.tf:3-9 (deleted)");
    expect(locationLabel(loc("./main.tf", 0))).toBe("main.tf");
  });
});

describe("locationMarkdown", () => {
  it("is a linked code span with a permalink, plain code without", () => {
    expect(locationMarkdown(loc("main.tf", 12), meta())).toBe(
      `[\`main.tf:12\`](https://github.com/example-org/infra/blob/${HEAD}/main.tf#L12)`,
    );
    expect(locationMarkdown(loc("main.tf", 12), { version: "dev" })).toBe("`main.tf:12`");
  });

  it("shows hostile file names inertly", () => {
    const out = locationMarkdown(loc("<img src=x>`@octocat.tf", 1), { version: "dev" });
    expect(out).toBe("``<img src=x>`@octocat.tf:1``");
  });
});

describe("runUrl", () => {
  it("returns only safe https run URLs", () => {
    expect(runUrl(meta({ run: { id: 1, attempt: 1, url: "https://github.com/o/r/actions/runs/1" } }))).toBe(
      "https://github.com/o/r/actions/runs/1",
    );
    expect(runUrl(meta({ run: { id: 1, attempt: 1, url: "javascript:alert(1)" } }))).toBeNull();
    expect(runUrl(meta())).toBeNull();
  });
});
