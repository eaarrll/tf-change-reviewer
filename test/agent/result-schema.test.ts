import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  MAX_TITLE_CHARS,
  VERDICT_OUTPUT_FORMAT,
  VerdictSchema,
  parseVerdict,
  toVerdict,
  type WireVerdict,
} from "../../src/agent/result-schema.js";

const WIRE: WireVerdict = {
  summary: " The PR replaces the orders database. ",
  findings: [
    {
      address: " module.orders_db.aws_db_instance.this ",
      severity: "critical",
      title: "orders-prod is destroyed and re-created",
      impact: "Data loss.",
      cause: "storage_encrypted = false in terraform.tfvars.",
      cause_refs: [{ file: "terraform.tfvars", line: 1 }],
      confidence: "high",
    },
  ],
  dismissed: [{ address: "aws_s3_bucket.logs", reason: "Tags only." }],
};

describe("parseVerdict", () => {
  it("maps the wire format to the camelCase contract and trims text", () => {
    expect(parseVerdict(JSON.stringify(WIRE))).toEqual({
      summary: "The PR replaces the orders database.",
      findings: [
        {
          address: "module.orders_db.aws_db_instance.this",
          severity: "critical",
          title: "orders-prod is destroyed and re-created",
          impact: "Data loss.",
          cause: "storage_encrypted = false in terraform.tfvars.",
          causeRefs: [{ file: "terraform.tfvars", line: 1 }],
          confidence: "high",
        },
      ],
      dismissed: [{ address: "aws_s3_bucket.logs", reason: "Tags only." }],
    });
  });

  it("accepts an empty verdict", () => {
    expect(parseVerdict('{"summary":"Nothing material.","findings":[],"dismissed":[]}')).toEqual({
      summary: "Nothing material.",
      findings: [],
      dismissed: [],
    });
  });

  it.each([
    ["a code fence", "```json\n" + JSON.stringify(WIRE) + "\n```"],
    ["leading prose", "Here is the verdict:\n" + JSON.stringify(WIRE)],
    ["trailing prose", JSON.stringify(WIRE) + "\nDone."],
  ])("tolerates %s", (_, text) => {
    expect(parseVerdict(text)?.findings).toHaveLength(1);
  });

  it.each([
    ["plain text", "The database is replaced."],
    ["empty text", ""],
    ["a cut-off object", JSON.stringify(WIRE).slice(0, 80)],
    ["a missing field", JSON.stringify({ summary: "x", findings: [] })],
    ["a wrong severity", JSON.stringify({ ...WIRE, findings: [{ ...WIRE.findings[0], severity: "low" }] })],
    [
      "a wrong confidence",
      JSON.stringify({ ...WIRE, findings: [{ ...WIRE.findings[0], confidence: "certain" }] }),
    ],
    [
      "a fractional line",
      JSON.stringify({
        ...WIRE,
        findings: [{ ...WIRE.findings[0], cause_refs: [{ file: "a.tf", line: 1.5 }] }],
      }),
    ],
    [
      "camelCase refs",
      JSON.stringify({ ...WIRE, findings: [{ ...WIRE.findings[0], cause_refs: undefined, causeRefs: [] }] }),
    ],
    ["an array", "[]"],
  ])("rejects %s", (_, text) => {
    expect(parseVerdict(text)).toBeNull();
  });
});

describe("toVerdict", () => {
  it("clips long titles on a code point boundary", () => {
    const title = `${"t".repeat(MAX_TITLE_CHARS - 2)}\u{1F680}\u{1F680}\u{1F680}`;
    const verdict = toVerdict({ ...WIRE, findings: [{ ...WIRE.findings[0]!, title }] });

    const clipped = verdict.findings[0]!.title;
    expect(Array.from(clipped)).toHaveLength(MAX_TITLE_CHARS);
    expect(clipped.endsWith("…")).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(clipped)).toBe(false);
  });

  it("keeps a title of exactly the limit", () => {
    const title = "x".repeat(MAX_TITLE_CHARS);
    expect(toVerdict({ ...WIRE, findings: [{ ...WIRE.findings[0]!, title }] }).findings[0]?.title).toBe(
      title,
    );
  });

  it("cleans cause refs: separators, embedded line numbers, bad lines and duplicates", () => {
    const verdict = toVerdict({
      ...WIRE,
      findings: [
        {
          ...WIRE.findings[0]!,
          cause_refs: [
            { file: "./modules\\db\\main.tf", line: 4 },
            { file: "modules/db/main.tf", line: 4 },
            { file: "/main.tf:12", line: 0 },
            { file: "main.tf:7-9", line: 8 },
            { file: "variables.tf", line: 0 },
            { file: "variables.tf", line: -3 },
            { file: "  ", line: 2 },
          ],
        },
      ],
    });

    expect(verdict.findings[0]?.causeRefs).toEqual([
      { file: "modules/db/main.tf", line: 4 },
      { file: "main.tf", line: 12 },
      { file: "main.tf", line: 8 },
    ]);
  });

  it("drops duplicate findings, empty addresses, and dismissals of flagged changes", () => {
    const finding = WIRE.findings[0]!;
    const verdict = toVerdict({
      summary: "s",
      findings: [finding, { ...finding, title: "duplicate" }, { ...finding, address: " " }],
      dismissed: [
        { address: finding.address.trim(), reason: "contradicts the finding" },
        { address: "aws_x.y", reason: "first" },
        { address: "aws_x.y", reason: "second" },
        { address: "", reason: "empty" },
      ],
    });

    expect(verdict.findings.map((f) => f.title)).toEqual([finding.title]);
    expect(verdict.dismissed).toEqual([{ address: "aws_x.y", reason: "first" }]);
  });
});

describe("VERDICT_OUTPUT_FORMAT", () => {
  it("is a JSON schema the structured-output API accepts: no length or count limits", () => {
    expect(VERDICT_OUTPUT_FORMAT.type).toBe("json_schema");
    const schema = JSON.stringify(VERDICT_OUTPUT_FORMAT.schema);
    for (const unsupported of ["minLength", "maxLength", "minItems", "maxItems", "maximum", "minimum"]) {
      expect(schema).not.toContain(unsupported);
    }
    expect(schema).toContain('"cause_refs"');
    expect(schema).toContain('"enum":["critical","high","medium"]');
  });

  it("matches the zod schema", () => {
    expect(z.toJSONSchema(VerdictSchema)).toMatchObject({
      type: "object",
      required: ["summary", "findings", "dismissed"],
    });
  });
});
