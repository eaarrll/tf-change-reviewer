import { describe, expect, it } from "vitest";
import { parseConfirmedIds, parseDataMarker, parseFeedback } from "../../src/metrics/feedback.js";
import {
  COMMENT_MARKER,
  MAX_COMMENT_CHARS,
  checkboxId,
  commentMarker,
  isIncompletePlan,
  feedbackCheckbox,
  groupByKind,
  isReviewComment,
  isWrittenByNewerRun,
  parseRunStamp,
  renderCliReport,
  renderCounts,
  renderDataMarker,
  renderJobSummary,
  renderJson,
  renderReviewComment,
  runStamp,
  toJsonReport,
} from "../../src/report/markdown.js";
import type { Finding, LineageStep, Review, ScoredChange } from "../../src/types.js";
import {
  BASE_BLOB,
  BLOB,
  agentInfo,
  dbFinding,
  dbLineage,
  makeChange,
  makeMeta,
  makeReview,
  scored,
  sgFinding,
  typicalOthers,
} from "./builders.js";

const ZWSP = "​";
const FAKE_AWS_KEY = "AKIAZ7Q2X4M8N6P3R5T1";

/** Raw (unescaped) HTML tags outside code spans, minus the ones the renderer itself emits. */
function foreignHtml(markdown: string): string[] {
  const ours = /^<\/?(?:details|summary|sub)>$|^<!-- (?:tf-change-reviewer|finding:)/;
  return (outsideCode(markdown).match(/<[A-Za-z!/][^>]*>?/g) ?? []).filter((tag) => !ours.test(tag));
}

/** Markdown with code spans and fences removed: what GitHub parses for mentions, references and links. */
function outsideCode(markdown: string): string {
  return markdown
    .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, "")
    .replace(/(?<!\\)(?:\\\\)*\\`/g, "")
    .replace(/(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g, "");
}

function count(haystack: string, needle: string | RegExp): number {
  return typeof needle === "string"
    ? haystack.split(needle).length - 1
    : (haystack.match(needle) ?? []).length;
}

// ───────────────────────────── markers ─────────────────────────────

describe("comment marker and run stamp", () => {
  it("starts with the marker, then the run stamp", () => {
    const body = renderReviewComment([makeReview()], makeMeta());
    const [first, second] = body.split("\n");
    expect(first).toBe(COMMENT_MARKER);
    expect(commentMarker()).toBe(COMMENT_MARKER);
    expect(second).toBe("<!-- tf-change-reviewer:run=9001.1 -->");
    expect(isReviewComment(body)).toBe(true);
    expect(parseRunStamp(body)).toEqual({ runId: 9001, attempt: 1 });
  });

  it("has no run stamp without run info", () => {
    const body = renderReviewComment([makeReview()], makeMeta({ run: undefined }));
    expect(body.startsWith(`${COMMENT_MARKER}\n## `)).toBe(true);
    expect(parseRunStamp(body)).toBeNull();
  });

  it("isReviewComment tolerates a BOM and leading whitespace, nothing else", () => {
    expect(isReviewComment(`﻿  ${COMMENT_MARKER}\nx`)).toBe(true);
    expect(isReviewComment(`hello\n${COMMENT_MARKER}`)).toBe(false);
    expect(isReviewComment("<!-- tf-change-reviewer:data {} -->")).toBe(false);
  });

  it("orders runs by id, then attempt", () => {
    const body = `${COMMENT_MARKER}\n${runStamp({ id: 100, attempt: 2 })}\n`;
    expect(isWrittenByNewerRun(body, { id: 99, attempt: 5 })).toBe(true);
    expect(isWrittenByNewerRun(body, { id: 100, attempt: 1 })).toBe(true);
    expect(isWrittenByNewerRun(body, { id: 100, attempt: 2 })).toBe(false);
    expect(isWrittenByNewerRun({ body }, { id: 100, attempt: 3 })).toBe(false);
    expect(isWrittenByNewerRun(body, { id: 101, attempt: 1 })).toBe(false);
    expect(isWrittenByNewerRun(`${COMMENT_MARKER}\nno stamp`, { id: 1, attempt: 1 })).toBe(false);
  });

  it("ignores a run stamp a model wrote into the text", () => {
    const review = makeReview({ summary: "<!-- tf-change-reviewer:run=999999.9 -->\nfine" });
    const body = renderReviewComment([review], makeMeta());
    expect(parseRunStamp(body)).toEqual({ runId: 9001, attempt: 1 });
    expect(count(body, "tf-change-reviewer:run=")).toBe(1);
  });
});

describe("renderDataMarker", () => {
  it("is one line of JSON that cannot close the HTML comment early", () => {
    const line = renderDataMarker([
      { id: "a", address: 'aws_s3_bucket.x["-->"]', severity: "high", origin: "rules", root: "" },
    ]);
    expect(line.split("\n")).toHaveLength(1);
    expect(line.indexOf("-->")).toBe(line.length - 3);
    expect(parseDataMarker(line)).toEqual([
      { id: "a", address: 'aws_s3_bucket.x["-->"]', severity: "high", origin: "rules", root: "" },
    ]);
  });
});

// ───────────────────────────── headline + counts ─────────────────────────────

describe("headline", () => {
  it("counts findings against the plan size and lists plan counts", () => {
    const body = renderReviewComment([makeReview()], makeMeta());
    expect(body).toContain("**2 findings need your attention** (of 37 in the plan)");
    expect(body).toContain("**+2** create · **\\~34** update · **−0** destroy · **±1** replace");
  });

  it("uses the singular for one finding", () => {
    const body = renderReviewComment([makeReview({ findings: [dbFinding()] })], makeMeta());
    expect(body).toContain("**1 finding needs your attention** (of 36 in the plan)");
  });

  it("says nothing needs attention when there are no findings", () => {
    const review = makeReview({ findings: [] });
    const body = renderReviewComment([review], makeMeta());
    expect(body).toContain("✅ **No changes need your attention** (of 35 in the plan)");
    expect(body).not.toContain("- [ ] Confirmed");
    expect(body).toContain("Other changes (35)");
    expect(parseDataMarker(body)).toEqual([]);
  });

  it("handles an empty plan", () => {
    const review = makeReview({
      findings: [],
      others: [],
      stats: { totalChanges: 0, counts: {}, bySeverity: {} },
      summary: "",
    });
    const body = renderReviewComment([review], makeMeta());
    expect(body).toContain("✅ **No changes.** Infrastructure matches the configuration.");
    expect(body).not.toContain("Other changes");
    expect(body).not.toContain("create ·");
  });

  it("renderCounts adds moves, imports, forgets and reads only when present", () => {
    expect(renderCounts({ create: 1 })).toBe(
      "**+1** create · **\\~0** update · **−0** destroy · **±0** replace",
    );
    expect(renderCounts({ move: 2, import: 1, forget: 3, read: 1 })).toBe(
      "**+0** create · **\\~0** update · **−0** destroy · **±0** replace · **2** moves · **1** import · **3** forgets · **1** read",
    );
  });
});

// ───────────────────────────── findings ─────────────────────────────

describe("findings", () => {
  const body = renderReviewComment([makeReview()], makeMeta());

  it("shows badge, address, title, action, impact and cause", () => {
    expect(body).toContain("#### 🔴 Critical · `module.orders_db.aws_db_instance.this`");
    expect(body).toContain("**Production database orders-prod will be destroyed and re-created** · ±replace");
    expect(body).toContain("**Why it matters:** All data in orders-prod is lost");
    expect(body).toContain("**Why it happens:** `storage_encrypted` cannot change in place");
    expect(body).toContain('#### 🟠 High · `aws_security_group_rule.ingress["ssh"]`');
    expect(body).toContain("**SSH open to the internet** · +create");
  });

  it("orders findings as given (the review's ranking)", () => {
    expect(body.indexOf("🔴 Critical")).toBeLessThan(body.indexOf("🟠 High"));
  });

  it("renders the cause chain with permalinks, marking the changed line", () => {
    expect(body).toContain(
      `**Cause chain:** \`storage_encrypted\` ← [\`modules/db/main.tf:24\`](${BLOB}/modules/db/main.tf#L24) ← **[\`main.tf:12\`](${BLOB}/main.tf#L12)** ✏️ · ✏️ changed in this PR`,
    );
    expect(body).toContain(`**[\`network.tf:40-47\`](${BLOB}/network.tf#L40-L47)** ✏️`);
  });

  it("includes the collapsed trace with labels, snippets and root causes", () => {
    expect(body).toContain("<details><summary>How this was traced (2 steps)</summary>");
    expect(body).toContain('2. ✏️ **module "orders\\_db" argument encrypted** ·');
    expect(body).toContain("`encrypted = false`");
  });

  it("shows rule ids, confidence and origin small", () => {
    expect(body).toContain(
      "<sub>rules: `stateful-replace` `force-new-attribute` · confidence: high · raised by: rules + AI review</sub>",
    );
    expect(body).toContain("<sub>rules: `sg-open-world` · confidence: medium · raised by: rules</sub>");
  });

  it("adds one feedback checkbox per finding, keyed by finding id", () => {
    expect(body).toContain("- [ ] Confirmed: this needs attention <!-- finding:f-3a9c1e07 -->");
    expect(body).toContain("- [ ] Confirmed: this needs attention <!-- finding:f-77b2d410 -->");
    expect(count(body, /^- \[ \] Confirmed/gm)).toBe(2);
  });

  it("records the findings in the hidden data marker", () => {
    expect(body.trimEnd().split("\n").at(-1)).toMatch(/^<!-- tf-change-reviewer:data \{.*\} -->$/);
    expect(parseDataMarker(body)).toEqual([
      {
        id: "f-3a9c1e07",
        address: "module.orders_db.aws_db_instance.this",
        severity: "critical",
        origin: "both",
        root: "",
      },
      {
        id: "f-77b2d410",
        address: 'aws_security_group_rule.ingress["ssh"]',
        severity: "high",
        origin: "rules",
        root: "",
      },
    ]);
  });

  it("links base-side (deleted) code at the base SHA and labels it", () => {
    const finding = sgFinding({
      action: "delete",
      causeLinks: [
        {
          location: { file: "old.tf", startLine: 3, endLine: 9, side: "base" },
          label: "old.tf:3-9",
          changedInDiff: true,
        },
      ],
    });
    const out = renderReviewComment([makeReview({ findings: [finding] })], makeMeta());
    expect(out).toContain(`[\`old.tf:3-9 (deleted)\`](${BASE_BLOB}/old.tf#L3-L9)`);
    const noBase = renderReviewComment(
      [makeReview({ findings: [finding] })],
      makeMeta({ baseSha: undefined }),
    );
    expect(noBase).toContain("**`old.tf:3-9 (deleted)`** ✏️");
    expect(noBase).not.toContain("/old.tf#");
  });

  it("renders plain location labels without repo meta", () => {
    const out = renderReviewComment([makeReview()], { version: "dev" });
    expect(out).toContain("← **`main.tf:12`** ✏️");
    expect(out).not.toContain("](https://");
  });

  it("merges a cause link with the lineage step at the same location", () => {
    expect(
      count(body.split("\n").find((l) => l.startsWith("**Cause chain:** `storage")) ?? "", "main.tf:12"),
    ).toBe(1);
  });

  it("explains changes no PR line caused", () => {
    const external = dbFinding({
      causeLinks: [],
      lineage: {
        ...dbLineage(),
        rootCauseIds: [],
        explanation: "external",
        steps: dbLineage().steps.slice(0, 1),
      },
    });
    const out = renderReviewComment([makeReview({ findings: [external] })], makeMeta());
    // "Why it happens" names the likely source; no generic banner repeats it.
    expect(out).not.toContain("Not caused by code in this PR");
    expect(out).toContain("**Why it happens:**");
  });

  it("points at the upstream resource for upstream explanations", () => {
    const upstreamStep: LineageStep = {
      id: "s1",
      kind: "upstream_resource",
      modulePath: [],
      label: "subnet replaced",
      references: [],
      changedInDiff: false,
      upstreamAddress: "aws_subnet.private[0]",
    };
    const finding = dbFinding({
      causeLinks: [],
      lineage: {
        ...dbLineage(),
        steps: [...dbLineage().steps.slice(0, 1), upstreamStep],
        rootCauseIds: [],
        explanation: "upstream",
      },
    });
    const out = renderReviewComment([makeReview({ findings: [finding] })], makeMeta());
    expect(out).toContain("↪️ Follows from the change to `aws_subnet.private[0]`.");
    expect(out).toContain("← `aws_subnet.private[0]`");
  });

  it("notes when tracing stopped", () => {
    const finding = dbFinding({ lineage: { ...dbLineage(), rootCauseIds: [], explanation: "unknown" } });
    const out = renderReviewComment([makeReview({ findings: [finding] })], makeMeta());
    expect(out).toContain("_Tracing stopped before reaching a changed line._");
  });

  it("caps long cause chains, keeping the first and the upstream end", () => {
    const steps: LineageStep[] = Array.from({ length: 12 }, (_, i) => ({
      id: `s${i}`,
      kind: "local",
      modulePath: [],
      label: `step ${i}`,
      references: [],
      location: { file: `f${i}.tf`, startLine: i + 1, endLine: i + 1 },
      changedInDiff: i === 11,
    }));
    const finding = dbFinding({
      causeLinks: [],
      lineage: { ...dbLineage(), steps, rootCauseIds: ["s11"] },
    });
    const out = renderReviewComment([makeReview({ findings: [finding] })], makeMeta());
    const chain = out.split("\n").find((l) => l.startsWith("**Cause chain:**")) ?? "";
    expect(chain).toContain("f0.tf:1");
    expect(chain).toContain(" ← … ← ");
    expect(chain).toContain("f11.tf:12");
    expect(chain).not.toContain("f3.tf:4");
  });

  it("keeps duplicate finding ids distinct (two root modules, same id)", () => {
    const a = makeReview({ rootModuleDir: "envs/prod", findings: [dbFinding()] });
    const b = makeReview({ rootModuleDir: "envs/staging", findings: [dbFinding()] });
    const out = renderReviewComment([a, b], makeMeta());
    const ids = (parseDataMarker(out) ?? []).map((f) => f.id);
    expect(ids).toEqual([checkboxId("f-3a9c1e07", "envs/prod"), checkboxId("f-3a9c1e07", "envs/staging")]);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toMatch(/^f-3a9c1e07:[0-9a-f]{8}$/);
    expect(out).toContain(`<!-- finding:${ids[1]} -->`);
    // The repository root keeps the bare id (comments from before root-qualified keys keep their ticks).
    expect(checkboxId("f-3a9c1e07", "")).toBe("f-3a9c1e07");
    expect(checkboxId("f-3a9c1e07", "./envs/prod/")).toBe(ids[0]);
  });

  it("keeps a tick on its own root's finding when another root's finding goes away", () => {
    const a = makeReview({ rootModuleDir: "envs/a", findings: [dbFinding()] });
    const b = makeReview({ rootModuleDir: "envs/b", findings: [dbFinding()] });
    const first = renderReviewComment([a, b], makeMeta());
    const keyA = checkboxId("f-3a9c1e07", "envs/a");
    const ticked = first.replace(
      `- [ ] Confirmed: this needs attention <!-- finding:${keyA} -->`,
      `- [x] Confirmed: this needs attention <!-- finding:${keyA} -->`,
    );
    expect(parseConfirmedIds(ticked)).toEqual(new Set([keyA]));
    // The next push fixes envs/a: envs/b's finding must not inherit envs/a's tick.
    const second = renderReviewComment(
      [makeReview({ rootModuleDir: "envs/a", findings: [] }), b],
      makeMeta(),
      {
        confirmedIds: parseConfirmedIds(ticked),
      },
    );
    const fb = parseFeedback(second, []);
    expect(fb.findings.filter((f) => !f.earlier).map((f) => [f.root, f.confirmed])).toEqual([
      ["envs/b", false],
    ]);
    expect(second).not.toContain("- [x] Confirmed");
  });

  it("restricts checkbox keys to a safe alphabet", () => {
    const out = renderReviewComment(
      [makeReview({ findings: [dbFinding({ id: "x --> <b>y" })] })],
      makeMeta(),
    );
    expect(out).toContain("<!-- finding:x_--___b_y -->");
    expect(parseConfirmedIds(out.replace("- [ ]", "- [x]"))).toEqual(new Set(["x_--___b_y"]));
  });

  it("keeps reviewers' ticks when re-rendered with confirmedIds", () => {
    const out = renderReviewComment([makeReview()], makeMeta(), { confirmedIds: ["f-77b2d410"] });
    expect(out).toContain("- [x] Confirmed: this needs attention <!-- finding:f-77b2d410 -->");
    expect(out).toContain("- [ ] Confirmed: this needs attention <!-- finding:f-3a9c1e07 -->");
  });

  it("round-trips through parseFeedback", () => {
    const out = renderReviewComment([makeReview()], makeMeta()).replace(
      "- [ ] Confirmed: this needs attention <!-- finding:f-3a9c1e07 -->",
      "- [x] Confirmed: this needs attention <!-- finding:f-3a9c1e07 -->",
    );
    const fb = parseFeedback(out, [{ body: "missed: `aws_iam_role_policy.app`" }]);
    expect(fb.findings.map((f) => [f.id, f.confirmed])).toEqual([
      ["f-3a9c1e07", true],
      ["f-77b2d410", false],
    ]);
    expect(fb.missed).toEqual(["aws_iam_role_policy.app"]);
  });
});

// ───────────────────────────── other changes ─────────────────────────────

describe("other changes", () => {
  const body = renderReviewComment([makeReview()], makeMeta());

  it("are collapsed and grouped by severity", () => {
    expect(body).toContain("<details><summary>Other changes (35)</summary>");
    const medium = body.indexOf("**🟡 Medium (1)**");
    const low = body.indexOf("**⚪ Low (2)**");
    const noise = body.indexOf("**🔇 Noise (32)**");
    expect(medium).toBeGreaterThan(0);
    expect(low).toBeGreaterThan(medium);
    expect(noise).toBeGreaterThan(low);
  });

  it("list each non-noise change with action and reason", () => {
    expect(body).toContain("- `aws_iam_role_policy.app` · \\~update · IAM policy document changes.");
    expect(body).toContain("- `aws_s3_bucket.assets` · +create");
    expect(body).toContain("- `aws_lambda_function.api` · \\~update · changes `memory_size`");
  });

  it("summarize noise by kind", () => {
    expect(body).toContain("- 24 tag-only updates (`aws_s3_bucket` ×20, `aws_sqs_queue` ×4)");
    expect(body).toContain("- 8 `aws_cloudwatch_log_group` updates changing `retention_in_days`");
    expect(body).not.toContain("aws_cloudwatch_log_group.svc0");
  });

  it("show example addresses for small noise kinds and moves", () => {
    const others: ScoredChange[] = [
      scored(makeChange("aws_kms_key.k", "update", { changedPaths: [["description"]] }), "noise"),
      scored(makeChange("aws_s3_bucket.new", "move", { previousAddress: "aws_s3_bucket.old" }), "low"),
    ];
    const out = renderReviewComment([makeReview({ others })], makeMeta());
    expect(out).toContain("- 1 `aws_kms_key` update changing `description`: `aws_kms_key.k`");
    expect(out).toContain("- `aws_s3_bucket.new` · move · moved from `aws_s3_bucket.old`");
  });

  it("summarize a long list beyond the per-severity cap", () => {
    const others = Array.from({ length: 70 }, (_, i) =>
      scored(
        makeChange(`aws_instance.web${i}`, "update", { changedPaths: [["instance_type"], [`a${i}`]] }),
        "medium",
      ),
    );
    const out = renderReviewComment([makeReview({ others })], makeMeta());
    expect(out).toContain("`aws_instance.web39`");
    expect(out).not.toContain("- `aws_instance.web40` ·");
    expect(out).toContain("- …and 30 more:");
  });

  it("put changes that read the same on one line, with the address pattern", () => {
    const others = Array.from({ length: 9 }, (_, i) =>
      scored(
        makeChange(`module.svc["s${i}"].aws_cloudwatch_log_group.this`, "update", {
          changedPaths: [["retention_in_days"]],
        }),
        "medium",
        [
          {
            ruleId: "retention",
            severity: "medium",
            reason: "retention_in_days 30 → 14 shortens retention.",
          },
        ],
      ),
    );
    const out = renderReviewComment([makeReview({ others })], makeMeta());
    expect(out).toContain(
      "- 9 × `module.svc[*].aws_cloudwatch_log_group.this` · \\~update · retention\\_in\\_days 30 → 14 shortens retention.",
    );
    expect(count(out, /retention\\_in\\_days 30/g)).toBe(1);
  });
});

describe("groupByKind", () => {
  it("groups by action, type and changed attribute names; tag-only across types", () => {
    const kinds = groupByKind(typicalOthers());
    const labels = kinds.map((k) => [k.key, k.changes.length]);
    expect(labels[0]).toEqual(["tag-only", 24]);
    expect(labels).toContainEqual(["update|aws_cloudwatch_log_group|retention_in_days", 8]);
    expect(labels).toContainEqual(["create|aws_s3_bucket|", 1]);
  });

  it("does not treat a tags change plus another attribute as tag-only", () => {
    const kinds = groupByKind([
      scored(makeChange("aws_s3_bucket.a", "update", { changedPaths: [["tags", "x"], ["acl"]] }), "low"),
    ]);
    expect(kinds[0]?.tagOnly).toBe(false);
    expect(kinds[0]?.attrs).toEqual(["acl", "tags"]);
  });
});

// ───────────────────────────── multiple root modules ─────────────────────────────

describe("multiple root modules", () => {
  const prod = makeReview({
    rootModuleDir: "envs/prod",
    warnings: ["Lineage: tfvars file outside the repo."],
  });
  const staging = makeReview({
    rootModuleDir: "envs/staging/",
    findings: [],
    others: [scored(makeChange("aws_sqs_queue.q", "update", { changedPaths: [["tags", "a"]] }), "noise")],
    stats: { totalChanges: 1, counts: { update: 1 }, bySeverity: { noise: 1 } },
    agent: agentInfo({ costUsd: 0.1, turns: 2 }),
  });
  const body = renderReviewComment([prod, staging], makeMeta());

  it("has an overall headline and one section per module", () => {
    expect(body).toContain("**2 findings need your attention** across 2 root modules (of 38 in the plans)");
    expect(body).toContain("**+2** create · **\\~35** update · **−0** destroy · **±1** replace");
    expect(body).toContain("### `envs/prod` · 2 findings need your attention (of 37)");
    expect(body).toContain("### `envs/staging` · ✅ nothing needs your attention (of 1)");
  });

  it("records the root module of each finding", () => {
    expect((parseDataMarker(body) ?? []).map((f) => f.root)).toEqual(["envs/prod", "envs/prod"]);
  });

  it("prefixes warnings with the module and sums agent usage", () => {
    expect(body).toContain("<details><summary>⚠️ Warnings (1)</summary>");
    expect(body).toContain("- `envs/prod`: Lineage: tfvars file outside the repo.");
    expect(body).toContain("claude-opus-5-5 · 8 turns · \\$0.52");
  });

  it("mentions a non-root single module dir", () => {
    const out = renderReviewComment([makeReview({ rootModuleDir: "./infra/" })], makeMeta());
    expect(out).toContain("Root module: `infra`");
  });

  it("renders a comment with no reviews", () => {
    const out = renderReviewComment([], makeMeta());
    expect(out).toContain("**No plans to review.**");
    expect(parseDataMarker(out)).toEqual([]);
  });
});

// ───────────────────────────── footer + agent ─────────────────────────────

describe("footer", () => {
  it("explains how to give feedback and shows agent usage with a run link", () => {
    const body = renderReviewComment([makeReview()], makeMeta());
    expect(body).toContain("Tick **Confirmed** on each finding");
    expect(body).toContain("Reply `missed: <address>`");
    expect(body).toContain(
      "<sub>🤖 tf-change-reviewer v0.1.0 · claude-opus-5-5 · 6 turns · \\$0.42 · AI-assisted, verify before acting · [run](https://github.com/example-org/infra/actions/runs/9001)</sub>",
    );
  });

  it("says rules only without an agent, and hides the cost when unknown", () => {
    expect(renderReviewComment([makeReview({ agent: undefined })], makeMeta())).toContain(
      "rules only (no AI review)",
    );
    expect(
      renderReviewComment([makeReview({ agent: agentInfo({ status: "skipped" }) })], makeMeta()),
    ).toContain("rules only (no AI review)");
    const unknownCost = renderReviewComment(
      [makeReview({ agent: agentInfo({ costUsd: null }) })],
      makeMeta(),
    );
    expect(unknownCost).toContain("6 turns · AI-assisted");
    const cheap = renderReviewComment([makeReview({ agent: agentInfo({ costUsd: 0.004 }) })], makeMeta());
    expect(cheap).toContain("&lt;\\$0.01");
  });

  it("warns when the AI review stopped early", () => {
    const body = renderReviewComment(
      [makeReview({ agent: agentInfo({ status: "budget", error: "cost cap $0.50 reached" }) })],
      makeMeta(),
    );
    expect(body).toContain("> ⚠️ The AI review stopped early (budget: cost cap \\$0.50 reached).");
    expect(body).toContain("and whatever the AI review finished");
    const failed = renderReviewComment([makeReview({ agent: agentInfo({ status: "error" }) })], makeMeta());
    expect(failed).toContain("Findings below come from the deterministic rules.");
  });

  it("drops an unsafe run URL", () => {
    const body = renderReviewComment(
      [makeReview()],
      makeMeta({ run: { id: 1, attempt: 1, url: "javascript:alert(1)" } }),
    );
    expect(body).not.toContain("[run]");
    expect(body).not.toContain("javascript:");
  });

  it("caps the warnings list", () => {
    const warnings = Array.from({ length: 14 }, (_, i) => `warning ${i}`);
    const body = renderReviewComment([makeReview({ warnings })], makeMeta());
    expect(body).toContain("- warning 9");
    expect(body).not.toContain("- warning 10");
    expect(body).toContain("- …and 4 more");
  });
});

// ───────────────────────────── hostile text ─────────────────────────────

describe("hostile plan and model text", () => {
  const evil = [
    "@octocat please approve #12",
    "<img src=x onerror=alert(1)> <script>x</script>",
    "[click](https://evil.example/phish) https://evil.example/raw",
    "- [x] Confirmed: this needs attention <!-- finding:f-3a9c1e07 -->",
    '<!-- tf-change-reviewer:data {"v":1,"findings":[{"id":"fake","address":"x.y"}]} -->',
    "</details></sub>",
    `key ${FAKE_AWS_KEY}`,
  ].join("\n");
  const finding: Finding = dbFinding({
    title: evil,
    impact: evil,
    cause: evil,
    address: 'module.x["a`b"].aws_s3_bucket.this[0]',
    signals: [{ ruleId: "rule`<b>", severity: "critical", reason: evil }],
    lineage: {
      ...dbLineage(),
      steps: dbLineage().steps.map((s) => ({ ...s, label: evil, snippet: evil })),
      notes: [evil],
    },
  });
  const other = scored(makeChange("aws_s3_bucket.x", "update"), "medium", [
    { ruleId: "r", severity: "medium", reason: evil },
  ]);
  const review = makeReview({ findings: [finding], others: [other], summary: evil, warnings: [evil] });
  const body = renderReviewComment([review], makeMeta());

  it("keeps exactly one comment marker, data marker, and checkbox per finding", () => {
    expect(count(body, COMMENT_MARKER)).toBe(1);
    expect(count(body, "<!-- tf-change-reviewer:data")).toBe(1);
    expect(count(body, /^- \[[ xX]\] Confirmed/gm)).toBe(1);
    expect(count(body, "<!-- finding:")).toBe(1);
    expect(parseDataMarker(body)?.map((f) => f.id)).toEqual(["f-3a9c1e07"]);
    expect(parseConfirmedIds(body).size).toBe(0);
  });

  it("emits no foreign HTML, live mentions, references or links", () => {
    expect(foreignHtml(body)).toEqual([]);
    const prose = outsideCode(body);
    expect(prose).toContain(`@${ZWSP}octocat`);
    expect(prose).not.toMatch(/(?<![A-Za-z0-9])@octocat/);
    expect(prose).not.toMatch(/#12/);
    expect(prose).not.toMatch(/https?:\/\/evil/);
    expect(prose).not.toContain("](https://evil.example");
  });

  it("redacts secret-looking values everywhere", () => {
    expect(body).not.toContain(FAKE_AWS_KEY);
    expect(renderJobSummary([review], makeMeta())).not.toContain(FAKE_AWS_KEY);
    expect(renderCliReport([review])).not.toContain(FAKE_AWS_KEY);
    expect(renderJson([review])).not.toContain(FAKE_AWS_KEY);
  });

  it("shows addresses with backticks verbatim in code", () => {
    expect(body).toContain('``module.x["a`b"].aws_s3_bucket.this[0]``');
  });

  it("still parses as feedback with the real data", () => {
    const fb = parseFeedback(body, []);
    expect(fb.findings.map((f) => f.address)).toEqual(['module.x["a`b"].aws_s3_bucket.this[0]']);
  });
});

// ───────────────────────────── size limit ─────────────────────────────

function hugeReview(dir: string, findings: number, others: number, textLen = 1400): Review {
  const long = (seed: string): string =>
    `${seed} `.repeat(Math.ceil(textLen / (seed.length + 1))).slice(0, textLen);
  const fs: Finding[] = Array.from({ length: findings }, (_, i) =>
    dbFinding({
      id: `f-${dir}-${i}`,
      address: `module.db${i}.aws_db_instance.this`,
      title: long("Database will be replaced"),
      impact: long("Data loss"),
      cause: long("Changed input"),
    }),
  );
  const os: ScoredChange[] = Array.from({ length: others }, (_, i) =>
    scored(
      makeChange(`module.svc${i % 50}.aws_instance.web_${i}`, "update", {
        changedPaths: [[`attr_${i % 37}`]],
      }),
      i % 3 === 0 ? "medium" : i % 3 === 1 ? "low" : "noise",
      i % 3 === 0
        ? [{ ruleId: "x", severity: "medium", reason: `#${i} ${long("Reason").slice(0, 170)}` }]
        : [],
    ),
  );
  return makeReview({
    rootModuleDir: dir,
    findings: fs,
    others: os,
    stats: { totalChanges: findings + others, counts: { update: findings + others }, bySeverity: {} },
  });
}

describe("size limit", () => {
  it("fits a 400-change plan with every finding and its trace", () => {
    const body = renderReviewComment([hugeReview("", 3, 400, 200)], makeMeta());
    expect(body.length).toBeLessThan(MAX_COMMENT_CHARS);
    expect(body).not.toContain("trace details omitted");
    expect(body).not.toContain("long text shortened");
    expect(body).not.toMatch(/findings? not shown/);
    expect(count(body, /^- \[ \] Confirmed/gm)).toBe(3);
    // Long lists are capped for readability: the rest is summarized by kind.
    expect(body).toContain("- …and ");
  });

  it("adds no trim note for an ordinary plan", () => {
    expect(renderReviewComment([makeReview()], makeMeta())).not.toContain("✂️");
  });

  it("cuts other changes first", () => {
    const body = renderReviewComment([hugeReview("", 5, 5000, 300)], makeMeta());
    expect(body.length).toBeLessThanOrEqual(MAX_COMMENT_CHARS);
    expect(body).toMatch(/✂️ _Not shown here: [\d,]+ other changes? not listed/);
    expect(body).not.toContain("trace details omitted");
    expect(body).not.toMatch(/findings? not shown/);
    expect(count(body, /^- \[ \] Confirmed/gm)).toBe(5);
    expect(body).toContain("<details><summary>How this was traced");
  });

  it("then drops lineage detail and shortens text, then findings, saying so", () => {
    const body = renderReviewComment([hugeReview("", 60, 3000)], makeMeta());
    expect(body.length).toBeLessThanOrEqual(MAX_COMMENT_CHARS);
    expect(body).toContain("trace details omitted");
    expect(body).toContain("long text shortened");
    expect(body).toMatch(/\d+ findings? not shown/);
    expect(body).toMatch(/_\d+ more findings? not shown to fit the comment\._/);
    const marker = parseDataMarker(body) ?? [];
    expect(marker.length).toBe(count(body, /^- \[ \] Confirmed/gm));
    expect(marker.length).toBeGreaterThan(0);
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
  });

  it("respects maxChars including the header, and keeps the data marker", () => {
    for (const maxChars of [8000, 20_000]) {
      const body = renderReviewComment([hugeReview("", 20, 500)], makeMeta(), { maxChars });
      expect(body.length, String(maxChars)).toBeLessThanOrEqual(maxChars);
      expect(parseDataMarker(body), String(maxChars)).not.toBeNull();
    }
  });

  it("drops trailing root modules only when even headlines overflow", () => {
    const reviews = Array.from({ length: 400 }, (_, i) =>
      hugeReview(`envs/team-${i}/${"x".repeat(80)}`, 1, 5, 100),
    );
    const body = renderReviewComment(reviews, makeMeta());
    expect(body.length).toBeLessThanOrEqual(MAX_COMMENT_CHARS);
    expect(body).toMatch(/_\d+ more root modules? not shown\._/);
    expect(body).toContain("<!-- tf-change-reviewer:data");
  });

  it("job summary keeps far more detail than the comment", () => {
    const review = hugeReview("", 5, 5000, 300);
    const summary = renderJobSummary([review], makeMeta());
    expect(summary.length).toBeGreaterThan(MAX_COMMENT_CHARS);
    expect(summary.length).toBeLessThan(1_000_000);
  });
});

// ───────────────────────────── job summary ─────────────────────────────

describe("renderJobSummary", () => {
  const summary = renderJobSummary([makeReview()], makeMeta());

  it("has the review but no markers or checkboxes", () => {
    expect(summary).toContain("**2 findings need your attention** (of 37 in the plan)");
    expect(summary).not.toContain(COMMENT_MARKER);
    expect(summary).not.toContain("<!--");
    expect(summary).not.toContain("Confirmed");
    expect(summary).not.toContain("missed:");
  });

  it("adds an AI usage table", () => {
    expect(summary).toContain("#### AI review usage");
    expect(summary).toContain(
      "| . | claude-opus-5-5 | complete | 6 | 9 | 52,000 | 3,100 | \\$0.4213 | 48.2s |",
    );
  });

  it("omits the usage table without an agent run", () => {
    expect(renderJobSummary([makeReview({ agent: undefined })], makeMeta())).not.toContain("AI review usage");
  });
});

// ───────────────────────────── CLI ─────────────────────────────

describe("renderCliReport", () => {
  const report = renderCliReport([makeReview()]);

  it("is plain text with the headline, findings and cause chain", () => {
    expect(report).toContain("Terraform change review: 2 findings need your attention (of 37 in the plan)");
    expect(report).toContain("Plan: +2 create, ~34 update, -0 destroy, ±1 replace");
    expect(report).toContain("[CRITICAL] module.orders_db.aws_db_instance.this  (± replace)");
    expect(report).toContain("  Cause: storage_encrypted");
    expect(report).toContain(
      '    <- main.tf:12  module "orders_db" argument encrypted: encrypted = false  [changed in this PR]',
    );
    expect(report).toContain("    24 tag-only updates (aws_s3_bucket x20, aws_sqs_queue x4)");
    expect(report).toContain("AI review: claude-opus-5-5 · 6 turns · $0.42 · complete");
  });

  it("has no HTML, markdown links or ANSI codes by default", () => {
    expect(report).not.toMatch(/<\/?(details|summary|sub)>|<!--/);
    expect(report).not.toContain("](");
    expect(report).not.toContain("\u001b[");
  });

  it("colors severities when asked", () => {
    const colored = renderCliReport([makeReview()], { color: true });
    expect(colored).toContain("\u001b[1m\u001b[31m[CRITICAL]\u001b[0m");
  });

  it("strips terminal escapes from hostile text", () => {
    const review = makeReview({
      summary: "ok\u001b]0;pwned\u0007 \u001b[2J",
      findings: [dbFinding({ title: "t\u001b[31mred", address: "a.b\u009b2J" })],
    });
    const out = renderCliReport([review]);
    expect(out).not.toMatch(/[\u001b\u0007\u009b]/);
  });

  it("covers no changes, multiple modules, base-side locations and stopped agents", () => {
    expect(
      renderCliReport([
        makeReview({ findings: [], others: [], stats: { totalChanges: 0, counts: {}, bySeverity: {} } }),
      ]),
    ).toContain("Terraform change review: No changes.");
    const base = sgFinding({
      causeLinks: [
        {
          location: { file: "old.tf", startLine: 3, endLine: 9, side: "base" },
          label: "",
          changedInDiff: true,
        },
      ],
    });
    const multi = renderCliReport([
      makeReview({ rootModuleDir: "envs/prod", findings: [base], agent: agentInfo({ status: "timeout" }) }),
      makeReview({ rootModuleDir: "envs/dev", findings: [], agent: undefined, warnings: ["no diff"] }),
    ]);
    expect(multi).toContain("== envs/prod ==");
    expect(multi).toContain("== envs/dev ==");
    expect(multi).toContain("    <- old.tf:3-9 (deleted)  [changed in this PR]");
    expect(multi).toContain("AI review stopped early (timeout); findings come from the rules.");
    expect(multi).toContain("warning: no diff");
    expect(multi).not.toContain("\n\n\n");
  });

  it("lists others up to maxOthers, then summarizes", () => {
    const others = Array.from({ length: 5 }, (_, i) =>
      scored(makeChange(`aws_instance.w${i}`, "update", { changedPaths: [["ami"], [`a${i}`]] }), "low"),
    );
    const out = renderCliReport([makeReview({ others })], { maxOthers: 2 });
    expect(out).toContain("~ update  aws_instance.w1  changes a1, ami");
    expect(out).not.toContain("aws_instance.w2");
    expect(out).toContain("...and 3 more:");
  });
});

// ───────────────────────────── JSON ─────────────────────────────

describe("renderJson", () => {
  it("is stable, parseable and free of Sets, Maps and resource values", () => {
    const reviews = [makeReview()];
    const a = renderJson(reviews);
    expect(renderJson(reviews)).toBe(a);
    const parsed = JSON.parse(a) as ReturnType<typeof toJsonReport>;
    expect(parsed.version).toBe(1);
    expect(parsed.totals).toEqual({
      findings: 2,
      changes: 37,
      counts: { create: 2, replace: 1, update: 34 },
    });
    expect(Object.keys(parsed.reviews[0] ?? {})).toEqual([
      "rootModuleDir",
      "summary",
      "stats",
      "findings",
      "others",
      "agent",
      "notices",
      "warnings",
    ]);
    expect(a).not.toContain('"before"');
    expect(a).not.toContain('"after"');
    expect(JSON.parse(JSON.stringify(toJsonReport(reviews)))).toEqual(toJsonReport(reviews));
  });

  it("keeps findings, lineage and base-side locations", () => {
    const base = sgFinding({
      causeLinks: [
        {
          location: { file: "old.tf", startLine: 3, endLine: 9, side: "base" },
          label: "x",
          changedInDiff: true,
        },
      ],
    });
    const report = toJsonReport([makeReview({ findings: [dbFinding(), base] })]);
    const [db, sg] = report.reviews[0]?.findings ?? [];
    expect(db?.lineage?.steps.map((s) => s.id)).toEqual(["s0", "s1"]);
    expect(db?.lineage?.rootCauseIds).toEqual(["s1"]);
    expect(sg?.causeLinks[0]?.location).toEqual({ file: "old.tf", startLine: 3, endLine: 9, side: "base" });
    expect(sg && "lineage" in sg).toBe(false);
  });

  it("describes others with display paths", () => {
    const others = [
      scored(
        makeChange("aws_security_group.web", "replace", {
          changedPaths: [["ingress", 0, "cidr_blocks", 0]],
          replacePaths: [["name"]],
          previousAddress: "aws_security_group.old",
        }),
        "high",
        [{ ruleId: "sg", severity: "high", reason: "r", path: ["ingress"] }],
        77,
      ),
    ];
    const report = toJsonReport([makeReview({ others })]);
    const other = report.reviews[0]?.others[0];
    expect(other?.address).toBe("aws_security_group.web");
    expect(other?.score).toBe(77);
    expect(other?.replacePaths).toEqual(["name"]);
    expect(other?.previousAddress).toBe("aws_security_group.old");
    expect(other?.changedAttributes).toHaveLength(1);
  });

  it("gives null agent and empty totals for no reviews", () => {
    expect(toJsonReport([]).totals).toEqual({ findings: 0, changes: 0, counts: {} });
    expect(toJsonReport([makeReview({ agent: undefined })]).reviews[0]?.agent).toBeNull();
  });
});

describe("feedbackCheckbox", () => {
  it("renders unchecked and checked boxes", () => {
    expect(feedbackCheckbox("k")).toBe("- [ ] Confirmed: this needs attention <!-- finding:k -->");
    expect(feedbackCheckbox("k", true)).toBe("- [x] Confirmed: this needs attention <!-- finding:k -->");
  });
});

it("escapes ZWSP-separated mentions in summaries", () => {
  const body = renderReviewComment([makeReview({ summary: "cc @platform-team" })], makeMeta());
  expect(body).toContain(`cc @${ZWSP}platform-team`);
});

describe("grouped findings and plan notices", () => {
  const related = ["aws_s3_bucket.data[1]", "aws_s3_bucket.data[2]"];

  it("lists related addresses compactly and records them in the data marker", () => {
    const review = makeReview({ findings: [dbFinding({ relatedAddresses: related })] });
    const body = renderReviewComment([review], makeMeta());
    expect(body).toContain(
      "**Same cause, also changes (2):**\n- `aws_s3_bucket` ±replace ×2: `aws_s3_bucket.data[1]`, `aws_s3_bucket.data[2]`",
    );
    expect(parseDataMarker(body)?.[0]?.related).toEqual(related);
    expect(renderCliReport([review])).toContain(
      "  Same cause, also changes:\n    ± replace aws_s3_bucket x2: aws_s3_bucket.data[1], aws_s3_bucket.data[2]",
    );
    // With their own actions: a delete in the group is listed as a delete.
    const mixed = makeReview({
      findings: [
        dbFinding({
          relatedAddresses: related,
          relatedChanges: [
            { address: related[0]!, action: "replace", severity: "critical" },
            { address: related[1]!, action: "delete", severity: "critical" },
          ],
        }),
      ],
    });
    expect(renderReviewComment([mixed], makeMeta())).toContain(
      "- `aws_s3_bucket` −destroy: `aws_s3_bucket.data[2]`",
    );
    expect(toJsonReport([review]).reviews[0]?.findings[0]?.relatedAddresses).toEqual(related);
    // A `missed:` reply naming a related address confirms the finding instead of counting a miss.
    const feedback = parseFeedback(body, [{ body: "missed: aws_s3_bucket.data[2]" }]);
    expect(feedback.missed).toEqual([]);
    expect(feedback.findings[0]?.confirmed).toBe(true);
  });

  it("shows plan notices as a warning banner above the findings, in every format", () => {
    const review = makeReview({ notices: ["This plan is partial (made with -target or similar)."] });
    const body = renderReviewComment([review], makeMeta());
    const banner = body.indexOf("> [!WARNING]\n> This plan is partial");
    expect(banner).toBeGreaterThan(-1);
    expect(banner).toBeLessThan(body.indexOf("####"));
    expect(renderCliReport([review])).toContain("WARNING: This plan is partial");
    expect(toJsonReport([review]).reviews[0]?.notices).toEqual([
      "This plan is partial (made with -target or similar).",
    ]);
  });

  it("does not claim partial AI results when the AI review produced none", () => {
    const review = makeReview({
      findings: [dbFinding({ origin: "rules" })],
      agent: agentInfo({ status: "timeout", error: "deadline" }),
    });
    expect(renderReviewComment([review], makeMeta())).toMatch(
      /stopped early \(timeout: deadline\)\. Findings below come from the deterministic rules\./,
    );
  });
});

describe("plan health, counts and run-level warnings", () => {
  const empty = (overrides: Partial<Review> = {}): Review =>
    makeReview({
      findings: [],
      others: [],
      stats: { totalChanges: 0, counts: {}, bySeverity: {} },
      summary: "",
      ...overrides,
    });
  const errored = "This plan errored: Terraform stopped planning part-way.";

  it("never says the infrastructure matches the configuration for an errored or partial plan", () => {
    const out = renderReviewComment([empty({ notices: [errored], planIncomplete: true })], makeMeta());
    expect(out).not.toContain("✅");
    expect(out).not.toMatch(/Infrastructure matches the configuration/);
    expect(out).toContain("⚠️ **No changes in this plan**");
    expect(renderCliReport([empty({ notices: [errored], planIncomplete: true })])).not.toMatch(
      /: No changes\.$/m,
    );
    // Other notices (no PR diff, mass destroy) say nothing about whether the plan is complete.
    expect(renderReviewComment([empty({ notices: ["No PR diff was available."] })], makeMeta())).toContain(
      "✅ **No changes.**",
    );
    expect(isIncompletePlan({ errored: true })).toBe(true);
    expect(isIncompletePlan({ complete: false })).toBe(true);
    expect(isIncompletePlan({ complete: true, errored: false })).toBe(false);
    expect(isIncompletePlan("x")).toBe(false);
    // A complete plan with no changes still gets the green check.
    expect(renderReviewComment([empty()], makeMeta())).toContain("✅ **No changes.** Infrastructure matches");
    // With changes but an errored plan: no green check next to the warning either.
    const withChanges = renderReviewComment(
      [makeReview({ findings: [], notices: [errored], planIncomplete: true })],
      makeMeta(),
    );
    expect(withChanges).toContain("⚠️ **No changes need your attention**");
    // The review's own summary sentence would claim a match too: not shown for an empty incomplete plan.
    const claim = "No changes: the infrastructure matches the configuration.";
    const incomplete = empty({ notices: [errored], planIncomplete: true, summary: claim });
    expect(renderReviewComment([incomplete], makeMeta())).not.toContain(claim);
    expect(renderCliReport([incomplete])).not.toContain(claim);
    expect(renderReviewComment([empty({ summary: claim })], makeMeta())).toContain(claim);
  });

  it("counts data source reads apart under Other changes, as the headline does", () => {
    const others: ScoredChange[] = [
      { change: makeChange("aws_s3_bucket.a", "update"), score: 1, severity: "low", signals: [] },
      {
        change: makeChange("data.aws_iam_policy_document.p", "read"),
        score: 0,
        severity: "noise",
        signals: [],
      },
    ];
    const review = makeReview({
      findings: [],
      others,
      stats: { totalChanges: 2, counts: { update: 1, read: 1 }, bySeverity: { low: 1, noise: 1 } },
    });
    const md = renderReviewComment([review], makeMeta());
    expect(md).toContain("(of 1 in the plan)");
    expect(md).toContain("Other changes (1 + 1 read)");
    expect(renderCliReport([review])).toContain("Other changes (1 + 1 read)");
  });

  it("shows run-level warnings and warnings every root shares once", () => {
    const shared = "No PR diff: lineage cannot say which line causes a change.";
    const reviews = ["envs/a", "envs/b", "envs/c"].map((dir) =>
      makeReview({
        rootModuleDir: dir,
        warnings: [shared, ...(dir === "envs/b" ? ["trace limit hit"] : [])],
      }),
    );
    const md = renderReviewComment(
      reviews,
      makeMeta({ warnings: ["The PR diff comes from the GitHub API."] }),
    );
    expect(md.match(/No PR diff: lineage/g)).toHaveLength(1);
    expect(md.match(/comes from the GitHub API/g)).toHaveLength(1);
    expect(md).toContain("`envs/b`: trace limit hit");
    expect(md).toContain("⚠️ Warnings (3)");
    expect(toJsonReport(reviews, ["run warning"]).warnings).toEqual(["run warning"]);
    expect(toJsonReport(reviews).warnings).toBeUndefined();
  });

  it("asks for a root-qualified missed: reply when the comment covers several roots", () => {
    const md = renderReviewComment(
      [makeReview({ rootModuleDir: "envs/a" }), makeReview({ rootModuleDir: "envs/b", findings: [] })],
      makeMeta(),
    );
    expect(md).toContain("`missed: <root module dir>:<address>`");
    expect(parseDataMarker(md)).not.toBeNull();
    expect(md).toMatch(/"roots":\["envs\/a","envs\/b"\]/);
  });
});

describe("deposed leftovers and quoted keys", () => {
  it("names the deposed key in others (JSON, comment, CLI) and never merges it with live objects", () => {
    const live = makeChange("aws_instance.web", "delete");
    const deposed = makeChange("aws_instance.web", "delete", { deposed: "00cc22dd" });
    const others: ScoredChange[] = [
      scored(live, "medium", [{ ruleId: "d", severity: "medium", reason: "gone" }]),
      scored(deposed, "medium", [{ ruleId: "d", severity: "medium", reason: "gone" }]),
    ];
    const review = makeReview({ others });
    const json = toJsonReport([review]).reviews[0]?.others;
    expect(json?.[0]?.deposed).toBeUndefined();
    expect(json?.[1]?.deposed).toBe("00cc22dd");
    const body = renderReviewComment([review], makeMeta());
    expect(body).toContain("deposed object `00cc22dd`");
    expect(body).not.toMatch(/2 × `aws_instance\.web`/);
    expect(renderCliReport([review])).toContain("aws_instance.web (deposed 00cc22dd)");
  });

  it("groups related changes by type even when an instance key holds ']'", () => {
    const related = ['module.svc["x]y"].aws_s3_bucket.b'];
    const review = makeReview({ findings: [dbFinding({ relatedAddresses: related })] });
    expect(renderReviewComment([review], makeMeta())).toContain("- `aws_s3_bucket` ±replace:");
  });
});
