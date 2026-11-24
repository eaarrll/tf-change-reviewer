import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LabelsError,
  aggregate,
  explanationMatches,
  f1,
  gradeFixture,
  locationHits,
  parseLabels,
  ratio,
  severityDistance,
} from "../../evals/grade.js";
import type { FixtureGrade, Labels, MaterialLabel } from "../../evals/grade.js";
import type {
  CauseLink,
  Finding,
  Lineage,
  ResourceChange,
  Review,
  ScoredChange,
  Severity,
  SourceLocation,
} from "../../src/types.js";

const FIXTURE = fileURLToPath(new URL("../../evals/fixtures/db-encryption-replace/", import.meta.url));
const DB = "module.orders_db.aws_db_instance.this";
const BUCKET = "aws_s3_bucket.logs";
const LOGS = 'module.platform.aws_cloudwatch_log_group.service["api"]';

// ───────────────────────────── builders ─────────────────────────────

function link(
  file: string,
  startLine: number,
  endLine = startLine,
  extra: Partial<CauseLink> = {},
): CauseLink {
  const location: SourceLocation = { file, startLine, endLine };
  return { location, label: `${file}:${startLine}`, changedInDiff: true, ...extra };
}

function baseLink(file: string, line: number): CauseLink {
  return { location: { file, startLine: line, endLine: line, side: "base" }, label: "", changedInDiff: true };
}

function lineage(address: string, explanation: Lineage["explanation"]): Lineage {
  return { address, attribute: [], steps: [], rootCauseIds: [], explanation, notes: [] };
}

function finding(address: string, overrides: Partial<Finding> = {}): Finding {
  return {
    id: `id-${address}`,
    address,
    action: "replace",
    severity: "critical",
    title: `${address} changes`,
    impact: "impact",
    cause: "cause",
    causeLinks: [],
    signals: [],
    confidence: "high",
    origin: "rules",
    ...overrides,
  };
}

function other(address: string, severity: Severity): ScoredChange {
  const change = { address } as ResourceChange;
  return { change, severity, score: 1, signals: [] };
}

function review(findings: Finding[], others: ScoredChange[] = []): Review {
  return {
    rootModuleDir: "",
    findings,
    others,
    stats: { totalChanges: findings.length + others.length, counts: {}, bySeverity: {} },
    summary: "",
    warnings: [],
  };
}

function labels(material: Labels["material"], acceptable: string[] = []): Labels {
  return parseLabels({ material, acceptable });
}

const dbLabel: MaterialLabel = { address: DB, severity: "critical", cause: [{ file: "main.tf", line: 12 }] };

// ───────────────────────────── parseLabels ─────────────────────────────

describe("parseLabels", () => {
  it("accepts the real fixture's labels.json", () => {
    const parsed = parseLabels(JSON.parse(readFileSync(`${FIXTURE}labels.json`, "utf8")));
    expect(parsed.material.map((m) => m.address)).toEqual([DB]);
    expect(parsed.material[0]?.cause).toEqual([
      { file: "main.tf", line: 12 },
      { file: "main.tf", line: 18 },
    ]);
    // The PR's 30 -> 14 day log retention cuts are acceptable (evals/README.md: "a retention cut").
    expect(parsed.acceptable).toHaveLength(8);
    for (const address of parsed.acceptable ?? [])
      expect(address).toMatch(/^module\.platform\.aws_cloudwatch_log_group\.service\["[\w-]+"\]$/);
  });

  it("accepts the optional fields: side base, explanation, why, description, no acceptable", () => {
    const parsed = parseLabels({
      description: "d",
      material: [
        { address: DB, cause: [{ file: "a.tf", line: 3, side: "base" }], why: "w" },
        { address: BUCKET, cause: [], explanation: "external" },
      ],
    });
    expect(parsed.material[0]?.cause?.[0]?.side).toBe("base");
    expect(parsed.material[1]?.explanation).toBe("external");
    expect(parsed.acceptable).toBeUndefined();
  });

  it.each([
    ["no material", { acceptable: [] }],
    ["material not an array", { material: {} }],
    ["empty address", { material: [{ address: "" }] }],
    ["line 0", { material: [{ address: DB, cause: [{ file: "main.tf", line: 0 }] }] }],
    ["fractional line", { material: [{ address: DB, cause: [{ file: "main.tf", line: 1.5 }] }] }],
    ["side head", { material: [{ address: DB, cause: [{ file: "main.tf", line: 1, side: "head" }] }] }],
    ["unknown severity", { material: [{ address: DB, severity: "urgent" }] }],
    ["unknown explanation", { material: [{ address: DB, explanation: "drift" }] }],
    ["not an object", "labels"],
    ["null", null],
  ])("rejects %s", (_, json) => {
    expect(() => parseLabels(json)).toThrow(LabelsError);
  });

  it("rejects duplicates and overlaps, listing every problem", () => {
    let message = "";
    try {
      parseLabels({ material: [{ address: DB }, { address: DB }], acceptable: [DB, BUCKET, BUCKET] });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(`material address ${DB} is listed twice`);
    expect(message).toContain(`${DB} is both material and acceptable`);
    expect(message).toContain(`acceptable address ${BUCKET} is listed twice`);
  });

  it("names the path of a schema problem", () => {
    expect(() => parseLabels({ material: [{ address: DB, cause: [{ file: "x", line: -1 }] }] })).toThrow(
      /material\.0\.cause\.0\.line/,
    );
  });
});

// ───────────────────────────── confusion matrix ─────────────────────────────

describe("gradeFixture: TP / FP / FN / acceptable", () => {
  it("scores a perfect review", () => {
    const g = gradeFixture(review([finding(DB, { causeLinks: [link("main.tf", 12)] })]), labels([dbLabel]));
    expect(g.tp.map((t) => t.address)).toEqual([DB]);
    expect(g).toMatchObject({ fp: [], fn: [], acceptableFlagged: [], precision: 1, recall: 1, f1: 1 });
    expect(g).toMatchObject({ flagged: 1, material: 1, traceJudged: 1, traced: 1 });
  });

  it("splits flagged into TP, FP and acceptable, and lists FN", () => {
    const g = gradeFixture(
      review([finding(DB), finding(BUCKET), finding(LOGS), finding("aws_iam_role.x")]),
      labels([dbLabel, { address: "aws_kms_key.main" }], [LOGS]),
    );
    expect(g.tp.map((t) => t.address)).toEqual([DB]);
    expect(g.fp).toEqual([BUCKET, "aws_iam_role.x"]);
    expect(g.acceptableFlagged).toEqual([LOGS]);
    expect(g.fn).toEqual(["aws_kms_key.main"]);
    expect(g.precision).toBeCloseTo(1 / 3);
    expect(g.recall).toBe(0.5);
    expect(g.f1).toBeCloseTo(0.4);
    expect(g.flagged).toBe(4);
  });

  it("does not penalize or credit an acceptable flag", () => {
    const g = gradeFixture(review([finding(DB), finding(LOGS)]), labels([dbLabel], [LOGS]));
    expect(g.precision).toBe(1);
    expect(g.recall).toBe(1);
  });

  it("an acceptable address that is not flagged is not a miss", () => {
    const g = gradeFixture(review([finding(DB)]), labels([dbLabel], [LOGS]));
    expect(g.fn).toEqual([]);
    expect(g.acceptableFlagged).toEqual([]);
  });

  it("matches addresses exactly: module prefix and instance keys matter", () => {
    const g = gradeFixture(
      review([
        finding("aws_db_instance.this"),
        finding('module.platform.aws_cloudwatch_log_group.service["API"]'),
      ]),
      labels([dbLabel, { address: LOGS }]),
    );
    expect(g.tp).toEqual([]);
    expect(g.fp).toHaveLength(2);
    expect(g.fn).toEqual([DB, LOGS]);
  });

  it("only findings count as flagged: a material change in others is a miss, reported with its severity", () => {
    const g = gradeFixture(
      review([], [other(DB, "medium"), other(BUCKET, "low")]),
      labels([dbLabel, { address: "aws_kms_key.main" }]),
    );
    expect(g.fn).toEqual([DB, "aws_kms_key.main"]);
    expect(g.fnInOthers).toEqual({ [DB]: "medium" });
    expect(g.fp).toEqual([]);
  });

  it("precision is null when nothing was flagged, and F1 is 0 when material was missed", () => {
    const g = gradeFixture(review([]), labels([dbLabel]));
    expect(g.precision).toBeNull();
    expect(g.recall).toBe(0);
    expect(g.f1).toBe(0);
  });

  it("recall is null on a fixture with no material changes", () => {
    const quiet = gradeFixture(review([]), labels([]));
    expect(quiet).toMatchObject({ precision: null, recall: null, f1: null, fp: [], fn: [] });
    const noisy = gradeFixture(review([finding(BUCKET)]), labels([]));
    expect(noisy).toMatchObject({ precision: 0, recall: null, f1: 0, fp: [BUCKET] });
  });

  it("only acceptable flags: precision stays null", () => {
    const g = gradeFixture(review([finding(LOGS)]), labels([], [LOGS]));
    expect(g.precision).toBeNull();
    expect(g.acceptableFlagged).toEqual([LOGS]);
  });

  it("counts a duplicated finding once and grades the first (highest-ranked) one", () => {
    const g = gradeFixture(
      review([
        finding(DB, { causeLinks: [] }),
        finding(BUCKET),
        finding(DB, { causeLinks: [link("main.tf", 12)] }),
        finding(BUCKET),
      ]),
      labels([dbLabel]),
    );
    expect(g.tp).toHaveLength(1);
    expect(g.tp[0]?.trace).toBe("missed");
    expect(g.fp).toEqual([BUCKET]);
    expect(g.duplicateFindings).toEqual([DB, BUCKET]);
    expect(g.flagged).toBe(2);
  });
});

// ───────────────────────────── trace accuracy ─────────────────────────────

describe("gradeFixture: trace", () => {
  const traceOf = (f: Finding, label: Labels["material"][number] = dbLabel): FixtureGrade["tp"][number] => {
    const t = gradeFixture(review([f]), labels([label])).tp[0];
    if (t === undefined) throw new Error("expected a TP");
    return t;
  };

  it("a cause link whose span covers the labeled line traces it (inclusive bounds)", () => {
    expect(traceOf(finding(DB, { causeLinks: [link("main.tf", 10, 12)] }))).toMatchObject({
      trace: "traced",
      tracedBy: "line",
    });
    expect(traceOf(finding(DB, { causeLinks: [link("main.tf", 12, 20)] })).trace).toBe("traced");
  });

  it("a span next to the labeled line does not", () => {
    expect(traceOf(finding(DB, { causeLinks: [link("main.tf", 13, 20)] })).trace).toBe("missed");
    expect(traceOf(finding(DB, { causeLinks: [link("main.tf", 1, 11)] })).trace).toBe("missed");
  });

  it("the right line in another file does not", () => {
    expect(traceOf(finding(DB, { causeLinks: [link("modules/db/main.tf", 12)] })).trace).toBe("missed");
  });

  it("any one labeled cause line is enough, and any one link may hit it", () => {
    const label = {
      address: DB,
      cause: [
        { file: "main.tf", line: 12 },
        { file: "main.tf", line: 18 },
      ],
    };
    const f = finding(DB, { causeLinks: [link("modules/db/main.tf", 24), link("main.tf", 16, 19)] });
    expect(traceOf(f, label).trace).toBe("traced");
  });

  it("normalizes paths: ./ prefixes and backslashes", () => {
    expect(traceOf(finding(DB, { causeLinks: [link("./main.tf", 12)] })).trace).toBe("traced");
    const label = { address: DB, cause: [{ file: "./modules/db/main.tf", line: 4 }] };
    expect(traceOf(finding(DB, { causeLinks: [link("modules\\db\\main.tf", 4)] }), label).trace).toBe(
      "traced",
    );
  });

  it("sides must agree: a base-side label needs a base-side link with the old line number", () => {
    const label = { address: DB, cause: [{ file: "main.tf", line: 12, side: "base" as const }] };
    expect(traceOf(finding(DB, { causeLinks: [link("main.tf", 12)] }), label).trace).toBe("missed");
    expect(traceOf(finding(DB, { causeLinks: [baseLink("main.tf", 12)] }), label).trace).toBe("traced");
    expect(traceOf(finding(DB, { causeLinks: [baseLink("main.tf", 12)] })).trace).toBe("missed");
  });

  it("a label with no cause lines and no explanation is not judged", () => {
    const t = traceOf(finding(DB), { address: DB });
    expect(t.trace).toBe("unlabeled");
    const g = gradeFixture(review([finding(DB)]), labels([{ address: DB, cause: [] }]));
    expect(g).toMatchObject({ traceJudged: 0, traced: 0 });
  });

  it("explanation external: the finding's lineage must say external", () => {
    const label = { address: DB, cause: [], explanation: "external" as const };
    expect(traceOf(finding(DB, { lineage: lineage(DB, "external") }), label)).toMatchObject({
      trace: "traced",
      tracedBy: "explanation",
    });
    expect(traceOf(finding(DB, { lineage: lineage(DB, "diff") }), label).trace).toBe("missed");
    expect(traceOf(finding(DB, { lineage: lineage(DB, "unknown") }), label).trace).toBe("missed");
  });

  it("a lineage wins over the cause text", () => {
    const label = { address: DB, cause: [], explanation: "external" as const };
    const f = finding(DB, { lineage: lineage(DB, "diff"), cause: "Not caused by this PR: drift." });
    expect(traceOf(f, label).trace).toBe("missed");
  });

  it.each([
    "This replacement is not caused by your PR; the provider upgrade changed the default.",
    "Not from the diff: the value comes from a -var in CI.",
    "The tfvars file lives outside the repository.",
    "No line in this PR explains it.",
    "Drift: someone changed the instance in the console.",
  ])("without a lineage, cause text %j explains an external label", (cause) => {
    const label = { address: DB, cause: [], explanation: "external" as const };
    expect(traceOf(finding(DB, { cause, origin: "agent" }), label).trace).toBe("traced");
  });

  it("without a lineage, a changed-line link or plain cause text does not explain an external label", () => {
    const label = { address: DB, cause: [], explanation: "external" as const };
    const changed = finding(DB, { cause: "not caused by this PR", causeLinks: [link("main.tf", 3)] });
    expect(traceOf(changed, label).trace).toBe("missed");
    const unchangedLink = finding(DB, {
      cause: "not caused by this PR",
      causeLinks: [link("main.tf", 3, 3, { changedInDiff: false })],
    });
    expect(traceOf(unchangedLink, label).trace).toBe("traced");
    expect(traceOf(finding(DB, { cause: "main.tf:12 sets encrypted = false" }), label).trace).toBe("missed");
  });

  it("only external labels fall back to cause text", () => {
    const label = { address: DB, cause: [], explanation: "upstream" as const };
    expect(traceOf(finding(DB, { cause: "not caused by this PR" }), label).trace).toBe("missed");
    expect(traceOf(finding(DB, { lineage: lineage(DB, "upstream") }), label).trace).toBe("traced");
  });

  it("a label with both cause lines and an explanation accepts either", () => {
    const label = { address: DB, cause: [{ file: "main.tf", line: 12 }], explanation: "upstream" as const };
    expect(traceOf(finding(DB, { causeLinks: [link("main.tf", 12)] }), label).tracedBy).toBe("line");
    expect(traceOf(finding(DB, { lineage: lineage(DB, "upstream") }), label).tracedBy).toBe("explanation");
    expect(traceOf(finding(DB, { lineage: lineage(DB, "diff") }), label).trace).toBe("missed");
  });

  it("only TP are traced: FP cause links are ignored", () => {
    const g = gradeFixture(
      review([finding(BUCKET, { causeLinks: [link("main.tf", 12)] }), finding(DB)]),
      labels([dbLabel]),
    );
    expect(g).toMatchObject({ traceJudged: 1, traced: 0 });
  });
});

describe("locationHits / explanationMatches", () => {
  it("treats a missing side as head", () => {
    expect(locationHits({ file: "a.tf", startLine: 1, endLine: 1 }, { file: "a.tf", line: 1 })).toBe(true);
    expect(
      locationHits({ file: "a.tf", startLine: 1, endLine: 1, side: "base" }, { file: "a.tf", line: 1 }),
    ).toBe(false);
  });

  it("does not match a file whose name merely ends the same way", () => {
    expect(locationHits({ file: "x/main.tf", startLine: 1, endLine: 9 }, { file: "main.tf", line: 2 })).toBe(
      false,
    );
  });

  it("explanationMatches compares lineage explanations exactly", () => {
    expect(explanationMatches(finding(DB, { lineage: lineage(DB, "diff") }), "diff")).toBe(true);
    expect(explanationMatches(finding(DB), "diff")).toBe(false);
  });
});

// ───────────────────────────── severity ─────────────────────────────

describe("severity agreement", () => {
  it("records the distance between the labeled and the reported severity", () => {
    const g = gradeFixture(
      review([
        finding(DB, { severity: "critical" }),
        finding(BUCKET, { severity: "high" }),
        finding(LOGS, { severity: "medium" }),
        finding("aws_kms_key.main", { severity: "high" }),
      ]),
      labels([
        { address: DB, severity: "critical" },
        { address: BUCKET, severity: "critical" },
        { address: LOGS, severity: "critical" },
        { address: "aws_kms_key.main" },
      ]),
    );
    expect(g.tp.map((t) => t.severityDistance)).toEqual([0, 1, 2, null]);
    expect(g.tp[1]).toMatchObject({ labeledSeverity: "critical", severity: "high" });
    expect(g.tp[3]?.labeledSeverity).toBeNull();
  });

  it("severityDistance follows SEVERITY_ORDER and is symmetric", () => {
    expect(severityDistance("critical", "noise")).toBe(4);
    expect(severityDistance("low", "high")).toBe(2);
    expect(severityDistance("medium", "medium")).toBe(0);
  });
});

// ───────────────────────────── aggregate ─────────────────────────────

describe("aggregate", () => {
  it("micro-averages over fixtures", () => {
    const a = gradeFixture(
      review([finding(DB, { causeLinks: [link("main.tf", 12)] }), finding(BUCKET)]),
      labels([dbLabel]),
    );
    const b = gradeFixture(
      review([finding(LOGS, { severity: "high" })]),
      labels([
        { address: LOGS, severity: "medium", cause: [{ file: "x.tf", line: 1 }] },
        { address: "aws_kms_key.main" },
        { address: "aws_iam_role.r" },
      ]),
    );
    const c = gradeFixture(review([]), labels([]));
    const s = aggregate([a, b, c]);
    expect(s).toMatchObject({ fixtures: 3, tp: 2, fp: 1, fn: 2, acceptableFlagged: 0, perfect: 1 });
    expect(s.precision).toBeCloseTo(2 / 3);
    expect(s.recall).toBe(0.5);
    expect(s.f1).toBeCloseTo((2 * (2 / 3) * 0.5) / (2 / 3 + 0.5));
    expect(s.trace).toEqual({ judged: 2, traced: 1, accuracy: 0.5 });
    expect(s.severity).toEqual({ compared: 2, exact: 1, offByOne: 1, worse: 0 });
  });

  it("returns nulls for an empty run", () => {
    expect(aggregate([])).toMatchObject({
      fixtures: 0,
      precision: null,
      recall: null,
      f1: null,
      perfect: 0,
      trace: { judged: 0, traced: 0, accuracy: null },
      severity: { compared: 0, exact: 0, offByOne: 0, worse: 0 },
    });
  });

  it("counts acceptable flags and far-off severities", () => {
    const g = gradeFixture(
      review([finding(DB, { severity: "medium" }), finding(LOGS)]),
      labels([{ address: DB, severity: "critical" }], [LOGS]),
    );
    const s = aggregate([g, g]);
    expect(s.acceptableFlagged).toBe(2);
    expect(s.severity).toEqual({ compared: 2, exact: 0, offByOne: 0, worse: 2 });
    expect(s.trace.accuracy).toBeNull();
  });
});

describe("ratio / f1", () => {
  it("ratio is null only for 0/0", () => {
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(0, 3)).toBe(0);
    expect(ratio(3, 4)).toBe(0.75);
  });

  it("f1", () => {
    expect(f1(1, 1)).toBe(1);
    expect(f1(0.5, 1)).toBeCloseTo(2 / 3);
    expect(f1(0, 0)).toBe(0);
    expect(f1(null, 0)).toBe(0);
    expect(f1(0, null)).toBe(0);
    expect(f1(null, 1)).toBeNull();
    expect(f1(null, null)).toBeNull();
  });
});

describe("the real db-encryption-replace fixture", () => {
  const real = parseLabels(JSON.parse(readFileSync(`${FIXTURE}labels.json`, "utf8")));

  it("a review that links the changed module argument is perfect", () => {
    const g = gradeFixture(
      review(
        [
          finding(DB, {
            causeLinks: [link("modules/db/main.tf", 24), link("main.tf", 12)],
            lineage: lineage(DB, "diff"),
          }),
        ],
        [other(LOGS, "low"), other("aws_s3_bucket.orders", "noise")],
      ),
      real,
    );
    expect(g).toMatchObject({ fp: [], fn: [], precision: 1, recall: 1, traced: 1, traceJudged: 1 });
  });

  it("the variable default line alone also counts as the cause", () => {
    const g = gradeFixture(review([finding(DB, { causeLinks: [link("main.tf", 15, 19)] })]), real);
    expect(g.traced).toBe(1);
  });

  it("flagging the tag and retention noise instead is two FP and a miss", () => {
    const g = gradeFixture(
      review([finding(LOGS), finding("aws_s3_bucket.orders")], [other(DB, "high")]),
      real,
    );
    expect(g).toMatchObject({ precision: 0, recall: 0, f1: 0, fnInOthers: { [DB]: "high" } });
  });
});

// ───────────────────────────── grouped findings + sets ─────────────────────────────

describe("findings that stand for several changes (relatedAddresses)", () => {
  const A = "aws_s3_bucket.data[0]";
  const B = "aws_s3_bucket.data[1]";
  const C = "aws_s3_bucket.data[2]";

  it("flags the related addresses too, sharing the representative's trace", () => {
    const grade = gradeFixture(
      review([finding(A, { relatedAddresses: [B, C], causeLinks: [link("terraform.tfvars", 2)] })]),
      labels(
        [
          { address: A, cause: [{ file: "terraform.tfvars", line: 2 }] },
          { address: B, cause: [{ file: "terraform.tfvars", line: 2 }] },
        ],
        [C],
      ),
    );
    expect(grade.tp.map((t) => [t.address, t.trace])).toEqual([
      [A, "traced"],
      [B, "traced"],
    ]);
    expect(grade.acceptableFlagged).toEqual([C]);
    expect(grade.flagged).toBe(3);
    expect(grade.fp).toEqual([]);
    expect(grade.fn).toEqual([]);
  });

  it("counts an address listed by two findings once, as a duplicate", () => {
    const grade = gradeFixture(
      review([finding(A, { relatedAddresses: [B] }), finding(B)]),
      labels([{ address: A }, { address: B }]),
    );
    expect(grade.tp).toHaveLength(2);
    expect(grade.duplicateFindings).toEqual([B]);
  });
});

describe("label sets", () => {
  it("accepts set: dev | holdout and defaults to dev", async () => {
    const { fixtureSet } = await import("../../evals/grade.js");
    expect(fixtureSet(parseLabels({ material: [] }))).toBe("dev");
    expect(fixtureSet(parseLabels({ set: "holdout", material: [] }))).toBe("holdout");
    expect(() => parseLabels({ set: "train", material: [] })).toThrow(LabelsError);
  });

  it("with a fixture name, the ho- prefix decides, and a set field that disagrees is an error", async () => {
    const { fixtureSet, setOfName } = await import("../../evals/grade.js");
    expect(setOfName("ho-anything")).toBe("holdout");
    expect(setOfName("hot-path")).toBe("dev");
    expect(fixtureSet(parseLabels({ material: [] }), "ho-x")).toBe("holdout");
    expect(fixtureSet(parseLabels({ set: "holdout", material: [] }), "ho-x")).toBe("holdout");
    expect(fixtureSet(parseLabels({ material: [] }), "x")).toBe("dev");
    expect(() => fixtureSet(parseLabels({ set: "dev", material: [] }), "ho-x")).toThrow(LabelsError);
    expect(() => fixtureSet(parseLabels({ set: "holdout", material: [] }), "x")).toThrow(/does not start/);
  });
});

describe("cause lines", () => {
  const labels: Labels = parseLabels({
    material: [
      {
        address: DB,
        cause: [
          { file: "terraform.tfvars", line: 12 },
          { file: "terraform.tfvars", line: 13 },
          { file: "terraform.tfvars", line: 14 },
        ],
      },
    ],
  });

  it("counts the labeled lines a changed-line cause link covers, and ignores unchanged links", () => {
    const g = gradeFixture(
      review([
        finding(DB, {
          causeLinks: [
            link("terraform.tfvars", 12),
            link("terraform.tfvars", 13, 13, { changedInDiff: false }),
            link("main.tf", 4),
          ],
        }),
      ]),
      labels,
    );
    expect(g.causeLines).toEqual({ labeled: 3, covered: 1 });
    expect(g.tp[0]?.trace).toBe("traced");
    expect(aggregate([g]).causeLineRecall).toEqual({ labeled: 3, covered: 1, recall: 1 / 3 });
  });

  it("one link covers at most one labeled line: a block-wide span does not stand for every cause inside it", () => {
    const block = parseLabels({
      material: [
        {
          address: DB,
          cause: [
            { file: "kms.tf", line: 1, side: "base" },
            { file: "kms.tf", line: 3, side: "base" },
          ],
        },
      ],
    });
    const wide = {
      location: { file: "kms.tf", startLine: 1, endLine: 5, side: "base" as const },
      label: "",
      changedInDiff: true,
    };
    const one = gradeFixture(review([finding(DB, { causeLinks: [wide] })]), block);
    expect(one.causeLines).toEqual({ labeled: 2, covered: 1 });
    expect(one.tp[0]?.trace).toBe("traced");
    const two = gradeFixture(review([finding(DB, { causeLinks: [wide, baseLink("kms.tf", 3)] })]), block);
    expect(two.causeLines).toEqual({ labeled: 2, covered: 2 });
    expect(
      gradeFixture(review([finding(DB, { causeLinks: [link("terraform.tfvars", 1, 999)] })]), labels)
        .causeLines,
    ).toEqual({ labeled: 3, covered: 1 });
  });

  it("matches links to labeled lines so the most lines are covered (not first come, first served)", () => {
    // The wide link could take line 12, but only it reaches line 14; the narrow one takes 12.
    const g = gradeFixture(
      review([finding(DB, { causeLinks: [link("terraform.tfvars", 12, 14), link("terraform.tfvars", 12)] })]),
      labels,
    );
    expect(g.causeLines).toEqual({ labeled: 3, covered: 2 });
  });

  it("does not count a link to the resource's own unchanged line as a traced cause", () => {
    const own = parseLabels({ material: [{ address: DB, cause: [{ file: "main.tf", line: 4 }] }] });
    const g = gradeFixture(
      review([finding(DB, { causeLinks: [link("main.tf", 4, 4, { changedInDiff: false })] })]),
      own,
    );
    expect(g.tp[0]?.trace).toBe("missed");
  });
});

describe("link precision", () => {
  const lineLabel = labels([{ address: DB, cause: [{ file: "main.tf", line: 12 }] }]);
  const external = labels([{ address: DB, cause: [], explanation: "external" }]);

  it("counts changed-line links that hit no labeled cause line; unchanged links are not judged", () => {
    const f = finding(DB, {
      causeLinks: [
        link("main.tf", 12),
        link("main.tf", 30),
        link("modules/db/main.tf", 4, 4, { changedInDiff: false }),
      ],
    });
    const g = gradeFixture(review([f]), lineLabel);
    expect(g.tp[0]?.links).toEqual({ changed: 2, stray: 1 });
    expect(aggregate([g]).linkPrecision).toEqual({ changed: 2, stray: 1, precision: 0.5 });
  });

  it("every changed-line link is stray on a change the label says the PR does not explain", () => {
    const g = gradeFixture(
      review([finding(DB, { causeLinks: [link("terraform.tfvars", 23)], lineage: lineage(DB, "external") })]),
      external,
    );
    expect(g.tp[0]?.links).toEqual({ changed: 1, stray: 1 });
  });

  it("is not judged without cause lines or an external explanation", () => {
    const g = gradeFixture(
      review([finding(DB, { causeLinks: [link("main.tf", 3)] })]),
      labels([{ address: DB }]),
    );
    expect(g.tp[0]?.links).toBeNull();
    expect(aggregate([g]).linkPrecision).toEqual({ changed: 0, stray: 0, precision: null });
  });
});

describe("agent citations (agentCauseLinks), graded apart from the merged lineage", () => {
  type AgentFinding = Finding & { agentCauseLinks?: CauseLink[] };
  const agentFinding = (overrides: Partial<AgentFinding>): Finding =>
    ({ ...finding(DB, { origin: "both" }), ...overrides }) as Finding;
  const external = labels([{ address: DB, cause: [], explanation: "external" }]);

  it("a wrong agent citation on an external change is missed although the merged trace is traced", () => {
    // The deterministic lineage says external and is attached to every finding; the agent claims a tfvars line.
    const f = agentFinding({
      lineage: lineage(DB, "external"),
      agentCauseLinks: [link("terraform.tfvars", 23)],
    });
    const g = gradeFixture(review([f]), external);
    expect(g.tp[0]).toMatchObject({ trace: "traced", tracedBy: "explanation" });
    expect(g.tp[0]?.agent).toEqual({ trace: "missed", links: { changed: 1, stray: 1 } });
    expect(aggregate([g]).agentTrace).toEqual({
      judged: 1,
      traced: 0,
      accuracy: 0,
      links: { changed: 1, stray: 1, precision: 0 },
    });
  });

  it("an agent that cites no changed line on an external change is traced", () => {
    const unchanged = link("modules/db/main.tf", 9, 9, { changedInDiff: false });
    const g = gradeFixture(review([agentFinding({ agentCauseLinks: [unchanged] })]), external);
    expect(g.tp[0]?.agent).toEqual({ trace: "traced", links: { changed: 0, stray: 0 } });
    expect(gradeFixture(review([agentFinding({ agentCauseLinks: [] })]), external).tp[0]?.agent?.trace).toBe(
      "traced",
    );
  });

  it("on a line label, the rule links do not carry a wrong agent citation", () => {
    const f = agentFinding({
      causeLinks: [link("main.tf", 12), link("main.tf", 40)],
      agentCauseLinks: [link("main.tf", 40)],
    });
    const g = gradeFixture(review([f]), labels([dbLabel]));
    expect(g.tp[0]?.trace).toBe("traced");
    expect(g.tp[0]?.agent).toEqual({ trace: "missed", links: { changed: 1, stray: 1 } });
    const right = agentFinding({ causeLinks: [link("main.tf", 12)], agentCauseLinks: [link("main.tf", 12)] });
    expect(gradeFixture(review([right]), labels([dbLabel])).tp[0]?.agent).toEqual({
      trace: "traced",
      links: { changed: 1, stray: 0 },
    });
  });

  it("a label with both cause lines and an external explanation accepts either citation", () => {
    const either = labels([{ address: DB, cause: [{ file: "main.tf", line: 12 }], explanation: "external" }]);
    expect(
      gradeFixture(review([agentFinding({ agentCauseLinks: [link("main.tf", 12)] })]), either).tp[0]?.agent
        ?.trace,
    ).toBe("traced");
    expect(gradeFixture(review([agentFinding({ agentCauseLinks: [] })]), either).tp[0]?.agent?.trace).toBe(
      "traced",
    );
    expect(
      gradeFixture(review([agentFinding({ agentCauseLinks: [link("main.tf", 2)] })]), either).tp[0]?.agent
        ?.trace,
    ).toBe("missed");
  });

  it("is not judged without cause lines or an external explanation, and absent on rule-only findings", () => {
    const upstream = labels([{ address: DB, cause: [], explanation: "upstream" }]);
    expect(
      gradeFixture(review([agentFinding({ agentCauseLinks: [link("main.tf", 2)] })]), upstream).tp[0]?.agent,
    ).toEqual({
      trace: "unlabeled",
      links: null,
    });
    const rules = gradeFixture(
      review([finding(DB, { causeLinks: [link("main.tf", 12)] })]),
      labels([dbLabel]),
    );
    expect(rules.tp[0]?.agent).toBeUndefined();
    expect(aggregate([rules]).agentTrace).toEqual({
      judged: 0,
      traced: 0,
      accuracy: null,
      links: { changed: 0, stray: 0, precision: null },
    });
  });
});

describe("related addresses", () => {
  it("are graded with the severity they were grouped with, not the representative's", () => {
    const labels = parseLabels({
      material: [
        { address: DB, severity: "critical" },
        { address: BUCKET, severity: "high" },
      ],
    });
    const g = gradeFixture(
      review([
        finding(DB, {
          relatedAddresses: [BUCKET],
          relatedChanges: [{ address: BUCKET, action: "replace", severity: "high" }],
        }),
      ]),
      labels,
    );
    expect(g.tp.map((t) => [t.address, t.severity, t.severityDistance])).toEqual([
      [DB, "critical", 0],
      [BUCKET, "high", 0],
    ]);
  });
});
