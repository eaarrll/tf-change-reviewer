/*
 * Consistency of the dev answer keys with evals/README.md ("Labels"): the README calls a retention
 * cut and a security group rule widened inside a VPC "acceptable" (docs/research-risk-taxonomy.md
 * AWS-U09 rates a log-group retention decrease MEDIUM), and the agent prompt calls a shortened
 * retention material. Left unlabeled, flagging one is graded as a false positive.
 * ho-* fixtures are the blind holdout set and are never read here.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseLabels } from "../../evals/grade.js";

const FIXTURES = new URL("../../evals/fixtures/", import.meta.url);
const SCENARIOS = new URL("../../evals/scenarios/", import.meta.url);

const dev = existsSync(FIXTURES)
  ? readdirSync(FIXTURES)
      .filter((n) => !n.startsWith("ho-") && existsSync(new URL(`${n}/labels.json`, FIXTURES)))
      .sort()
  : [];

interface PlanChange {
  address: string;
  type: string;
  change: {
    actions: string[];
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  };
}

const readJson = (base: URL, path: string): unknown => JSON.parse(readFileSync(new URL(path, base), "utf8"));

/** A create, or an update that changes more than tags (default_tags reach every rule). */
function createdOrChanged(rc: PlanChange): boolean {
  const actions = rc.change.actions.join();
  if (actions === "create") return true;
  if (actions !== "update") return false;
  const { before, after } = rc.change;
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  keys.delete("tags");
  keys.delete("tags_all");
  return [...keys].some((k) => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]));
}

/** aws_cloudwatch_log_group whose retention_in_days goes down (0 = never expire). */
function retentionCut(rc: PlanChange): boolean {
  if (rc.type !== "aws_cloudwatch_log_group" || rc.change.actions.join() !== "update") return false;
  const before = rc.change.before?.retention_in_days;
  const after = rc.change.after?.retention_in_days;
  return (
    typeof before === "number" && typeof after === "number" && (before === 0 ? after > 0 : after < before)
  );
}

/** A new or changed ingress rule whose source is another security group (inside the VPC, no CIDR). */
function intraVpcIngress(rc: PlanChange): boolean {
  if (!createdOrChanged(rc)) return false;
  const after = rc.change.after ?? {};
  if (rc.type === "aws_vpc_security_group_ingress_rule")
    return after.cidr_ipv4 == null && after.cidr_ipv6 == null && after.prefix_list_id == null;
  if (rc.type === "aws_security_group_rule")
    return (
      after.type === "ingress" &&
      !(Array.isArray(after.cidr_blocks) && after.cidr_blocks.length > 0) &&
      !(Array.isArray(after.ipv6_cidr_blocks) && after.ipv6_cidr_blocks.length > 0)
    );
  return false;
}

describe.skipIf(dev.length === 0)("dev labels", () => {
  it.each(dev)("%s: every retention cut and intra-VPC ingress rule is material or acceptable", (name) => {
    const labels = parseLabels(readJson(FIXTURES, `${name}/labels.json`));
    const labeled = new Set([...labels.material.map((m) => m.address), ...(labels.acceptable ?? [])]);
    const plan = readJson(FIXTURES, `${name}/plan.json`) as { resource_changes?: PlanChange[] };
    const unlabeled = (plan.resource_changes ?? [])
      .filter((rc) => retentionCut(rc) || intraVpcIngress(rc))
      .map((rc) => rc.address)
      .filter((address) => !labeled.has(address));
    expect(unlabeled).toEqual([]);
  });

  it.each(dev.filter((n) => existsSync(new URL(`${n}/labels.json`, SCENARIOS))))(
    "%s: the fixture's labels.json says what the scenario's says",
    (name) => {
      expect(readJson(FIXTURES, `${name}/labels.json`)).toEqual(readJson(SCENARIOS, `${name}/labels.json`));
    },
  );
});
