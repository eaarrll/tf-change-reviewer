import { describe, expect, it } from "vitest";
import { causePaths, collapsePath, pathsTo, topSteps } from "../../src/lineage/chain.js";
import type { Lineage, LineageStep } from "../../src/types.js";

const step = (id: string, parentId: string | undefined, line: number, changed = false): LineageStep => ({
  id,
  kind: "local",
  modulePath: [],
  label: id,
  references: [],
  changedInDiff: changed,
  location: { file: "main.tf", startLine: line, endLine: line },
  ...(parentId !== undefined && { parentId }),
});

describe("cause paths", () => {
  // s0 ← s1 ← {s2 (unchanged sibling), s3 (changed)};  s0 ← s4 (unchanged for_each)
  const lineage: Lineage = {
    address: "a",
    attribute: ["name"],
    steps: [
      step("s0", undefined, 1),
      step("s1", "s0", 2, true),
      step("s2", "s1", 3),
      step("s3", "s1", 4, true),
      step("s4", "s0", 5),
    ],
    rootCauseIds: ["s3", "s1"],
    explanation: "diff",
    notes: [],
  };

  it("keeps only the branch that reaches a root cause, ending at the deepest one", () => {
    expect(causePaths(lineage).map((p) => p.map((s) => s.id))).toEqual([["s0", "s1", "s3"]]);
    expect(topSteps(lineage).map((s) => s.id)).toEqual(["s0"]);
  });

  it("falls back to the trace order without parent links", () => {
    const flat = { ...lineage, steps: lineage.steps.map(({ parentId: _p, ...s }) => s) };
    expect(causePaths(flat)[0]?.map((s) => s.id)).toEqual(["s0", "s1", "s2", "s3"]);
  });

  it("drops a block whose changed line follows it on the path", () => {
    const block: LineageStep = {
      ...step("b", "s0", 1),
      location: { file: "iam.tf", startLine: 20, endLine: 30 },
    };
    const line: LineageStep = {
      ...step("l", "b", 1),
      location: { file: "iam.tf", startLine: 25, endLine: 25 },
    };
    expect(collapsePath([step("s0", undefined, 1), block, line]).map((s) => s.id)).toEqual(["s0", "l"]);
  });

  it("draws a branch for every attribute that reads a shared step", () => {
    // s0 ← s1 (local) ← s2 (changed tfvars); s3 also reads s1, s4 reads s2 directly.
    const shared: Lineage = {
      address: "a",
      attribute: ["x"],
      steps: [
        step("s0", undefined, 1),
        { ...step("s1", "s0", 2), alsoParentIds: ["s3"] },
        { ...step("s2", "s1", 3, true), alsoParentIds: ["s4"] },
        step("s3", undefined, 4),
        step("s4", undefined, 5),
      ],
      rootCauseIds: ["s2"],
      explanation: "diff",
      notes: [],
    };
    expect(causePaths(shared).map((p) => p.map((s) => s.id))).toEqual([
      ["s0", "s1", "s2"],
      ["s3", "s1", "s2"],
      ["s4", "s2"],
    ]);
    expect(pathsTo(shared, "s1").map((p) => p.map((s) => s.id))).toEqual([
      ["s0", "s1"],
      ["s3", "s1"],
    ]);
  });
});
