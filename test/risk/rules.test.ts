import { describe, expect, it } from "vitest";
import {
  classify,
  destroySeverity,
  emptyRuleContext,
  evaluateRules,
  explainForceNew,
  fmtValue,
  instanceSizeRank,
  lowerSeverity,
  maxSeverity,
  raiseSeverity,
  transition,
} from "../../src/risk/rules.js";
import type { RuleAction, RuleContext, RuleHit } from "../../src/risk/rules.js";
import { SENSITIVE_PLACEHOLDER } from "../../src/types.js";
import type { ResourceChange } from "../../src/types.js";
import { policyJson, rc } from "./helpers.js";

function hits(change: ResourceChange, ctx: Partial<RuleContext> = {}): RuleHit[] {
  const action: RuleAction =
    change.action === "create"
      ? "create"
      : change.action === "replace"
        ? "replace"
        : change.action === "import"
          ? "import"
          : "update";
  return evaluateRules({
    change,
    action,
    before: (change.before ?? {}) as Record<string, unknown>,
    after: (change.after ?? {}) as Record<string, unknown>,
    ctx: { ...emptyRuleContext(), ...ctx },
  });
}

const update = (address: string, before: unknown, after: unknown, extra = {}) =>
  rc({ address, actions: ["update"], before, after, ...extra });
const create = (address: string, after: unknown, extra = {}) =>
  rc({ address, actions: ["create"], after, ...extra });

describe("severity helpers", () => {
  it("orders, raises and lowers", () => {
    expect(maxSeverity("low", "critical", "medium")).toBe("critical");
    expect(maxSeverity()).toBe("noise");
    expect(raiseSeverity("high")).toBe("critical");
    expect(raiseSeverity("critical")).toBe("critical");
    expect(raiseSeverity("noise")).toBe("low");
    expect(lowerSeverity("critical")).toBe("high");
    expect(lowerSeverity("low")).toBe("low");
  });

  it("never prints a masked value as if it were real", () => {
    expect(fmtValue(SENSITIVE_PLACEHOLDER)).toBe("(hidden value)");
    expect(transition(SENSITIVE_PLACEHOLDER, SENSITIVE_PLACEHOLDER)).not.toContain(SENSITIVE_PLACEHOLDER);
    expect(transition("a", undefined, true)).toBe('"a" → (known after apply)');
    expect(fmtValue(["10.0.0.0/8", "0.0.0.0/0"])).toBe('["10.0.0.0/8", "0.0.0.0/0"]');
  });
});

describe("resource classes (PLAN-01)", () => {
  it.each([
    ["aws_db_instance", "A", "critical"],
    ["aws_s3_bucket", "A", "critical"],
    ["aws_dynamodb_table", "A", "critical"],
    ["aws_kms_key", "A", "critical"],
    ["aws_iam_role", "B", "high"],
    ["aws_route53_zone", "B", "critical"],
    ["aws_subnet", "B", "critical"],
    ["aws_security_group", "B", "high"],
    ["aws_instance", "B", "high"],
    ["aws_ssm_parameter", "C", "medium"],
    ["aws_ecs_task_definition", "C", "low"],
    ["azurerm_mssql_server", "A", "critical"],
    ["google_sql_database_instance", "A", "critical"],
    ["google_container_node_pool", "B", "high"],
  ])("%s is Tier %s, %s on destroy", (type, tier, severity) => {
    expect(classify(type).tier).toBe(tier);
    const change = rc({ address: `${type}.x`, actions: ["delete"], before: {} });
    expect(destroySeverity(change, emptyRuleContext())).toBe(severity);
  });

  it("unknown types are cattle named by their type", () => {
    expect(classify("aws_made_up_thing")).toMatchObject({ tier: "C", noun: "aws_made_up_thing" });
  });

  it.each([
    ["aws_s3_bucket", { force_destroy: true }, "critical"],
    ["google_storage_bucket", { force_destroy: false }, "high"],
    ["google_storage_bucket", { force_destroy: true }, "critical"],
    ["aws_secretsmanager_secret", { recovery_window_in_days: 0 }, "critical"],
    ["aws_secretsmanager_secret", { recovery_window_in_days: 30 }, "high"],
    ["aws_ecr_repository", { force_delete: true }, "critical"],
    ["aws_ecr_repository", { force_delete: false }, "high"],
    ["aws_lb", { internal: false }, "critical"],
    ["aws_lb", { internal: true }, "high"],
    ["azurerm_key_vault", { purge_protection_enabled: true }, "high"],
    ["azurerm_key_vault", { purge_protection_enabled: false }, "critical"],
  ])("%s %j destroy severity is %s", (type, before, severity) => {
    expect(
      destroySeverity(rc({ address: `${type}.x`, actions: ["delete"], before }), emptyRuleContext()),
    ).toBe(severity);
  });

  it("an S3 versioning delete is high unless the bucket itself is destroyed too", () => {
    const v = rc({
      address: "aws_s3_bucket_versioning.x",
      actions: ["delete"],
      before: { bucket: "b", versioning_configuration: [{ status: "Enabled" }] },
    });
    expect(destroySeverity(v, emptyRuleContext())).toBe("high");
    expect(destroySeverity(v, { ...emptyRuleContext(), bucketDestroyed: (n) => n === "b" })).toBe("medium");
  });
});

describe("explainForceNew", () => {
  it.each([
    [
      "aws_db_instance",
      ["storage_encrypted"],
      "RDS cannot encrypt or decrypt an existing instance's storage; it creates a new one",
    ],
    ["aws_instance", ["root_block_device", 0, "encrypted"], "root volume encryption is fixed at launch"],
    ["aws_rds_cluster", ["availability_zones"], "perpetual diff"],
    [
      "aws_security_group_rule",
      ["cidr_blocks"],
      "every argument of aws_security_group_rule forces a new rule",
    ],
    ["aws_whatever", ["name"], "cannot be changed in place, so a new one is created"],
    [
      "aws_whatever",
      ["frobnicate", 0, "mode"],
      "frobnicate[0].mode cannot be changed in place, so the provider replaces it",
    ],
  ])("%s %j", (type, path, text) => {
    expect(explainForceNew(type, path)).toContain(text);
  });
});

describe("attribute rules", () => {
  it.each([
    // [label, change, ruleId, severity]
    [
      "RDS deletion protection off",
      update("aws_db_instance.db", { deletion_protection: true }, { deletion_protection: false }),
      "deletion-protection-off",
      "high",
    ],
    [
      "DynamoDB deletion protection off",
      update(
        "aws_dynamodb_table.t",
        { deletion_protection_enabled: true },
        { deletion_protection_enabled: false },
      ),
      "deletion-protection-off",
      "high",
    ],
    [
      "ALB deletion protection off",
      update("aws_lb.lb", { enable_deletion_protection: true }, { enable_deletion_protection: false }),
      "deletion-protection-off",
      "high",
    ],
    [
      "Cloud SQL deletion protection off",
      update(
        "google_sql_database_instance.db",
        { deletion_protection: true },
        { deletion_protection: false },
      ),
      "deletion-protection-off",
      "high",
    ],
    [
      "skip_final_snapshot on",
      update("aws_rds_cluster.c", { skip_final_snapshot: false }, { skip_final_snapshot: true }),
      "final-snapshot-off",
      "high",
    ],
    [
      "backup retention to zero",
      update("aws_db_instance.db", { backup_retention_period: 7 }, { backup_retention_period: 0 }),
      "backups-off",
      "high",
    ],
    [
      "publicly accessible",
      update("aws_db_instance.db", { publicly_accessible: false }, { publicly_accessible: true }),
      "db-public",
      "critical",
    ],
    [
      "replica promoted",
      update("aws_db_instance.r", { replicate_source_db: "primary" }, { replicate_source_db: "" }),
      "replica-promoted",
      "high",
    ],
    [
      "public access block off",
      update(
        "aws_s3_bucket_public_access_block.b",
        { block_public_policy: true },
        { block_public_policy: false },
      ),
      "s3-public-access-block-off",
      "critical",
    ],
    [
      "public-read ACL",
      update("aws_s3_bucket_acl.b", { acl: "private" }, { acl: "public-read" }),
      "s3-public-acl",
      "critical",
    ],
    [
      "versioning suspended",
      update(
        "aws_s3_bucket_versioning.v",
        { versioning_configuration: [{ status: "Enabled" }] },
        { versioning_configuration: [{ status: "Suspended" }] },
      ),
      "versioning-suspended",
      "high",
    ],
    [
      "force_destroy armed",
      update("aws_s3_bucket.b", { force_destroy: false }, { force_destroy: true }),
      "force-destroy-armed",
      "high",
    ],
    [
      "CloudTrail logging off",
      update("aws_cloudtrail.t", { enable_logging: true }, { enable_logging: false }),
      "audit-off",
      "high",
    ],
    [
      "GuardDuty off",
      update("aws_guardduty_detector.d", { enable: true }, { enable: false }),
      "audit-off",
      "high",
    ],
    [
      "ASG to zero",
      update("aws_autoscaling_group.g", { desired_capacity: 3 }, { desired_capacity: 0 }),
      "capacity-zero",
      "high",
    ],
    [
      "node group to zero",
      update(
        "aws_eks_node_group.n",
        { scaling_config: [{ desired_size: 2, min_size: 1 }] },
        { scaling_config: [{ desired_size: 0, min_size: 1 }] },
      ),
      "capacity-zero",
      "high",
    ],
    [
      "Multi-AZ off",
      update("aws_db_instance.db", { multi_az: true }, { multi_az: false }),
      "failover-off",
      "high",
    ],
    [
      "PITR off",
      update(
        "aws_dynamodb_table.t",
        { point_in_time_recovery: [{ enabled: true }] },
        { point_in_time_recovery: [{ enabled: false }] },
      ),
      "pitr-off",
      "high",
    ],
    [
      "stream toggled",
      update("aws_dynamodb_table.t", { stream_enabled: true }, { stream_enabled: false }),
      "stream-changed",
      "high",
    ],
    [
      "EKS upgrade",
      update("aws_eks_cluster.c", { version: "1.30" }, { version: "1.31" }),
      "eks-upgrade",
      "high",
    ],
    [
      "KMS key disabled",
      update("aws_kms_key.k", { is_enabled: true }, { is_enabled: false }),
      "kms-key-disabled",
      "critical",
    ],
    [
      "KMS alias retargeted",
      update("aws_kms_alias.a", { target_key_id: "k1" }, { target_key_id: "k2" }),
      "kms-alias-retarget",
      "high",
    ],
    [
      "CloudFront WAF detached",
      update("aws_cloudfront_distribution.d", { web_acl_id: "arn:waf" }, { web_acl_id: "" }),
      "waf-detached",
      "high",
    ],
    [
      "Azure HTTPS-only off",
      update(
        "azurerm_storage_account.s",
        { https_traffic_only_enabled: true },
        { https_traffic_only_enabled: false },
      ),
      "storage-https-off",
      "high",
    ],
    [
      "GCS public access prevention off",
      update(
        "google_storage_bucket.b",
        { public_access_prevention: "enforced" },
        { public_access_prevention: "inherited" },
      ),
      "bucket-public-access-prevention-off",
      "high",
    ],
    [
      "ECS service new task definition",
      update("aws_ecs_service.s", { task_definition: "app:1" }, { task_definition: "app:2" }),
      "ecs-rolling-deploy",
      "medium",
    ],
  ])("%s", (_label, change, ruleId, severity) => {
    expect(hits(change)).toContainEqual(expect.objectContaining({ ruleId, severity }));
  });

  it("deletion guard off escalates to critical when the plan also destroys the same resource config", () => {
    const change = update(
      "aws_db_instance.db",
      { deletion_protection: true },
      { deletion_protection: false },
    );
    const found = hits(change, { destroysSameConfig: () => true });
    expect(found[0]).toMatchObject({ ruleId: "deletion-protection-off", severity: "critical" });
    expect(found[0]?.reason).toContain("this plan also destroys it");
  });

  it("guards turning on, or staying on, are not flagged", () => {
    expect(
      hits(update("aws_db_instance.db", { deletion_protection: false }, { deletion_protection: true })),
    ).toEqual([]);
    expect(
      hits(
        update(
          "aws_db_instance.db",
          { deletion_protection: true, x: 1 },
          { deletion_protection: true, x: 2 },
        ),
      ),
    ).toEqual([]);
  });

  it("skips attributes that are unknown after apply", () => {
    const change = rc({
      address: "aws_db_instance.db",
      before: { publicly_accessible: false },
      after: {},
      afterUnknown: { publicly_accessible: true },
    });
    expect(hits(change)).toEqual([]);
  });

  it("exposure rules fire on creates; in-place-only rules do not", () => {
    expect(hits(create("aws_db_instance.db", { publicly_accessible: true }))).toContainEqual(
      expect.objectContaining({ ruleId: "db-public", severity: "critical" }),
    );
    expect(hits(create("aws_s3_bucket.b", { force_destroy: true }))).toEqual([]);
    expect(hits(create("aws_autoscaling_group.g", { desired_capacity: 0 }))).toEqual([]);
  });
});

describe("security group ingress (AWS-U07)", () => {
  const ingress = (port: number, cidrs: string[], protocol = "tcp", to = port) => ({
    cidr_blocks: cidrs,
    ipv6_cidr_blocks: [],
    description: "x",
    from_port: port,
    to_port: to,
    protocol,
    self: false,
    security_groups: [],
    prefix_list_ids: [],
  });
  const sg = (rules: unknown[]) => ({ name: "db", ingress: rules });

  it.each([
    ["5432 (PostgreSQL)", ingress(5432, ["0.0.0.0/0"]), "critical", /PostgreSQL/],
    ["22 (SSH) via a range", ingress(20, ["0.0.0.0/0"], "tcp", 25), "critical", /SSH/],
    ["all protocols", ingress(0, ["0.0.0.0/0"], "-1", 0), "critical", /all traffic/],
    ["IPv6 ::/0 on 3306", { ...ingress(3306, []), ipv6_cidr_blocks: ["::/0"] }, "critical", /MySQL/],
    ["443", ingress(443, ["0.0.0.0/0"]), "low", /normal for a public web endpoint/],
    ["80", ingress(80, ["0.0.0.0/0"]), "low", /port 80/],
    ["8080", ingress(8080, ["0.0.0.0/0"]), "high", /port 8080/],
  ])("inline ingress opening %s", (_label, rule, severity, text) => {
    const change = update(
      "aws_security_group.db",
      sg([ingress(5432, ["10.0.0.0/16"])]),
      sg([ingress(5432, ["10.0.0.0/16"]), rule]),
    );
    const found = hits(change).find((h) => h.ruleId === "sg-open-world");
    expect(found?.severity).toBe(severity);
    expect(found?.reason).toMatch(text);
  });

  it("ignores a rule that was already open, and a reordered rule set", () => {
    const open = ingress(443, ["0.0.0.0/0"]);
    const inner = ingress(5432, ["10.0.0.0/16"]);
    expect(hits(update("aws_security_group.db", sg([open, inner]), sg([inner, open])))).toEqual([]);
  });

  it("a new aws_security_group_rule (create) that opens SSH is critical", () => {
    const change = create("aws_security_group_rule.ssh", {
      type: "ingress",
      from_port: 22,
      to_port: 22,
      protocol: "tcp",
      cidr_blocks: ["0.0.0.0/0"],
    });
    expect(hits(change)).toContainEqual(
      expect.objectContaining({ ruleId: "sg-open-world", severity: "critical" }),
    );
  });

  it("egress rules are not ingress", () => {
    const change = create("aws_security_group_rule.out", {
      type: "egress",
      from_port: 0,
      to_port: 0,
      protocol: "-1",
      cidr_blocks: ["0.0.0.0/0"],
    });
    expect(hits(change)).toEqual([]);
  });

  it("a new aws_vpc_security_group_ingress_rule open to the world on 6379", () => {
    const change = create("aws_vpc_security_group_ingress_rule.redis", {
      cidr_ipv4: "0.0.0.0/0",
      ip_protocol: "tcp",
      from_port: 6379,
      to_port: 6379,
    });
    expect(hits(change)[0]).toMatchObject({ ruleId: "sg-open-world", severity: "critical" });
    expect(hits(change)[0]?.reason).toContain("Redis");
  });

  it("a GCP firewall and an Azure NSG rule are judged the same way", () => {
    const fw = create("google_compute_firewall.ssh", {
      direction: "INGRESS",
      source_ranges: ["0.0.0.0/0"],
      allow: [{ protocol: "tcp", ports: ["22"] }],
    });
    const nsg = create("azurerm_network_security_rule.rdp", {
      direction: "Inbound",
      access: "Allow",
      protocol: "Tcp",
      source_address_prefix: "*",
      destination_port_range: "3389",
    });
    expect(hits(fw)[0]?.severity).toBe("critical");
    expect(hits(nsg)[0]?.severity).toBe("critical");
  });
});

describe("change rules", () => {
  it("IAM policy wildcard is critical (AWS-U08)", () => {
    const before = policyJson([{ Effect: "Allow", Action: ["s3:GetObject"], Resource: "arn:aws:s3:::r/*" }]);
    const after = policyJson([{ Effect: "Allow", Action: "s3:*", Resource: "*" }]);
    expect(hits(update("aws_iam_policy.p", { policy: before }, { policy: after }))[0]).toMatchObject({
      ruleId: "iam-wildcard",
      severity: "critical",
    });
  });

  it("role inline_policy blocks are analyzed together", () => {
    const st = (a: string) => ({ Effect: "Allow", Action: a, Resource: "*" });
    const change = update(
      "aws_iam_role.r",
      { inline_policy: [{ name: "a", policy: policyJson([st("logs:PutLogEvents")]) }] },
      {
        inline_policy: [
          { name: "a", policy: policyJson([st("logs:PutLogEvents")]) },
          { name: "b", policy: policyJson([st("*")]) },
        ],
      },
    );
    expect(hits(change)).toContainEqual(
      expect.objectContaining({ ruleId: "iam-wildcard", severity: "critical" }),
    );
  });

  it("a bucket policy granting Principal * is critical (AWS-U05)", () => {
    const after = policyJson([
      { Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: "arn:aws:s3:::b/*" },
    ]);
    expect(hits(create("aws_s3_bucket_policy.p", { bucket: "b", policy: after }))[0]).toMatchObject({
      ruleId: "policy-public",
      severity: "critical",
    });
  });

  it("an unknown policy is skipped rather than guessed", () => {
    const change = rc({
      address: "aws_iam_policy.p",
      before: { policy: policyJson([]) },
      after: {},
      afterUnknown: { policy: true },
    });
    expect(hits(change)).toEqual([]);
  });

  it("admin managed policy attachment is critical", () => {
    const change = create("aws_iam_role_policy_attachment.a", {
      role: "ci",
      policy_arn: "arn:aws:iam::aws:policy/AdministratorAccess",
    });
    expect(hits(change)[0]).toMatchObject({ ruleId: "admin-policy-attached", severity: "critical" });
    expect(hits(change)[0]?.reason).toContain("AdministratorAccess is attached to ci");
  });

  it("KMS key policy change is high unless only formatting differs (AWS-15)", () => {
    const p1 = policyJson([
      {
        Effect: "Allow",
        Principal: { AWS: "arn:aws:iam::111122223333:root" },
        Action: "kms:*",
        Resource: "*",
      },
    ]);
    const p2 = policyJson([
      {
        Effect: "Allow",
        Principal: { AWS: "arn:aws:iam::111122223333:role/x" },
        Action: "kms:*",
        Resource: "*",
      },
    ]);
    expect(hits(update("aws_kms_key.k", { policy: p1 }, { policy: p2 }))).toContainEqual(
      expect.objectContaining({ ruleId: "kms-policy-changed", severity: "high" }),
    );
    const reformatted = JSON.stringify(JSON.parse(p1), null, 4);
    expect(hits(update("aws_kms_key.k", { policy: p1 }, { policy: reformatted }))).toEqual([]);
  });

  it("aws_db_instance identifier rename is high: in place, endpoint changes (AWS-02)", () => {
    const found = hits(
      update(
        "aws_db_instance.db",
        { identifier: "orders" },
        { identifier: "orders-v2", apply_immediately: true },
      ),
    );
    expect(found).toContainEqual(
      expect.objectContaining({ ruleId: "db-identifier-rename", severity: "high" }),
    );
    expect(found.find((h) => h.ruleId === "db-identifier-rename")?.reason).toMatch(
      /endpoint hostname changes/,
    );
  });

  it.each([
    [
      "apply_immediately true",
      { instance_class: "db.r6g.large" },
      { instance_class: "db.r6g.xlarge", apply_immediately: true },
      "high",
      /during this apply/,
    ],
    [
      "apply_immediately false",
      { instance_class: "db.r6g.large" },
      { instance_class: "db.r6g.xlarge", apply_immediately: false },
      "medium",
      /maintenance window/,
    ],
    [
      "a downsize",
      { instance_class: "db.r6g.2xlarge" },
      { instance_class: "db.r6g.large" },
      "high",
      /shrinks the instance/,
    ],
    ["engine_version", { engine_version: "15.4" }, { engine_version: "16.1" }, "medium", /engine_version/],
  ])("RDS downtime change with %s (AWS-U03)", (_label, before, after, severity, text) => {
    const found = hits(update("aws_db_instance.db", before, after)).find((h) => h.ruleId === "db-downtime");
    expect(found?.severity).toBe(severity);
    expect(found?.reason).toMatch(text);
  });

  it("instance size ranks", () => {
    expect(instanceSizeRank("db.r6g.large")).toEqual({ family: "db.r6g", rank: 4 });
    expect(instanceSizeRank("db.r6g.4xlarge")).toEqual({ family: "db.r6g", rank: 7 });
    expect(instanceSizeRank("db.t3.micro")).toEqual({ family: "db.t3", rank: 1 });
    expect(instanceSizeRank("weird")).toBeNull();
  });

  it("a credential change is high and never prints the value (AWS-U04)", () => {
    const change = rc({
      address: "aws_db_instance.db",
      before: { password: SENSITIVE_PLACEHOLDER },
      after: { password: SENSITIVE_PLACEHOLDER },
      sensitiveChangedPaths: [["password"]],
    });
    const found = hits(change);
    expect(found).toContainEqual(expect.objectContaining({ ruleId: "credential-change", severity: "high" }));
    expect(found.map((h) => h.reason).join(" ")).not.toContain(SENSITIVE_PLACEHOLDER);
  });

  it("an expiration lifecycle rule on an existing bucket is high; on a new bucket it is setup", () => {
    const after = { bucket: "data", rule: [{ id: "expire", status: "Enabled", expiration: [{ days: 30 }] }] };
    expect(hits(create("aws_s3_bucket_lifecycle_configuration.l", after))[0]).toMatchObject({
      ruleId: "lifecycle-expiration",
      severity: "high",
    });
    expect(
      hits(create("aws_s3_bucket_lifecycle_configuration.l", after), { bucketCreated: () => true }),
    ).toEqual([]);
    const shorter = { ...after, rule: [{ id: "expire", status: "Enabled", expiration: [{ days: 7 }] }] };
    expect(hits(update("aws_s3_bucket_lifecycle_configuration.l", after, shorter))[0]?.reason).toContain(
      "(was 30 days)",
    );
    expect(hits(update("aws_s3_bucket_lifecycle_configuration.l", shorter, after))).toEqual([]);
  });

  it("a Cognito schema attribute change fails at apply (AWS-23)", () => {
    const attr = (mutable: boolean) => ({ name: "email", attribute_data_type: "String", mutable });
    expect(
      hits(update("aws_cognito_user_pool.p", { schema: [attr(true)] }, { schema: [attr(false)] }))[0],
    ).toMatchObject({
      ruleId: "cognito-schema-change",
      severity: "high",
    });
  });

  it("instance type change stops a singleton instance (AWS-U12)", () => {
    const change = update(
      "aws_instance.app",
      { instance_type: "m7g.large" },
      { instance_type: "m7g.xlarge" },
    );
    expect(hits(change)[0]).toMatchObject({ ruleId: "instance-stop-start", severity: "high" });
    expect(hits(change, { siblingCount: () => 3 })[0]?.severity).toBe("medium");
  });

  it.each([
    [
      "a shorter log retention",
      "aws_cloudwatch_log_group.l",
      { retention_in_days: 30 },
      { retention_in_days: 7 },
      true,
    ],
    [
      "never-expire to 30 days",
      "aws_cloudwatch_log_group.l",
      { retention_in_days: 0 },
      { retention_in_days: 30 },
      true,
    ],
    [
      "a longer log retention",
      "aws_cloudwatch_log_group.l",
      { retention_in_days: 7 },
      { retention_in_days: 30 },
      false,
    ],
    [
      "a shorter SQS retention",
      "aws_sqs_queue.q",
      { message_retention_seconds: 345600 },
      { message_retention_seconds: 86400 },
      true,
    ],
  ])("retention decrease: %s", (_label, address, before, after, flagged) => {
    const found = hits(update(address, before, after)).filter((h) => h.ruleId === "retention-decrease");
    expect(found.length > 0).toBe(flagged);
    if (flagged) expect(found[0]?.severity).toBe("medium");
  });

  it("GCP: public Cloud SQL and public bucket IAM are critical", () => {
    const sql = update(
      "google_sql_database_instance.db",
      {
        settings: [
          { ip_configuration: [{ ipv4_enabled: true, authorized_networks: [{ value: "10.0.0.0/8" }] }] },
        ],
      },
      {
        settings: [
          { ip_configuration: [{ ipv4_enabled: true, authorized_networks: [{ value: "0.0.0.0/0" }] }] },
        ],
      },
    );
    expect(hits(sql)[0]).toMatchObject({ ruleId: "db-public", severity: "critical" });
    const iam = create("google_storage_bucket_iam_member.m", {
      role: "roles/storage.objectViewer",
      member: "allUsers",
    });
    expect(hits(iam)[0]).toMatchObject({ ruleId: "bucket-public-iam", severity: "critical" });
  });

  it("minimum TLS lowered", () => {
    const found = hits(
      update("azurerm_storage_account.s", { min_tls_version: "TLS1_2" }, { min_tls_version: "TLS1_0" }),
    );
    expect(found[0]).toMatchObject({ ruleId: "tls-lowered", severity: "high" });
  });

  it("only source_code_hash on a Lambda is a low code deploy (NOISE-03)", () => {
    const found = hits(update("aws_lambda_function.f", { source_code_hash: "a" }, { source_code_hash: "b" }));
    expect(found).toEqual([expect.objectContaining({ ruleId: "code-deploy", severity: "low" })]);
  });
});
