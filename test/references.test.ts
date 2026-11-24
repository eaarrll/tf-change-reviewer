import { describe, expect, it } from "vitest";
import { loadPlan } from "../src/plan/load.js";
import { stillReferencedSignals } from "../src/references.js";

function rc(address: string, actions: string[], before: unknown, after: unknown) {
  const [type, name] = address.replace(/^module\.[^.]+\./, "").split(".");
  return {
    address,
    mode: "managed",
    type,
    name: name?.replace(/\[.*$/, ""),
    provider_name: "registry.terraform.io/hashicorp/aws",
    change: { actions, before, after, after_unknown: {}, before_sensitive: {}, after_sensitive: {} },
  };
}

const KEY_ID = "1234abcd-12ab-34cd-56ef-1234567890ab";
const KEY_ARN = `arn:aws:kms:eu-west-1:123456789012:key/${KEY_ID}`;

function plan(extra: unknown[] = []) {
  return loadPlan({
    format_version: "1.2",
    terraform_version: "1.10.5",
    resource_changes: [
      rc("aws_kms_key.docs", ["delete"], { key_id: KEY_ID, arn: KEY_ARN, id: KEY_ID }, null),
      rc(
        "aws_kms_alias.docs",
        ["delete"],
        { name: "alias/docs", target_key_id: KEY_ID, id: "alias/docs" },
        null,
      ),
      rc(
        "aws_sqs_queue.a",
        ["no-op"],
        { kms_master_key_id: "alias/docs" },
        { kms_master_key_id: "alias/docs" },
      ),
      rc("aws_ssm_parameter.b", ["no-op"], { key_id: "alias/docs" }, { key_id: "alias/docs" }),
      rc(
        "aws_iam_policy.p",
        ["no-op"],
        { policy: `{"Statement":[{"Resource":"${KEY_ARN}"}]}`, tags: { Note: "alias/docs" } },
        { policy: `{"Statement":[{"Resource":"${KEY_ARN}"}]}`, tags: { Note: "alias/docs" } },
      ),
      ...extra,
    ],
  });
}

describe("stillReferencedSignals", () => {
  it("names the kept resources that use a deleted object's identifier by a literal value", () => {
    const p = plan();
    const signals = stillReferencedSignals(p);
    const alias = signals.get(p.changes.find((c) => c.address === "aws_kms_alias.docs")!)?.[0];
    expect(alias?.ruleId).toBe("still-referenced");
    expect(alias?.reason).toMatch(
      /^2 resources this plan keeps still use its "alias\/docs" as a literal value/,
    );
    expect(alias?.reason).toMatch(/aws_sqs_queue ×1, aws_ssm_parameter ×1/);
  });

  it("follows a deleted alias to its key, and finds an ARN inside a policy document; tags never count", () => {
    const p = plan();
    const key = stillReferencedSignals(p).get(p.changes.find((c) => c.address === "aws_kms_key.docs")!)?.[0];
    expect(key?.reason).toMatch(/1 resource this plan keeps still uses its "arn:aws:kms:/);
    expect(key?.reason).toMatch(/aws_kms_alias\.docs, which points at it, is destroyed too, and 2 resources/);
  });

  it("ignores a value another object of the same type also carries (a placeholder, not an identifier)", () => {
    const p = plan([rc("aws_kms_alias.other", ["no-op"], { name: "alias/docs" }, { name: "alias/docs" })]);
    const alias = stillReferencedSignals(p).get(p.changes.find((c) => c.address === "aws_kms_alias.docs")!);
    expect(alias).toBeUndefined();
  });
});
