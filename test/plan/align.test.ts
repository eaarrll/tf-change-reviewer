import { describe, expect, it } from "vitest";
import { alignBefore } from "../../src/plan/align.js";
import { loadPlan } from "../../src/plan/load.js";

const rule = (description: string, cidrs: string[], port = 5432) => ({
  cidr_blocks: cidrs,
  description,
  from_port: port,
  protocol: "tcp",
  to_port: port,
});

describe("alignBefore", () => {
  it("lines up set elements Terraform listed in another order, so only the edited one differs", () => {
    const before = { ingress: [rule("billing", ["10.40.10.0/24"]), rule("office", ["203.0.113.0/24"])] };
    const after = { ingress: [rule("office", ["0.0.0.0/0"]), rule("billing", ["10.40.10.0/24"])] };
    const marks = { ingress: [{ cidr_blocks: [false] }, { cidr_blocks: [true] }] };
    const out = alignBefore(before, after, marks);
    expect((out.before as typeof before).ingress.map((r) => r.description)).toEqual(["office", "billing"]);
    // Sensitivity marks move with their element.
    expect((out.beforeSensitive as typeof marks).ingress).toEqual([
      { cidr_blocks: [true] },
      { cidr_blocks: [false] },
    ]);
  });

  it("leaves a pure reorder alone (an ordered list whose order is the change) and the input untouched", () => {
    const before = { rule: [rule("a", ["1.0.0.0/8"]), rule("b", ["2.0.0.0/8"])] };
    const after = { rule: [rule("b", ["2.0.0.0/8"]), rule("a", ["1.0.0.0/8"])] };
    const out = alignBefore(before, after, {});
    expect(out.before).toBe(before);
    expect(before.rule[0]?.description).toBe("a");
  });

  it("leaves a null in before where an element was added mid-list, so no existing one reads as edited", () => {
    const before = { ingress: [rule("a", ["1.0.0.0/8"]), rule("c", ["3.0.0.0/8"])] };
    const after = {
      ingress: [rule("a", ["1.0.0.0/8"]), rule("new", ["9.0.0.0/8"], 22), rule("c", ["3.0.0.0/8"])],
    };
    const marks = { ingress: [{ cidr_blocks: [false] }, { cidr_blocks: [true] }] };
    const out = alignBefore(before, after, marks);
    expect((out.before as { ingress: unknown[] }).ingress).toEqual([
      before.ingress[0],
      null,
      before.ingress[1],
    ]);
    expect((out.beforeSensitive as typeof marks).ingress).toEqual([
      { cidr_blocks: [false] },
      false,
      { cidr_blocks: [true] },
    ]);
    // A rule added ahead of the only existing one (the provider's set order).
    const one = { ingress: [rule("pg", ["10.0.0.0/16"])] };
    const two = { ingress: [rule("ssh", ["0.0.0.0/0"], 22), rule("pg", ["10.0.0.0/16"])] };
    expect((alignBefore(one, two, {}).before as { ingress: unknown[] }).ingress).toEqual([
      null,
      one.ingress[0],
    ]);
    // Added at the end: nothing to pad.
    const end = { ingress: [rule("pg", ["10.0.0.0/16"]), rule("ssh", ["0.0.0.0/0"], 22)] };
    expect(alignBefore(one, end, {}).before).toBe(one);
  });

  it("feeds loadPlan: changed paths name only the edited rule", () => {
    const plan = loadPlan({
      format_version: "1.2",
      terraform_version: "1.10.5",
      resource_changes: [
        {
          address: "aws_security_group.db",
          mode: "managed",
          type: "aws_security_group",
          name: "db",
          provider_name: "registry.terraform.io/hashicorp/aws",
          change: {
            actions: ["update"],
            before: { ingress: [rule("billing", ["10.40.10.0/24"]), rule("office", ["203.0.113.0/24"])] },
            after: { ingress: [rule("office", ["0.0.0.0/0"]), rule("billing", ["10.40.10.0/24"])] },
            after_unknown: {},
            before_sensitive: {},
            after_sensitive: {},
          },
        },
      ],
    });
    const c = plan.changes[0]!;
    expect(c.changedPaths).toEqual([["ingress", 0, "cidr_blocks"]]);
    expect((c.before as { ingress: { description: string }[] }).ingress[0]?.description).toBe("office");
  });

  it("feeds loadPlan: a rule added mid-list is one added element, not an edit of its neighbours", () => {
    const plan = loadPlan({
      format_version: "1.2",
      terraform_version: "1.10.5",
      resource_changes: [
        {
          address: "aws_security_group.db",
          mode: "managed",
          type: "aws_security_group",
          name: "db",
          provider_name: "registry.terraform.io/hashicorp/aws",
          change: {
            actions: ["update"],
            before: { ingress: [rule("pg", ["10.0.0.0/16"])] },
            after: { ingress: [rule("ssh", ["0.0.0.0/0"], 22), rule("pg", ["10.0.0.0/16"])] },
            after_unknown: {},
            before_sensitive: { ingress: [{ cidr_blocks: [false] }] },
            after_sensitive: {},
          },
        },
      ],
    });
    expect(plan.changes[0]!.changedPaths).toEqual([["ingress", 0]]);
  });
});
