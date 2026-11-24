/*
 * Rules against the real provider plans in evals/fixtures (see evals/README.md): every labeled
 * material change must score high or critical, and a fixture with no material changes (the
 * noise-only precision test) must have nothing high or critical outside its "acceptable" list.
 * Fixtures without plan.json + labels.json are skipped, as is the suite when plan/load.ts is absent.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scorePlan } from "../../src/risk/score.js";
import type { PlanModel } from "../../src/types.js";

const FIXTURES = new URL("../../evals/fixtures/", import.meta.url);

interface Labels {
  material: { address: string; severity?: string }[];
  acceptable?: string[];
}

const names = existsSync(FIXTURES)
  ? readdirSync(FIXTURES)
      .filter(
        (n) =>
          // ho-* fixtures are the blind held-out set: never assert (or tune) rules against their labels.
          !n.startsWith("ho-") &&
          existsSync(new URL(`${n}/plan.json`, FIXTURES)) &&
          existsSync(new URL(`${n}/labels.json`, FIXTURES)),
      )
      .sort()
  : [];

let loadPlan: ((json: unknown) => PlanModel) | null = null;
try {
  ({ loadPlan } = await import("../../src/plan/load.js"));
} catch {
  loadPlan = null;
}

const read = (name: string, file: string): unknown =>
  JSON.parse(readFileSync(new URL(`${name}/${file}`, FIXTURES), "utf8"));

describe.skipIf(!loadPlan || names.length === 0)("eval fixtures", () => {
  it.each(names)("%s", (name) => {
    const labels = read(name, "labels.json") as Labels;
    const scored = scorePlan(loadPlan!(read(name, "plan.json")));
    const byAddress = new Map(scored.map((s) => [s.change.address, s]));
    for (const m of labels.material) {
      const s = byAddress.get(m.address);
      expect(s, `${m.address} is a change in the plan`).toBeDefined();
      expect(["critical", "high"], `${m.address}: ${JSON.stringify(s?.signals)}`).toContain(s?.severity);
    }
    if (labels.material.length === 0) {
      const acceptable = new Set(labels.acceptable ?? []);
      const flagged = scored
        .filter(
          (s) => (s.severity === "critical" || s.severity === "high") && !acceptable.has(s.change.address),
        )
        .map((s) => `${s.change.address} (${s.severity}: ${s.signals[0]?.ruleId})`);
      expect(flagged).toEqual([]);
    }
  });
});
