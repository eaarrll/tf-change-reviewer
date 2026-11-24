import { describe, expect, it } from "vitest";
import type { FlaggedFinding, PrFeedback } from "../../src/metrics/feedback.js";
import {
  computeMetrics,
  parseConfirmedIds,
  parseDataMarker,
  parseEarlierFindings,
  parseFeedback,
  parseMissedAddresses,
} from "../../src/metrics/feedback.js";
import { checkboxId, renderReviewComment } from "../../src/report/markdown.js";
import { dbFinding, makeMeta, makeReview, sgFinding } from "../report/builders.js";

/** A bot comment as the renderer writes it: db (critical, both) and sg (high, rules). */
function botComment(): string {
  return renderReviewComment([makeReview({ findings: [dbFinding(), sgFinding()] })], makeMeta());
}

function tick(body: string, id: string): string {
  return body.replace(
    `- [ ] Confirmed: this needs attention <!-- finding:${id} -->`,
    `- [x] Confirmed: this needs attention <!-- finding:${id} -->`,
  );
}

const DB = "module.orders_db.aws_db_instance.this";
const SG = 'aws_security_group_rule.ingress["ssh"]';

describe("parseDataMarker", () => {
  it("reads the findings of the hidden data line", () => {
    expect(parseDataMarker(botComment())?.map((f) => [f.id, f.address, f.severity, f.origin])).toEqual([
      ["f-3a9c1e07", DB, "critical", "both"],
      ["f-77b2d410", SG, "high", "rules"],
    ]);
  });

  it("returns null when the marker is missing or unreadable", () => {
    expect(parseDataMarker("no marker")).toBeNull();
    expect(parseDataMarker("<!-- tf-change-reviewer:data {not json} -->")).toBeNull();
    expect(parseDataMarker('<!-- tf-change-reviewer:data {"v":1} -->')).toBeNull();
    expect(parseDataMarker("<!-- tf-change-reviewer:data [1,2] -->")).toBeNull();
  });

  it("skips malformed and duplicate entries and fills unknown fields", () => {
    const line =
      '<!-- tf-change-reviewer:data {"v":1,"findings":[{"id":"a","address":"x.y"},{"id":"a","address":"x.z"},' +
      '{"id":"","address":"x.y"},{"address":"x.y"},null,"s",{"id":"b","address":"p.q","severity":"high","origin":"agent","root":"envs/prod"}]} -->';
    expect(parseDataMarker(line)).toEqual([
      { id: "a", address: "x.y", severity: "unknown", origin: "unknown" },
      { id: "b", address: "p.q", severity: "high", origin: "agent", root: "envs/prod" },
    ]);
  });

  it("finds the marker inside a CRLF body", () => {
    expect(parseDataMarker(botComment().replace(/\n/g, "\r\n"))).toHaveLength(2);
  });
});

describe("parseConfirmedIds", () => {
  it("reads ticked boxes, lower- or upper-case x, with any list bullet", () => {
    const body = [
      "- [x] Confirmed: this needs attention <!-- finding:a -->",
      "* [X] Confirmed: this needs attention <!-- finding:b -->",
      "  + [x] Confirmed: this needs attention <!--finding:c~2-->",
      "- [ ] Confirmed: this needs attention <!-- finding:d -->",
    ].join("\r\n");
    expect(parseConfirmedIds(body)).toEqual(new Set(["a", "b", "c~2"]));
  });

  it("ignores ticks that are not our checkbox lines", () => {
    const body = [
      "- [x] Done <!-- finding:a -->",
      "text - [x] Confirmed: this needs attention <!-- finding:b -->",
      "> - [x] Confirmed: this needs attention <!-- finding:c -->",
      "- [x] Confirmed: this needs attention",
    ].join("\n");
    expect(parseConfirmedIds(body).size).toBe(0);
  });
});

describe("parseMissedAddresses", () => {
  it("reads the documented form, with or without backticks", () => {
    expect(parseMissedAddresses("missed: aws_s3_bucket.logs")).toEqual(["aws_s3_bucket.logs"]);
    expect(parseMissedAddresses("missed: `aws_s3_bucket.logs`")).toEqual(["aws_s3_bucket.logs"]);
    expect(parseMissedAddresses("  Missed:`aws_s3_bucket.logs`")).toEqual(["aws_s3_bucket.logs"]);
    expect(parseMissedAddresses("**missed**: aws_s3_bucket.logs")).toEqual(["aws_s3_bucket.logs"]);
  });

  it("reads several per reply: several lines, list items, comma-separated", () => {
    const reply = [
      "Thanks! A few more:",
      "missed: `aws_iam_role.app`",
      "- missed: aws_kms_key.main, aws_kms_alias.main",
      "missed: `module.net.aws_route.default[0]` `data.aws_iam_policy_document.x`",
    ].join("\n");
    expect(parseMissedAddresses(reply)).toEqual([
      "aws_iam_role.app",
      "aws_kms_key.main",
      "aws_kms_alias.main",
      "module.net.aws_route.default[0]",
      "data.aws_iam_policy_document.x",
    ]);
  });

  it("keeps instance keys with quotes and spaces when backticked", () => {
    expect(parseMissedAddresses('missed: `module.svc["eu west"].aws_s3_bucket.this["logs"]`')).toEqual([
      'module.svc["eu west"].aws_s3_bucket.this["logs"]',
    ]);
    expect(parseMissedAddresses("missed: module.db[0]")).toEqual(["module.db[0]"]);
  });

  it("ignores prose, placeholders, trailing punctuation and quoted lines", () => {
    expect(parseMissedAddresses("missed: aws_s3_bucket.logs. It loses its policy!")).toEqual([
      "aws_s3_bucket.logs",
    ]);
    expect(parseMissedAddresses("missed: <address>")).toEqual([]);
    expect(parseMissedAddresses("> missed: aws_s3_bucket.logs")).toEqual([]);
    expect(parseMissedAddresses("I think you missed: aws_s3_bucket.logs")).toEqual([]);
    expect(parseMissedAddresses("missed:")).toEqual([]);
    expect(parseMissedAddresses("missed: nothing here")).toEqual([]);
  });

  it("deduplicates and caps", () => {
    expect(parseMissedAddresses("missed: a.b a.b\nmissed: `a.b`")).toEqual(["a.b"]);
    const many = Array.from({ length: 80 }, (_, i) => `x.r${i}`).join(" ");
    expect(parseMissedAddresses(`missed: ${many}`)).toHaveLength(50);
  });
});

describe("parseFeedback", () => {
  it("records flagged findings and ticked confirmations", () => {
    const fb = parseFeedback(tick(botComment(), "f-3a9c1e07"), []);
    expect(fb.hasReview).toBe(true);
    expect(fb.hasFeedback).toBe(true);
    expect(fb.findings.map((f) => [f.address, f.confirmed])).toEqual([
      [DB, true],
      [SG, false],
    ]);
    expect(fb.missed).toEqual([]);
  });

  it("has no feedback when nobody ticked or replied", () => {
    const fb = parseFeedback(botComment(), [{ body: "LGTM" }, { body: "missed: <address>" }]);
    expect(fb.hasReview).toBe(true);
    expect(fb.hasFeedback).toBe(false);
  });

  it("collects missed addresses from replies, sorted and deduplicated", () => {
    const fb = parseFeedback(botComment(), [
      { body: "missed: `aws_s3_bucket.logs`", author: "alice" },
      { body: "missed: aws_iam_role.app\nmissed: aws_s3_bucket.logs", author: "bob" },
    ]);
    expect(fb.missed).toEqual(["aws_iam_role.app", "aws_s3_bucket.logs"]);
    expect(fb.hasFeedback).toBe(true);
  });

  it("counts a `missed:` naming a flagged address as a confirmation, not a miss", () => {
    const fb = parseFeedback(botComment(), [{ body: `missed: \`${SG}\`` }]);
    expect(fb.missed).toEqual([]);
    expect(fb.findings.find((f) => f.address === SG)?.confirmed).toBe(true);
    expect(fb.hasFeedback).toBe(true);
  });

  it("ignores ticks on ids not in the data marker", () => {
    const body = `${botComment()}\n- [x] Confirmed: this needs attention <!-- finding:forged -->`;
    const fb = parseFeedback(body, []);
    expect(fb.findings.every((f) => !f.confirmed)).toBe(true);
    expect(fb.hasFeedback).toBe(false);
  });

  it("does not count a PR without our comment, even with missed replies", () => {
    const fb = parseFeedback(null, [{ body: "missed: aws_s3_bucket.logs" }]);
    expect(fb.hasReview).toBe(false);
    expect(fb.findings).toEqual([]);
    expect(fb.missed).toEqual(["aws_s3_bucket.logs"]);
    expect(fb.hasFeedback).toBe(false);
  });

  it("treats a comment with an unreadable marker as no review", () => {
    const body = botComment().replace(
      /<!-- tf-change-reviewer:data .* -->/,
      "<!-- tf-change-reviewer:data {oops -->",
    );
    expect(parseFeedback(tick(body, "f-3a9c1e07"), []).hasReview).toBe(false);
  });

  it("records a review with zero findings", () => {
    const body = renderReviewComment([makeReview({ findings: [] })], makeMeta());
    const fb = parseFeedback(body, [{ body: "missed: aws_s3_bucket.logs" }]);
    expect(fb.hasReview).toBe(true);
    expect(fb.findings).toEqual([]);
    expect(fb.missed).toEqual(["aws_s3_bucket.logs"]);
    expect(fb.hasFeedback).toBe(true);
  });
});

// ───────────────────────────── metrics ─────────────────────────────

function flagged(
  severity: string,
  origin: string,
  confirmed: boolean,
  id = `${severity}-${origin}`,
): FlaggedFinding {
  return { id, address: `x.${id}`, severity, origin, confirmed };
}

function pr(number: number, findings: FlaggedFinding[], missed: string[] = [], hasReview = true): PrFeedback {
  return {
    pr: { number },
    hasReview,
    findings,
    missed,
    hasFeedback: hasReview && (missed.length > 0 || findings.some((f) => f.confirmed)),
  };
}

describe("computeMetrics", () => {
  it("returns nulls when there is nothing to measure", () => {
    const m = computeMetrics([]);
    expect(m.precision).toBeNull();
    expect(m.recall).toBeNull();
    expect(m.prs).toEqual({ total: 0, reviewed: 0, counted: 0 });
    expect(m.bySeverity).toEqual({});
  });

  it("counts only PRs with feedback", () => {
    const m = computeMetrics([
      pr(1, [flagged("critical", "rules", true), flagged("high", "agent", false)]),
      pr(2, [flagged("high", "rules", false)]), // no feedback: ignored
      pr(3, [], [], false), // no review
    ]);
    expect(m.prs).toEqual({ total: 3, reviewed: 2, counted: 1 });
    expect(m.flagged).toBe(2);
    expect(m.confirmed).toBe(1);
    expect(m.precision).toBe(0.5);
    expect(m.recall).toBe(1);
  });

  it("computes precision = confirmed/flagged and recall = confirmed/(confirmed+missed)", () => {
    const m = computeMetrics([
      pr(
        10,
        [
          flagged("critical", "both", true, "a"),
          flagged("high", "rules", true, "b"),
          flagged("medium", "agent", false, "c"),
        ],
        ["aws_s3_bucket.logs"],
      ),
      pr(11, [flagged("high", "rules", false, "d")], ["aws_iam_role.app", "aws_kms_key.k"]),
    ]);
    expect(m.flagged).toBe(4);
    expect(m.confirmed).toBe(2);
    expect(m.missed).toBe(3);
    expect(m.precision).toBe(0.5);
    expect(m.recall).toBe(2 / 5);
    expect(m.bySeverity).toEqual({
      critical: { flagged: 1, confirmed: 1, precision: 1 },
      high: { flagged: 2, confirmed: 1, precision: 0.5 },
      medium: { flagged: 1, confirmed: 0, precision: 0 },
    });
    expect(m.byOrigin).toEqual({
      both: { flagged: 1, confirmed: 1, precision: 1 },
      rules: { flagged: 2, confirmed: 1, precision: 0.5 },
      agent: { flagged: 1, confirmed: 0, precision: 0 },
    });
    expect(m.missedChanges).toEqual([
      { pr: 10, address: "aws_s3_bucket.logs" },
      { pr: 11, address: "aws_iam_role.app" },
      { pr: 11, address: "aws_kms_key.k" },
    ]);
  });

  it("has null precision but a recall when the bot flagged nothing and missed something", () => {
    const m = computeMetrics([pr(5, [], ["aws_s3_bucket.logs"])]);
    expect(m.precision).toBeNull();
    expect(m.recall).toBe(0);
    expect(m.missedChanges).toEqual([{ pr: 5, address: "aws_s3_bucket.logs" }]);
  });

  it("works end to end from rendered comments", () => {
    const one = parseFeedback(tick(botComment(), "f-3a9c1e07"), [{ body: "missed: aws_s3_bucket.logs" }]);
    const two = parseFeedback(botComment(), []);
    const m = computeMetrics([one, two]);
    expect(m.prs.counted).toBe(1);
    expect(m.precision).toBe(0.5);
    expect(m.recall).toBe(0.5);
    expect(m.missedChanges).toEqual([{ pr: null, address: "aws_s3_bucket.logs" }]);
  });
});

describe("root modules in replies", () => {
  /** envs/prod flags the db; envs/staging was planned too but has no finding. */
  function multiRoot(): string {
    return renderReviewComment(
      [
        makeReview({ rootModuleDir: "envs/prod", findings: [dbFinding()] }),
        makeReview({ rootModuleDir: "envs/staging", findings: [] }),
      ],
      makeMeta(),
    );
  }

  it("parses root-qualified addresses", () => {
    expect(
      parseMissedAddresses(`missed: envs/staging:${DB}\nmissed: \`./envs/prod/:aws_s3_bucket.b\``),
    ).toEqual([`envs/staging:${DB}`, "./envs/prod/:aws_s3_bucket.b"]);
    // A colon inside an instance key is not a root qualifier.
    expect(parseMissedAddresses('missed: aws_s3_bucket.b["a:b"]')).toEqual(['aws_s3_bucket.b["a:b"]']);
  });

  it("a miss named in another root does not confirm this root's finding", () => {
    const fb = parseFeedback(multiRoot(), [{ body: `missed: envs/staging:${DB}` }]);
    expect(fb.findings.map((f) => f.confirmed)).toEqual([false]);
    expect(fb.missed).toEqual([`envs/staging:${DB}`]);
    const same = parseFeedback(multiRoot(), [{ body: `missed: ./envs/prod:${DB}` }]);
    expect(same.findings.map((f) => f.confirmed)).toEqual([true]);
    expect(same.missed).toEqual([]);
  });

  it("an unqualified flagged address in a multi-root comment counts neither way", () => {
    const fb = parseFeedback(multiRoot(), [{ body: `missed: ${DB} (envs/staging)` }]);
    expect(fb.findings.map((f) => f.confirmed)).toEqual([false]);
    expect(fb.missed).toEqual([]);
    expect(fb.hasFeedback).toBe(true);
    // Still a plain confirmation in a single-root comment.
    expect(parseFeedback(botComment(), [{ body: `missed: ${DB}` }]).findings[0]?.confirmed).toBe(true);
  });
});

describe("earlier findings", () => {
  it("counts findings an earlier run showed, with the tick they had, once", () => {
    const first = tick(botComment(), "f-3a9c1e07");
    const earlier = parseEarlierFindings(first);
    expect(earlier.map((f) => [f.id, f.confirmed])).toEqual([
      ["f-3a9c1e07", true],
      ["f-77b2d410", false],
    ]);
    // The next push fixes both: the comment shows nothing, the marker keeps both.
    const second = renderReviewComment([makeReview({ findings: [] })], makeMeta(), { earlier });
    const fb = parseFeedback(second, [{ body: `missed: ${SG}` }]);
    expect(fb.findings.map((f) => [f.address, f.confirmed, f.earlier])).toEqual([
      [DB, true, true],
      [SG, true, true],
    ]);
    expect(fb.hasFeedback).toBe(true);
    // A finding shown again is counted once, as the current one.
    const third = renderReviewComment([makeReview({ findings: [dbFinding()] })], makeMeta(), {
      earlier: parseEarlierFindings(second),
    });
    const again = parseFeedback(third, []);
    expect(again.findings.map((f) => [f.id, !!f.earlier])).toEqual([
      ["f-3a9c1e07", false],
      ["f-77b2d410", true],
    ]);
  });

  it("pools several sticky comments of one PR (one per plan set)", () => {
    const prod = tick(
      renderReviewComment([makeReview({ rootModuleDir: "envs/prod", findings: [dbFinding()] })], makeMeta()),
      checkboxId("f-3a9c1e07", "envs/prod"),
    );
    const staging = renderReviewComment(
      [makeReview({ rootModuleDir: "envs/staging", findings: [sgFinding()] })],
      makeMeta(),
    );
    const fb = parseFeedback([prod, staging], [{ body: "missed: envs/staging:aws_s3_bucket.x" }]);
    expect(fb.findings.map((f) => [f.root, f.confirmed])).toEqual([
      ["envs/prod", true],
      ["envs/staging", false],
    ]);
    expect(fb.missed).toEqual(["envs/staging:aws_s3_bucket.x"]);
  });
});

describe("missed: addresses with quoted instance keys", () => {
  it("accepts keys that hold ']' or escaped quotes", () => {
    expect(parseFeedback(null, [{ body: 'missed: module.svc["x]y"].aws_s3_bucket.b' }]).missed).toEqual([
      'module.svc["x]y"].aws_s3_bucket.b',
    ]);
    expect(parseFeedback(null, [{ body: 'missed: aws_s3_bucket.b["a\\"]b"]' }]).missed).toEqual([
      'aws_s3_bucket.b["a\\"]b"]',
    ]);
  });
});
