import { describe, expect, it } from "vitest";
import {
  MASS_DESTROY_THRESHOLD,
  buildScoreContext,
  changeKind,
  escalateForLineage,
  findReplacedUpstream,
  isDestroyPlan,
  scoreChange,
  scorePlan,
} from "../../src/risk/score.js";
import { SENSITIVE_PLACEHOLDER } from "../../src/types.js";
import type { Lineage, PlanModel, ResourceChange, ScoredChange } from "../../src/types.js";
import { configModule, configResource, plan, policyJson, rc } from "./helpers.js";

/** Score one change inside a plan made of `others` plus itself. */
function score(
  change: ResourceChange,
  others: ResourceChange[] = [],
  extra: Partial<PlanModel> = {},
): ScoredChange {
  const p = plan([change, ...others], extra);
  return scoreChange(change, p);
}

const ruleIds = (s: ScoredChange): string[] => s.signals.map((x) => x.ruleId);

const tagsUpdate = (address: string, extra: Record<string, unknown> = {}) =>
  rc({
    address,
    before: { ...extra, tags: { Team: "a" }, tags_all: { Team: "a" } },
    after: { ...extra, tags: { Team: "a" }, tags_all: { Team: "a", CostCenter: "42" } },
  });

const dbBefore = {
  identifier: "orders-prod",
  storage_encrypted: true,
  skip_final_snapshot: false,
  deletion_protection: false,
  engine: "postgres",
};

describe("noise (NOISE-01..05)", () => {
  it("tags_all-only updates are noise attributed to default_tags", () => {
    const s = score(tagsUpdate("aws_sqs_queue.q"));
    expect(s.severity).toBe("noise");
    expect(s.signals[0]).toMatchObject({ ruleId: "tags-only", severity: "noise" });
    expect(s.signals[0]?.reason).toContain("default_tags");
    expect(s.signals[0]?.reason).toContain("tags_all.CostCenter");
  });

  it("a stateful resource with only tag changes is not elevated", () => {
    const db = tagsUpdate("aws_db_instance.orders", dbBefore);
    const bucket = rc({
      address: "aws_s3_bucket.b",
      before: { bucket: "b", tags: null, tags_all: {} },
      after: { bucket: "b", tags: { Retention: "7y" }, tags_all: { Retention: "7y" } },
    });
    expect(score(db).severity).toBe("noise");
    expect(score(bucket).severity).toBe("noise");
    expect(score(bucket).signals[0]?.reason).toMatch(/^Only tags change/);
  });

  it("a functional tag key (EKS load balancer discovery) is not noise", () => {
    const s = score(
      rc({
        address: "aws_subnet.public",
        before: { tags: {}, tags_all: {} },
        after: { tags: { "kubernetes.io/role/elb": "1" }, tags_all: { "kubernetes.io/role/elb": "1" } },
      }),
    );
    expect(s.severity).toBe("medium");
    expect(ruleIds(s)).toContain("functional-tag");
  });

  it("a tag key used by an ABAC condition elsewhere in the plan is functional", () => {
    const abac = rc({
      address: "aws_iam_policy.abac",
      actions: ["no-op"],
      before: {
        policy: policyJson([
          {
            Effect: "Allow",
            Action: "ec2:*",
            Resource: "*",
            Condition: { StringEquals: { "aws:ResourceTag/Team": "x" } },
          },
        ]),
      },
      after: {
        policy: policyJson([
          {
            Effect: "Allow",
            Action: "ec2:*",
            Resource: "*",
            Condition: { StringEquals: { "aws:ResourceTag/Team": "x" } },
          },
        ]),
      },
    });
    const instance = rc({
      address: "aws_instance.app",
      before: { tags: { Team: "a" } },
      after: { tags: { Team: "b" } },
    });
    expect(score(instance, [abac]).signals[0]?.ruleId).toBe("functional-tag");
    expect(score(instance).severity).toBe("noise");
  });

  it.each([
    ["description only", { description: "old" }, { description: "new" }, "description-only"],
    ["a longer log retention", { retention_in_days: 14 }, { retention_in_days: 30 }, "retention-increase"],
    [
      "a longer queue retention",
      { message_retention_seconds: 86400 },
      { message_retention_seconds: 345600 },
      "retention-increase",
    ],
  ])("%s is noise", (_label, before, after, ruleId) => {
    const s = score(rc({ address: "aws_cloudwatch_log_group.l", before, after }));
    expect(s.severity).toBe("noise");
    expect(ruleIds(s)).toEqual([ruleId]);
  });

  it("policy JSON that differs only in whitespace and order is noise", () => {
    const a = policyJson([
      { Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject"], Resource: "arn:aws:s3:::b/*" },
    ]);
    const b = JSON.stringify(
      {
        Statement: [
          { Resource: ["arn:aws:s3:::b/*"], Action: ["s3:PutObject", "s3:GetObject"], Effect: "Allow" },
        ],
        Version: "2012-10-17",
      },
      null,
      2,
    );
    const s = score(rc({ address: "aws_iam_policy.p", before: { policy: a }, after: { policy: b } }));
    expect(s.severity).toBe("noise");
    expect(ruleIds(s)).toEqual(["policy-reformatted"]);
  });

  it("a data source read during apply and a pure move are noise (PLAN-09)", () => {
    expect(
      score(rc({ address: "data.aws_iam_policy_document.x", actions: ["read"], after: {} })).severity,
    ).toBe("noise");
    const moved = score(
      rc({
        address: "aws_s3_bucket.new",
        actions: ["no-op"],
        previousAddress: "aws_s3_bucket.old",
        before: {},
        after: {},
      }),
    );
    expect(moved.severity).toBe("noise");
    expect(moved.signals[0]?.reason).toContain("aws_s3_bucket.old");
  });

  it("inline security group rules managed by separate rule resources flip-flop as noise (NOISE-05)", () => {
    const sg = rc({
      address: "aws_security_group.app",
      before: {
        id: "sg-1",
        ingress: [{ from_port: 443, to_port: 443, protocol: "tcp", cidr_blocks: ["10.0.0.0/8"] }],
      },
      after: { id: "sg-1", ingress: [] },
    });
    const rule = rc({
      address: "aws_vpc_security_group_ingress_rule.r",
      actions: ["no-op"],
      before: { security_group_id: "sg-1" },
      after: { security_group_id: "sg-1" },
    });
    expect(score(sg, [rule]).signals[0]?.ruleId).toBe("sg-conflicting-management");
    expect(score(sg).severity).toBe("low");
  });
});

describe("replacements and deletes (PLAN-01/02/08)", () => {
  const dbReplace = (extra: Partial<Parameters<typeof rc>[0]> = {}) =>
    rc({
      address: "module.orders_db.aws_db_instance.this",
      actions: ["delete", "create"],
      actionReason: "replace_because_cannot_update",
      replacePaths: [["storage_encrypted"]],
      before: dbBefore,
      after: { ...dbBefore, storage_encrypted: false },
      afterUnknown: { address: true, arn: true, endpoint: true },
      ...extra,
    });

  it("an RDS replace forced by storage_encrypted is critical and explains why", () => {
    const s = score(dbReplace());
    expect(s.severity).toBe("critical");
    expect(s.signals[0]?.ruleId).toBe("stateful-replace");
    expect(s.signals[0]?.path).toEqual(["storage_encrypted"]);
    expect(s.signals[0]?.reason).toContain("storage_encrypted true → false forces replacement");
    expect(s.signals[0]?.reason).toContain(
      "RDS cannot encrypt or decrypt an existing instance's storage; it creates a new one",
    );
  });

  it("create_before_destroy never softens data loss", () => {
    expect(score(dbReplace({ actions: ["create", "delete"] })).severity).toBe("critical");
  });

  it.each([
    ["aws_security_group (outage) delete-first", "aws_security_group.sg", ["delete", "create"], "high"],
    ["aws_security_group (outage) create-first", "aws_security_group.sg", ["create", "delete"], "medium"],
    ["aws_eks_node_group create-first", "aws_eks_node_group.ng", ["create", "delete"], "medium"],
    ["aws_iam_role (identity) create-first", "aws_iam_role.r", ["create", "delete"], "high"],
    ["aws_ssm_parameter (cattle)", "aws_ssm_parameter.p", ["delete", "create"], "medium"],
    ["aws_ssm_parameter (cattle) create-first", "aws_ssm_parameter.p", ["create", "delete"], "low"],
  ])("%s replace is %s", (_label, address, actions, severity) => {
    const s = score(
      rc({
        address,
        actions,
        actionReason: "replace_because_cannot_update",
        replacePaths: [["name"]],
        before: { name: "a" },
        after: { name: "b" },
      }),
    );
    expect(s.severity).toBe(severity);
  });

  it("names every forcing attribute, known changes first", () => {
    const s = score(
      rc({
        address: "aws_lb_target_group.tg",
        actions: ["delete", "create"],
        actionReason: "replace_because_cannot_update",
        replacePaths: [["protocol_version"], ["name"]],
        before: { name: "a", protocol_version: "HTTP1" },
        after: { name: "b" },
        afterUnknown: { protocol_version: true },
      }),
    );
    expect(s.signals[0]?.reason).toMatch(
      /^name "a" → "b" and protocol_version \(known only after apply\) force replacement \(a target group cannot be renamed\)/,
    );
  });

  it.each([
    ["tainted Tier A", "aws_db_instance.db", "replace_because_tainted", "critical", "tainted-replace"],
    ["tainted Tier C", "aws_ssm_parameter.p", "replace_because_tainted", "medium", "tainted-replace"],
    ["-replace on Tier B", "aws_iam_role.r", "replace_by_request", "medium", "replace-by-request"],
    ["-replace on Tier A", "aws_dynamodb_table.t", "replace_by_request", "critical", "replace-by-request"],
    [
      "replace_triggered_by on Tier B",
      "aws_iam_role.r",
      "replace_by_triggers",
      "high",
      "replace-by-triggers",
    ],
  ])("%s (PLAN-08)", (_label, address, actionReason, severity, ruleId) => {
    const s = score(
      rc({
        address,
        actions: ["delete", "create"],
        actionReason,
        before: { name: "x" },
        after: { name: "x" },
      }),
    );
    expect(s.severity).toBe(severity);
    expect(ruleIds(s)).toContain(ruleId);
  });

  it("a deleted bucket with force_destroy says objects are unrecoverable", () => {
    const s = score(
      rc({ address: "aws_s3_bucket.b", actions: ["delete"], before: { bucket: "b", force_destroy: true } }),
    );
    expect(s.severity).toBe("critical");
    expect(s.signals[0]?.reason).toContain("cannot be recovered");
  });

  it("a destroy blocked by deletion protection says the apply fails", () => {
    const s = score(
      rc({
        address: "aws_db_instance.db",
        actions: ["delete"],
        before: { ...dbBefore, deletion_protection: true },
      }),
    );
    expect(s.signals[0]?.reason).toContain("deletion protection is on");
  });

  it("an aws_ecs_task_definition replace is a new revision, noise when containers are equal (NOISE-02)", () => {
    const defs = (image: string, extra = {}) =>
      JSON.stringify([
        {
          name: "app",
          image,
          essential: true,
          environment: [
            { name: "B", value: "2" },
            { name: "A", value: "1" },
          ],
          mountPoints: [],
          ...extra,
        },
      ]);
    const td = (a: string, b: string) =>
      rc({
        address: "aws_ecs_task_definition.app",
        actions: ["delete", "create"],
        actionReason: "replace_because_cannot_update",
        replacePaths: [["container_definitions"]],
        before: { container_definitions: a },
        after: { container_definitions: b },
      });
    const same = defs("repo/app:1");
    const reordered = JSON.stringify([
      {
        image: "repo/app:1",
        name: "app",
        environment: [
          { name: "A", value: "1" },
          { name: "B", value: "2" },
        ],
      },
    ]);
    expect(score(td(same, reordered)).severity).toBe("noise");
    const bumped = score(td(same, defs("repo/app:2")));
    expect(bumped.severity).toBe("low");
    expect(bumped.signals[0]?.reason).toContain('app image "app:1" → "app:2"');
  });
});

describe("delete reasons (PLAN-04/05/06)", () => {
  it("a removed module call destroys everything in it; Tier A members stay critical", () => {
    const bucket = rc({
      address: "module.legacy.aws_s3_bucket.this",
      actions: ["delete"],
      actionReason: "delete_because_no_resource_config",
      before: { bucket: "old" },
    });
    const logs = rc({
      address: "module.legacy.aws_cloudwatch_log_group.this",
      actions: ["delete"],
      actionReason: "delete_because_no_resource_config",
      before: { name: "/old" },
    });
    const p = plan([bucket, logs], { modules: { "": configModule([]) } });
    const [first, second] = scorePlan(p);
    expect(first?.change).toBe(bucket);
    expect(first?.severity).toBe("critical");
    expect(ruleIds(first!)).toContain("module-removed");
    expect(first?.signals.find((s) => s.ruleId === "module-removed")?.reason).toContain(
      "module.legacy was removed",
    );
    expect(second?.severity).toBe("high");
  });

  it("a removed resource block (module still present) is not a module removal", () => {
    const logs = rc({
      address: "module.app.aws_cloudwatch_log_group.this",
      actions: ["delete"],
      actionReason: "delete_because_no_resource_config",
      before: { name: "/x" },
    });
    const s = score(logs);
    expect(s.severity).toBe("medium");
    expect(ruleIds(s)).not.toContain("module-removed");
    expect(s.signals[0]?.reason).toContain("block was removed from the configuration");
    // prevent_destroy is PLAN-13's to mention, and only when the PR removed it.
    expect(s.signals[0]?.reason).not.toContain("prevent_destroy");
  });

  it.each([
    ["Tier C", "aws_sqs_queue_policy", "high"],
    ["Tier A", "aws_dynamodb_table", "critical"],
  ])("delete_because_no_module on %s is %s", (_label, type, severity) => {
    const s = score(
      rc({
        address: `module.tenant[1].${type}.this`,
        actions: ["delete"],
        actionReason: "delete_because_no_module",
        before: { name: "t" },
      }),
    );
    expect(s.severity).toBe(severity);
    expect(ruleIds(s)).toContain("module-instance-removed");
  });

  it("detects a count re-index: every shifted bucket is flagged and the cause is named", () => {
    const names = ["exports", "invoices", "receipts", "ledger"];
    const changes = [0, 1, 2].map((i) =>
      rc({
        address: `aws_s3_bucket.data[${i}]`,
        actions: ["delete", "create"],
        actionReason: "replace_because_cannot_update",
        replacePaths: [["bucket"]],
        before: { bucket: names[i] },
        after: { bucket: names[i + 1] },
      }),
    );
    changes.push(
      rc({
        address: "aws_s3_bucket.data[3]",
        actions: ["delete"],
        actionReason: "delete_because_count_index",
        before: { bucket: "ledger" },
      }),
    );
    const scored = scorePlan(plan(changes));
    for (const s of scored) {
      expect(s.severity).toBe("critical");
      expect(ruleIds(s)).toContain("count-reindex");
    }
    const last = scored.find((s) => s.change.address === "aws_s3_bucket.data[3]")!;
    expect(last.signals.find((s) => s.ruleId === "count-reindex")?.reason).toContain(
      "aws_s3_bucket.data[2] now describes the object this instance holds",
    );
  });

  it("re-index severity for cattle follows how many instances are touched", () => {
    const q = (i: number, name: string, next?: string): ResourceChange =>
      next
        ? rc({
            address: `aws_ssm_parameter.p[${i}]`,
            actions: ["delete", "create"],
            actionReason: "replace_because_cannot_update",
            replacePaths: [["name"]],
            before: { name },
            after: { name: next },
          })
        : rc({
            address: `aws_ssm_parameter.p[${i}]`,
            actions: ["delete"],
            actionReason: "delete_because_count_index",
            before: { name },
          });
    const two = scorePlan(plan([q(0, "a", "b"), q(1, "b")]));
    expect(two.map((s) => s.signals.find((x) => x.ruleId === "count-reindex")?.severity)).toEqual([
      "medium",
      "medium",
    ]);
    const three = scorePlan(plan([q(0, "a", "b"), q(1, "b", "c"), q(2, "c")]));
    expect(three.every((s) => s.severity === "high")).toBe(true);
  });

  it("identical instances whose identity does not move are not a re-index", () => {
    const inst = (k: string) =>
      rc({
        address: `aws_instance.node["${k}"]`,
        actions: ["delete", "create"],
        actionReason: "replace_because_cannot_update",
        replacePaths: [["subnet_id"]],
        before: { ami: "ami-1", instance_type: "m7g.large", subnet_id: "s-1", tags: { Name: k } },
        after: { ami: "ami-1", instance_type: "m7g.large", tags: { Name: k } },
        afterUnknown: { subnet_id: true },
      });
    const scored = scorePlan(plan([inst("a"), inst("b")]));
    expect(scored.flatMap(ruleIds)).not.toContain("count-reindex");
  });

  it("a delete next to a create of the same object is a rename without a moved block", () => {
    const old = rc({
      address: "aws_dynamodb_table.orders",
      actions: ["delete"],
      actionReason: "delete_because_no_resource_config",
      before: { name: "prod-orders", hash_key: "id" },
    });
    const neu = rc({
      address: "aws_dynamodb_table.orders_table",
      actions: ["create"],
      after: { name: "prod-orders", hash_key: "id" },
      afterUnknown: { arn: true },
    });
    const p = plan([old, neu]);
    const a = scoreChange(old, p);
    const b = scoreChange(neu, p);
    expect(a.severity).toBe("critical");
    expect(a.signals.find((s) => s.ruleId === "renamed-without-moved")?.reason).toContain(
      "aws_dynamodb_table.orders_table",
    );
    expect(b.severity).toBe("medium");
    expect(ruleIds(b)).toEqual(["renamed-without-moved"]);
  });

  it("a loose rename (no identity attribute) finds the first match in plan order, past common values", () => {
    const del = (address: string, before: Record<string, unknown>) =>
      rc({ address, actions: ["delete"], actionReason: "delete_because_no_resource_config", before });
    const add = (address: string, after: Record<string, unknown>) =>
      rc({ address, actions: ["create"], after });
    // Fifty creates share two of the deleted object's values but differ in the third: not the same object.
    const decoys = Array.from({ length: 50 }, (_, i) =>
      add(`terraform_data.decoy[${i}]`, { kind: "x", tier: "gold", size: 100 + i }),
    );
    const old = del("terraform_data.old", { kind: "x", tier: "gold", size: 7, mode: "a", zone: "z1" });
    // Both match; `first` comes first in plan order but shares only three values, two of them common.
    const first = add("terraform_data.first", { kind: "x", tier: "gold", size: 7 });
    const later = add("terraform_data.later", { kind: "x", tier: "gold", size: 7, mode: "a", zone: "z1" });
    const p = plan([...decoys, old, first, later]);
    const reason = scoreChange(old, p).signals.find((s) => s.ruleId === "renamed-without-moved")?.reason;
    expect(reason).toContain("terraform_data.first creates the same object");
    expect(ruleIds(scoreChange(first, p))).toContain("renamed-without-moved");
    expect(ruleIds(scoreChange(decoys[0]!, p))).not.toContain("renamed-without-moved");
  });

  describe("the moved block it suggests is valid across module calls", () => {
    const del = (address: string, bucket = "acme-data") =>
      rc({
        address,
        actions: ["delete"],
        actionReason: "delete_because_no_resource_config",
        before: { bucket },
      });
    const add = (address: string, bucket = "acme-data") =>
      rc({ address, actions: ["create"], after: { bucket }, afterUnknown: { arn: true } });
    const advice = (changes: ResourceChange[], modules?: PlanModel["modules"]): string => {
      const p = plan(changes, modules ? { modules } : {});
      const reason = scoreChange(changes[0]!, p).signals.find((s) => s.ruleId === "renamed-without-moved");
      return reason?.reason.replace(/^.*(A moved block)/, "$1") ?? "";
    };

    it("a renamed module call: one module-level moved block in the root module", () => {
      const modules = { "": configModule([]), storage: configModule(["storage"]) };
      expect(
        advice([del("module.store.aws_s3_bucket.this"), add("module.storage.aws_s3_bucket.this")], modules),
      ).toBe("A moved block in the root module keeps it: moved { from = module.store to = module.storage }.");
    });

    it("a resource moved into a module: full addresses, never the same relative address twice", () => {
      expect(advice([del("aws_s3_bucket.this"), add("module.storage.aws_s3_bucket.this")])).toBe(
        "A moved block in the root module keeps it: moved { from = aws_s3_bucket.this to = module.storage.aws_s3_bucket.this }.",
      );
    });

    it("only part of the module moves: resource addresses, not the module", () => {
      const kept = rc({
        address: "module.store.aws_s3_bucket.logs",
        actions: ["no-op"],
        before: {},
        after: {},
      });
      expect(
        advice([del("module.store.aws_s3_bucket.this"), add("module.storage.aws_s3_bucket.this"), kept]),
      ).toBe(
        "A moved block in the root module keeps it: moved { from = module.store.aws_s3_bucket.this to = module.storage.aws_s3_bucket.this }.",
      );
    });

    it("calls inside a shared parent module: written in that module, relative to it", () => {
      expect(
        advice([
          del('module.app["eu"].module.a.aws_s3_bucket.this'),
          add('module.app["eu"].module.b.aws_s3_bucket.this'),
        ]),
      ).toBe("A moved block in the code of module.app keeps it: moved { from = module.a to = module.b }.");
    });
  });
});

describe("destroy plans and OpenTofu's enabled = false", () => {
  const configured = (...addresses: string[]) => ({
    "": configModule(
      [],
      addresses.map((a) => configResource(a, {})),
    ),
  });

  it("recognises a destroy plan, and does not call a moved object 'moved but destroyed' there", () => {
    const moved = rc({
      address: "terraform_data.new_name",
      actions: ["delete"],
      previousAddress: "terraform_data.old_name",
      before: { input: "x" },
    });
    const other = rc({ address: "aws_sqs_queue.jobs", actions: ["delete"], before: { name: "jobs" } });
    const p = plan([moved, other], { modules: configured("terraform_data.new_name", "aws_sqs_queue.jobs") });
    expect(isDestroyPlan(p)).toBe(true);
    const [a, b] = [scoreChange(moved, p), scoreChange(other, p)];
    expect(ruleIds(a)).not.toContain("moved-but-destroyed");
    expect(b.signals[0]?.reason).toContain(
      "is destroyed because this is a destroy plan (terraform plan -destroy), not because of the configuration",
    );
    // A normal plan: deletes carry a reason, or the block is gone from the configuration.
    expect(isDestroyPlan(plan([{ ...other, actionReason: "delete_because_no_resource_config" }]))).toBe(
      false,
    );
    expect(isDestroyPlan(plan([other], { modules: configured() }))).toBe(false);
  });

  it("names OpenTofu's enabled = false as the reason for a delete", () => {
    const s = score(
      rc({
        address: "aws_sqs_queue.jobs",
        actions: ["delete"],
        actionReason: "delete_because_enabled_false",
        before: { name: "jobs" },
      }),
    );
    expect(s.signals[0]?.reason).toContain("because its enabled argument is now false");
  });
});

describe("deposed leftovers (an earlier create_before_destroy's old object)", () => {
  const del = (i: number) =>
    rc({ address: `aws_ssm_parameter.p${i}`, actions: ["delete"], before: { name: `p${i}` } });
  const leftover = (address: string, name: string) =>
    rc({ address, actions: ["delete"], deposed: "00cc22dd", before: { name } });

  it("do not count as extra live resources toward a mass destroy, and are named apart", () => {
    const below = scorePlan(plan([...[0, 1, 2, 3].map(del), leftover("aws_ssm_parameter.p0", "p0-old")]));
    expect(below.flatMap(ruleIds)).not.toContain("mass-destroy");
    const at = scorePlan(plan([...[0, 1, 2, 3, 4].map(del), leftover("aws_ssm_parameter.p0", "p0-old")]));
    expect(at[0]?.signals.find((s) => s.ruleId === "mass-destroy")?.reason).toContain(
      "destroys 5 resources (0 replacements, 5 deletes), plus 1 leftover deposed object,",
    );
  });

  it("say what they are when no line of the PR explains them (PLAN-03)", () => {
    const dep = leftover("aws_ssm_parameter.p0", "p0-old");
    const external: Lineage = {
      address: dep.address,
      attribute: [],
      steps: [],
      rootCauseIds: [],
      explanation: "external",
      notes: [],
    };
    const s = escalateForLineage(scoreChange(dep, plan([dep])), external);
    expect(s.signals[0]?.reason).toMatch(
      /^No line in this PR causes this deletion: it removes a leftover \(deposed\) object/,
    );
  });

  it("do not make a count re-index look bigger, and are never the source of a rename", () => {
    const q0 = rc({
      address: "aws_ssm_parameter.q[0]",
      actions: ["delete", "create"],
      actionReason: "replace_because_cannot_update",
      replacePaths: [["name"]],
      before: { name: "a" },
      after: { name: "b" },
    });
    const q1 = rc({
      address: "aws_ssm_parameter.q[1]",
      actions: ["delete"],
      actionReason: "delete_because_count_index",
      before: { name: "b" },
    });
    const elsewhere = rc({
      address: "aws_ssm_parameter.other",
      actions: ["create"],
      after: { name: "q-old" },
    });
    const scored = scorePlan(plan([q0, q1, leftover("aws_ssm_parameter.q[0]", "q-old"), elsewhere]));
    for (const s of scored.filter(
      (x) => !x.change.deposed && x.change.address.startsWith("aws_ssm_parameter.q"),
    ))
      expect(s.signals.find((x) => x.ruleId === "count-reindex")?.severity).toBe("medium");
    const dep = scored.find((x) => x.change.deposed)!;
    expect(ruleIds(dep)).not.toContain("renamed-without-moved");
  });
});

describe("scale", () => {
  it("scores 8,000 shifted count instances and 8,000 renames without identities in linear time", () => {
    const shifted = Array.from({ length: 8000 }, (_, i) =>
      rc({
        address: `aws_iam_role.r[${i}]`,
        actions: ["delete", "create"],
        actionReason: "replace_because_cannot_update",
        replacePaths: [["name"]],
        before: { name: `r-${i}`, path: "/", max_session_duration: 3600 },
        after: { name: `r-${i + 1}`, path: "/", max_session_duration: 3600 },
        afterUnknown: { arn: true },
      }),
    );
    const renamed = Array.from({ length: 4000 }, (_, i) => [
      rc({
        address: `terraform_data.old[${i}]`,
        actions: ["delete"],
        actionReason: "delete_because_no_resource_config",
        before: { input: `v-${i}`, output: `v-${i}`, kind: "x", id: `i-${i}` },
      }),
      rc({
        address: `terraform_data.new[${i}]`,
        actions: ["create"],
        after: { input: `v-${i}`, output: `v-${i}`, kind: "x" },
        afterUnknown: { id: true },
      }),
    ]).flat();
    const started = performance.now();
    const scored = scorePlan(plan([...shifted, ...renamed]));
    const ms = performance.now() - started;
    expect(scored).toHaveLength(16000);
    const first = scored.find((s) => s.change.address === "aws_iam_role.r[0]")!;
    expect(first.signals.find((s) => s.ruleId === "count-reindex")?.reason).toContain(
      "this instance now gets the settings of aws_iam_role.r[1]",
    );
    const old = scored.find((s) => s.change.address === "terraform_data.old[3999]")!;
    expect(old.signals.find((s) => s.ruleId === "renamed-without-moved")?.reason).toContain(
      "terraform_data.new[3999] creates the same object",
    );
    // Quadratic matching took over 20 s here; linear takes well under a second.
    expect(ms).toBeLessThan(4000);
  }, 60_000);
});

describe("plan-level rules", () => {
  it(`mass destroy: ${MASS_DESTROY_THRESHOLD} or more deletes add a high signal to each (PLAN-11)`, () => {
    const del = (i: number) =>
      rc({ address: `aws_ssm_parameter.p${i}`, actions: ["delete"], before: { name: `p${i}` } });
    const below = scorePlan(plan([0, 1, 2, 3].map(del)));
    expect(below.every((s) => s.severity === "medium")).toBe(true);
    const at = scorePlan(plan([0, 1, 2, 3, 4].map(del)));
    expect(at.every((s) => s.severity === "high" && ruleIds(s).includes("mass-destroy"))).toBe(true);
    expect(at[0]?.signals.find((s) => s.ruleId === "mass-destroy")?.reason).toContain("destroys 5 resources");
  });

  it("forget is medium, forget+create high (PLAN-07)", () => {
    expect(
      score(rc({ address: "aws_s3_bucket.b", actions: ["forget"], before: { bucket: "b" } })),
    ).toMatchObject({ severity: "medium" });
    expect(
      score(
        rc({
          address: "aws_s3_bucket.b",
          actions: ["forget", "create"],
          before: { bucket: "b" },
          after: { bucket: "b" },
        }),
      ),
    ).toMatchObject({
      severity: "high",
    });
  });

  it.each([
    ["no-op import", ["no-op"], "low", "import"],
    ["import with update", ["update"], "medium", "import-update"],
    ["import then replace", ["delete", "create"], "critical", "import-destroy"],
  ])("%s (PLAN-09)", (_label, actions, severity, ruleId) => {
    const s = score(
      rc({
        address: "aws_s3_bucket.b",
        actions,
        importing: { id: "b" },
        before: { bucket: "b", acl: "private" },
        after: { bucket: "b", acl: "private2" },
      }),
    );
    expect(s.severity).toBe(severity);
    expect(ruleIds(s)).toContain(ruleId);
  });

  it("a move that still destroys is high", () => {
    const s = score(
      rc({
        address: "aws_sqs_queue.new",
        previousAddress: "aws_sqs_queue.old",
        actions: ["delete", "create"],
        actionReason: "replace_because_cannot_update",
        replacePaths: [["name"]],
        before: { name: "a" },
        after: { name: "b" },
      }),
    );
    expect(ruleIds(s)).toContain("moved-but-destroyed");
  });

  it.each([
    [
      "a security-relevant attribute",
      "aws_security_group.sg",
      { ingress: ["1.2.3.4/32"] },
      { ingress: ["10.0.0.0/8"] },
      "high",
    ],
    ["autoscaled capacity", "aws_ecs_service.svc", { desired_count: 9 }, { desired_count: 3 }, "high"],
    ["anything else", "aws_lambda_function.f", { memory_size: 1024 }, { memory_size: 512 }, "medium"],
  ])("drift revert on %s (PLAN-10)", (_label, address, before, after, severity) => {
    const change = rc({ address, before, after });
    const key = Object.keys(before)[0]!;
    const drift = rc({ address, before: { [key]: (after as Record<string, unknown>)[key] }, after: before });
    const s = score(change, [], { drift: [drift] });
    expect(s.signals.find((x) => x.ruleId === "drift-revert")?.severity).toBe(severity);
    expect(s.signals.find((x) => x.ruleId === "drift-revert")?.reason).toContain("changed outside Terraform");
  });

  it("drift on other attributes is not a revert", () => {
    const change = rc({
      address: "aws_lambda_function.f",
      before: { memory_size: 1024 },
      after: { memory_size: 512 },
    });
    const drift = rc({ address: "aws_lambda_function.f", before: { timeout: 3 }, after: { timeout: 30 } });
    expect(ruleIds(score(change, [], { drift: [drift] }))).not.toContain("drift-revert");
  });

  it("turning off two or more recovery guards at once is critical (AWS-U01/U02 composite)", () => {
    const one = rc({
      address: "aws_db_instance.db",
      before: { deletion_protection: true },
      after: { deletion_protection: false },
    });
    expect(score(one).severity).toBe("high");
    const all = rc({
      address: "aws_db_instance.db",
      before: { deletion_protection: true, skip_final_snapshot: false, backup_retention_period: 14 },
      after: { deletion_protection: false, skip_final_snapshot: true, backup_retention_period: 0 },
    });
    const s = score(all);
    expect(s.severity).toBe("critical");
    expect(s.signals[0]?.ruleId).toBe("safety-nets-off");
    expect(s.signals[0]?.reason).toBe(
      "Deletion protection, final snapshot and backups are all turned off: a destroy or mistake after this apply leaves the RDS database with no recovery point.",
    );
  });

  it("an import that also updates runs the update rules", () => {
    const s = score(
      rc({
        address: "aws_db_instance.db",
        actions: ["update"],
        importing: { id: "db" },
        before: { deletion_protection: true },
        after: { deletion_protection: false },
      }),
    );
    expect(ruleIds(s)).toEqual(expect.arrayContaining(["import-update", "deletion-protection-off"]));
    expect(s.severity).toBe("high");
  });

  it("deletion protection off escalates to critical when the same resource config is destroyed in the plan", () => {
    const off = rc({
      address: "aws_db_instance.db[0]",
      before: { deletion_protection: true },
      after: { deletion_protection: false },
    });
    const gone = rc({ address: "aws_db_instance.db[1]", actions: ["delete"], before: { identifier: "db1" } });
    expect(score(off).severity).toBe("high");
    expect(score(off, [gone]).severity).toBe("critical");
  });
});

describe("unknowns inherited from a replacement (PLAN-14)", () => {
  const subnet = rc({
    address: "module.vpc.aws_subnet.private",
    actions: ["delete", "create"],
    actionReason: "replace_because_cannot_update",
    replacePaths: [["cidr_block"]],
    before: { cidr_block: "10.0.1.0/24", id: "subnet-1" },
    after: { cidr_block: "10.0.16.0/20" },
    afterUnknown: { id: true },
  });
  const endpoint = rc({
    address: "aws_ssm_parameter.subnet",
    before: { name: "/net/subnet", value: "subnet-1" },
    after: { name: "/net/subnet" },
    afterUnknown: { value: true },
  });
  const modules = {
    "": configModule(
      [],
      [
        configResource("aws_ssm_parameter.subnet", {
          value: { references: ["module.vpc.subnet_id", "module.vpc"] },
        }),
      ],
    ),
    vpc: configModule(
      ["vpc"],
      [configResource("aws_subnet.private", { cidr_block: { references: ["var.cidr"] } })],
      {
        outputs: {
          subnet_id: { expression: { references: ["aws_subnet.private.id", "aws_subnet.private"] } },
        },
      },
    ),
  };

  it("follows a module output to the replaced resource", () => {
    const p = plan([subnet, endpoint], { modules });
    expect(findReplacedUpstream(endpoint, "value", buildScoreContext(p))?.address).toBe(
      "module.vpc.aws_subnet.private",
    );
  });

  it("an unknown-only update inherits the upstream severity minus one", () => {
    const p = plan([subnet, endpoint], { modules });
    const s = scoreChange(endpoint, p);
    expect(scoreChange(subnet, p).severity).toBe("critical");
    expect(s.severity).toBe("high");
    expect(s.signals[0]).toMatchObject({ ruleId: "unknown-from-replacement", path: ["value"] });
    expect(s.signals[0]?.reason).toContain("module.vpc.aws_subnet.private is replaced");
  });

  it("a force-new attribute inherits the full upstream severity", () => {
    const instance = rc({
      address: "aws_instance.app",
      before: { subnet_id: "subnet-1", ami: "ami-1" },
      after: { ami: "ami-1" },
      afterUnknown: { subnet_id: true },
    });
    const mods = {
      ...modules,
      "": configModule(
        [],
        [
          configResource("aws_instance.app", {
            subnet_id: { references: ["module.vpc.subnet_id", "module.vpc"] },
          }),
        ],
      ),
    };
    expect(scoreChange(instance, plan([subnet, instance], { modules: mods })).severity).toBe("critical");
  });

  it("follows var.X inside a module to the parent's module call argument", () => {
    const sg = rc({
      address: "aws_security_group.db",
      actions: ["delete", "create"],
      actionReason: "replace_because_cannot_update",
      replacePaths: [["name"]],
      before: { name: "a", id: "sg-1" },
      after: { name: "b" },
      afterUnknown: { id: true },
    });
    const inner = rc({
      address: "module.app.aws_lambda_function.f",
      before: { vpc_config: [{ security_group_ids: ["sg-1"] }] },
      after: { vpc_config: [{}] },
      afterUnknown: { vpc_config: [{ security_group_ids: true }] },
    });
    const mods = {
      "": configModule([], [configResource("aws_security_group.db", {})], {
        moduleCalls: {
          app: {
            name: "app",
            source: "./app",
            expressions: { sg_id: { references: ["aws_security_group.db.id", "aws_security_group.db"] } },
          },
        },
      }),
      app: configModule(
        ["app"],
        [
          configResource("aws_lambda_function.f", {
            vpc_config: [{ security_group_ids: { references: ["var.sg_id"] } }],
          }),
        ],
      ),
    };
    const s = scoreChange(inner, plan([sg, inner], { modules: mods }));
    expect(s.signals[0]?.ruleId).toBe("unknown-from-replacement");
    expect(s.severity).toBe("medium");
  });

  it("unknowns that do not come from a replacement are low (NOISE-05)", () => {
    const s = scoreChange(endpoint, plan([endpoint], { modules }));
    expect(s.severity).toBe("low");
    expect(ruleIds(s)).toEqual(["unknown-only"]);
  });

  it("a replace whose forcing attribute is unknown names the upstream replacement", () => {
    const instance = rc({
      address: "aws_instance.app",
      actions: ["delete", "create"],
      actionReason: "replace_because_cannot_update",
      replacePaths: [["subnet_id"]],
      before: { subnet_id: "subnet-1", tags: { Name: "app" } },
      after: { tags: { Name: "app" } },
      afterUnknown: { subnet_id: true },
    });
    const mods = {
      ...modules,
      "": configModule(
        [],
        [
          configResource("aws_instance.app", {
            subnet_id: { references: ["module.vpc.subnet_id", "module.vpc"] },
          }),
        ],
      ),
    };
    const s = scoreChange(instance, plan([subnet, instance], { modules: mods }));
    expect(s.severity).toBe("high");
    expect(s.signals[0]?.reason).toMatch(
      /^subnet_id follows module\.vpc\.aws_subnet\.private, which is replaced, and an instance cannot move to another subnet/,
    );
  });
});

describe("other actions", () => {
  it("a plain create is low; a create that opens the world is not", () => {
    expect(
      score(
        rc({ address: "aws_ssm_parameter.p", actions: ["create"], after: { name: "/x", type: "String" } }),
      ),
    ).toMatchObject({
      severity: "low",
      signals: [],
    });
    const open = score(
      rc({
        address: "aws_security_group.web",
        actions: ["create"],
        after: { ingress: [{ from_port: 22, to_port: 22, protocol: "tcp", cidr_blocks: ["0.0.0.0/0"] }] },
      }),
    );
    expect(open.severity).toBe("critical");
  });

  it("an in-place update with no matching rule is low with no signals", () => {
    expect(
      score(
        rc({ address: "aws_lambda_function.f", before: { memory_size: 128 }, after: { memory_size: 256 } }),
      ),
    ).toMatchObject({
      severity: "low",
      signals: [],
    });
  });

  it("a password change is high and its reason hides the value", () => {
    const s = score(
      rc({
        address: "aws_rds_cluster.c",
        before: { master_password: SENSITIVE_PLACEHOLDER },
        after: { master_password: SENSITIVE_PLACEHOLDER },
        sensitiveChangedPaths: [["master_password"]],
      }),
    );
    expect(s.severity).toBe("high");
    expect(JSON.stringify(s.signals)).not.toContain(SENSITIVE_PLACEHOLDER);
  });
});

describe("scorePlan ordering and scores", () => {
  it("drops no-ops, sorts by score then address, and keeps severity dominant", () => {
    const changes = [
      tagsUpdate("aws_sqs_queue.b"),
      tagsUpdate("aws_sqs_queue.a"),
      rc({ address: "aws_ssm_parameter.p", actions: ["no-op"], before: {}, after: {} }),
      rc({ address: "aws_lambda_function.f", before: { memory_size: 1 }, after: { memory_size: 2 } }),
      rc({ address: "aws_db_instance.db", actions: ["delete"], before: dbBefore }),
      rc({ address: "aws_iam_role.r", actions: ["delete"], before: { name: "r" } }),
    ];
    const scored = scorePlan(plan(changes));
    expect(scored.map((s) => s.change.address)).toEqual([
      "aws_db_instance.db",
      "aws_iam_role.r",
      "aws_lambda_function.f",
      "aws_sqs_queue.a",
      "aws_sqs_queue.b",
    ]);
    expect(scored.map((s) => s.severity)).toEqual(["critical", "high", "low", "noise", "noise"]);
    const [critical, high, low, noise] = scored;
    expect(critical!.score).toBeGreaterThanOrEqual(1000);
    expect(critical!.score).toBeLessThan(1001);
    expect(high!.score).toBeGreaterThanOrEqual(100);
    expect(low!.score).toBeGreaterThanOrEqual(1);
    expect(noise!.score).toBeLessThan(1);
  });

  it("is deterministic", () => {
    const changes = [
      tagsUpdate("aws_sqs_queue.z"),
      tagsUpdate("aws_sqs_queue.y"),
      tagsUpdate("aws_sqs_queue.x"),
    ];
    const a = scorePlan(plan(changes)).map((s) => s.change.address);
    const b = scorePlan(plan([...changes].reverse())).map((s) => s.change.address);
    expect(a).toEqual(b);
  });

  it("signals are ordered worst first", () => {
    const s = score(
      rc({
        address: "aws_ssm_parameter.p[0]",
        actions: ["delete"],
        actionReason: "delete_because_count_index",
        before: { name: "x" },
      }),
      [
        ...[1, 2, 3, 4].map((i) =>
          rc({ address: `aws_ssm_parameter.q${i}`, actions: ["delete"], before: { name: `q${i}` } }),
        ),
      ],
    );
    const ranks = s.signals.map((x) => ["critical", "high", "medium", "low", "noise"].indexOf(x.severity));
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });
});

describe("escalateForLineage (PLAN-03)", () => {
  const lineage = (explanation: Lineage["explanation"]): Lineage => ({
    address: "x",
    attribute: [],
    steps: [],
    rootCauseIds: [],
    explanation,
    notes: [],
  });
  const roleReplace = rc({
    address: "aws_iam_role.r",
    actions: ["delete", "create"],
    actionReason: "replace_because_cannot_update",
    replacePaths: [["name"]],
    before: { name: "a" },
    after: { name: "b" },
  });
  const paramDelete = rc({ address: "aws_ssm_parameter.p", actions: ["delete"], before: { name: "p" } });
  const bucketDelete = rc({ address: "aws_s3_bucket.b", actions: ["delete"], before: { bucket: "b" } });

  it.each([
    ["a replace explained by nothing (external)", roleReplace, "external", "critical"],
    ["a delete traced to an unknown cause", paramDelete, "unknown", "high"],
    ["a Tier A delete", bucketDelete, "external", "critical"],
  ])("raises %s", (_label, change, explanation, severity) => {
    const s = escalateForLineage(score(change), lineage(explanation as Lineage["explanation"]));
    expect(s.severity).toBe(severity);
    const sig = s.signals.find((x) => x.ruleId === "not-explained-by-diff");
    expect(sig?.reason).toMatch(/^No line in this PR causes this (replacement|deletion)\.$/);
  });

  it("leaves changes the diff explains, updates, and already-escalated changes alone", () => {
    const scored = score(roleReplace);
    expect(escalateForLineage(scored, lineage("diff"))).toBe(scored);
    expect(escalateForLineage(scored, lineage("upstream"))).toBe(scored);
    const upd = score(tagsUpdate("aws_sqs_queue.q"));
    expect(escalateForLineage(upd, lineage("external"))).toBe(upd);
    const once = escalateForLineage(scored, lineage("external"));
    expect(escalateForLineage(once, lineage("external"))).toBe(once);
  });
});

describe("changeKind", () => {
  it.each([
    [tagsUpdate("aws_sqs_queue.q"), "tags only"],
    [
      rc({
        address: "aws_cloudwatch_log_group.l",
        before: { retention_in_days: 30, tags_all: {} },
        after: { retention_in_days: 14, tags_all: { A: "1" } },
      }),
      "retention_in_days",
    ],
    [
      rc({ address: "aws_iam_role.r", before: { description: "a" }, after: { description: "b" } }),
      "description",
    ],
    [rc({ address: "aws_ssm_parameter.p", actions: ["create"], after: {} }), "create aws_ssm_parameter"],
    [
      rc({ address: "aws_s3_bucket.b", actions: ["delete", "create"], before: {}, after: {} }),
      "replace aws_s3_bucket",
    ],
    [rc({ address: "data.aws_ami.x", actions: ["read"], after: {} }), "read data.aws_ami"],
    [
      rc({
        address: "aws_s3_bucket.n",
        actions: ["no-op"],
        previousAddress: "aws_s3_bucket.o",
        before: {},
        after: {},
      }),
      "moved",
    ],
    [
      rc({
        address: "aws_ecs_service.s",
        before: { desired_count: 1, task_definition: "a" },
        after: { desired_count: 0, task_definition: "b" },
      }),
      "desired_count, task_definition",
    ],
  ])("%#: %s", (change, kind) => {
    expect(changeKind(change)).toBe(kind);
  });
});

describe("reasons", () => {
  it("every reason is one sentence without masked placeholders", () => {
    const changes = [
      rc({
        address: "aws_db_instance.db",
        actions: ["delete", "create"],
        actionReason: "replace_because_cannot_update",
        replacePaths: [["storage_encrypted"]],
        before: { ...dbBefore, password: SENSITIVE_PLACEHOLDER },
        after: { ...dbBefore, storage_encrypted: false, password: SENSITIVE_PLACEHOLDER },
      }),
      rc({
        address: "aws_db_instance.db2",
        before: { password: SENSITIVE_PLACEHOLDER, identifier: "a" },
        after: { password: SENSITIVE_PLACEHOLDER, identifier: "b" },
        sensitiveChangedPaths: [["password"]],
      }),
      tagsUpdate("aws_sqs_queue.q"),
    ];
    for (const s of scorePlan(plan(changes))) {
      for (const sig of s.signals) {
        expect(sig.reason).not.toContain(SENSITIVE_PLACEHOLDER);
        expect(sig.reason).toMatch(/[.]$/);
        expect(sig.reason.replace(/\d\.\d|e\.g\.|\.\w/g, "").split(". ").length).toBe(1);
      }
    }
  });
});
