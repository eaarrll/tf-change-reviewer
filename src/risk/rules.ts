/*
 * Materiality rules as data. Every entry cites its rule id in docs/research-risk-taxonomy.md
 * (PLAN-xx plan-level, AWS-xx replacement, AWS-Uxx in-place, AZ-/GCP- other clouds, NOISE-xx).
 *
 * - RESOURCE_CLASSES: Tier A data-holding / Tier B identity-addressing / Tier C cattle, with the
 *   destroy severity and what a destroy costs (PLAN-01 and the per-type rules).
 * - FORCE_NEW: type → attribute → why it cannot change in place; explains replace_paths. replace_paths
 *   stays the source of truth for *what* forced a replacement; this table only says *why*.
 * - ATTRIBUTE_RULES / CHANGE_RULES: in-place risks as small predicates over before/after.
 * - Noise: tags-only, description-only, longer retention, re-formatted policy JSON, known perpetual
 *   diffs (NOISE-01..05).
 *
 * Values reaching these rules are already masked (plan/mask.ts); reasons print a hidden value as
 * "(hidden value)", never as if it were real.
 */
import { deepEqual, formatPath, getAtPath, isPrefix, pathKey } from "../plan/paths.js";
import { SENSITIVE_PLACEHOLDER, SEVERITY_ORDER } from "../types.js";
import type { AttrPath, ResourceChange, RiskSignal, Severity } from "../types.js";
import {
  POLICY_ATTRIBUTES,
  POLICY_ATTRIBUTE_NAMES,
  analyzePolicyChange,
  isAdminPolicyArn,
  mergePolicyDocuments,
  parsePolicyDocument,
  policiesEquivalent,
  stableStringify,
} from "./policy.js";

// ───────────────────────────── types ─────────────────────────────

export type Tier = "A" | "B" | "C";
/** What a destroy costs. create_before_destroy softens "outage" by one level, never the others (PLAN-01). */
export type Impact = "data-loss" | "identity" | "outage";
/** Actions a rule looks at ("import" = an import that also updates). */
export type RuleAction = "create" | "update" | "replace" | "import";

export type Rec = Record<string, unknown>;

/** Plan-wide facts some rules need. Built by risk/score.ts; `emptyRuleContext()` for isolated use. */
export interface RuleContext {
  /** Instances in the plan (no-ops included) with the same module instance, type and name. */
  siblingCount(change: ResourceChange): number;
  /** True when the plan deletes or replaces an instance of the same resource config. */
  destroysSameConfig(change: ResourceChange): boolean;
  /** True when the plan deletes or replaces an aws_s3_bucket with this bucket name. */
  bucketDestroyed(name: string): boolean;
  /** True when the plan creates (or replaces) an aws_s3_bucket with this bucket name. */
  bucketCreated(name: string): boolean;
  /** AWS account ids seen in ARNs anywhere in the plan. */
  knownAccounts: ReadonlySet<string>;
  /** Lower-cased tag keys that drive behaviour (ABAC conditions, backup selections). NOISE-01. */
  functionalTagKeys: ReadonlySet<string>;
  /** Security group ids that separate rule resources also manage. NOISE-05. */
  ruleManagedGroups: ReadonlySet<string>;
}

export function emptyRuleContext(): RuleContext {
  return {
    siblingCount: () => 1,
    destroysSameConfig: () => false,
    bucketDestroyed: () => false,
    bucketCreated: () => false,
    knownAccounts: new Set(),
    functionalTagKeys: new Set(),
    ruleManagedGroups: new Set(),
  };
}

export interface RuleHit {
  ruleId: string;
  severity: Severity;
  reason: string;
  path?: AttrPath;
}

export interface RuleInput {
  change: ResourceChange;
  /** The action this evaluation stands for ("import" when importing with an update). */
  action: RuleAction;
  /** `change.before` / `change.after` as objects ({} when null). */
  before: Rec;
  after: Rec;
  ctx: RuleContext;
}

/** One attribute, one predicate: the shape most in-place rules take. */
export interface AttributeRule {
  /** Taxonomy rule id, e.g. "AWS-U01". */
  id: string;
  /** Signal rule id, e.g. "deletion-protection-off". */
  ruleId: string;
  types: readonly string[];
  /** Attribute path; "*" matches any list index (nested blocks). */
  path: AttrPath;
  /** Default ["update"]. */
  on?: readonly RuleAction[];
  when(before: unknown, after: unknown, input: RuleInput): boolean;
  severity: Severity | ((input: RuleInput) => Severity);
  reason(x: { attr: string; before: unknown; after: unknown; input: RuleInput }): string;
}

/** A rule that needs the whole change (sets of rules, policies, several attributes at once). */
export interface ChangeRule {
  id: string;
  types: readonly string[];
  on?: readonly RuleAction[];
  evaluate(input: RuleInput): RuleHit[];
}

// ───────────────────────────── severity helpers ─────────────────────────────

export const SEVERITY_WEIGHT: Readonly<Record<Severity, number>> = {
  critical: 1000,
  high: 100,
  medium: 10,
  low: 1,
  noise: 0,
};

/** 0 = critical … 4 = noise. */
export function severityRank(s: Severity): number {
  return SEVERITY_ORDER.indexOf(s);
}

export function maxSeverity(...list: Severity[]): Severity {
  let best: Severity = "noise";
  for (const s of list) if (severityRank(s) < severityRank(best)) best = s;
  return best;
}

/** One level up, capped at critical; noise goes to low. */
export function raiseSeverity(s: Severity): Severity {
  if (s === "noise") return "low";
  return SEVERITY_ORDER[Math.max(0, severityRank(s) - 1)] ?? s;
}

/** One level down, floored at low (a real change never becomes noise this way). */
export function lowerSeverity(s: Severity): Severity {
  if (s === "noise" || s === "low") return s;
  return SEVERITY_ORDER[severityRank(s) + 1] ?? s;
}

// ───────────────────────────── value helpers ─────────────────────────────

export function isObject(v: unknown): v is Rec {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function asRecord(v: unknown): Rec {
  return isObject(v) ? v : {};
}

function isScalar(v: unknown): boolean {
  return v === null || v === undefined || typeof v !== "object";
}

/** A value as a reviewer reads it; hidden values never print as if real. */
export function fmtValue(v: unknown): string {
  if (v === SENSITIVE_PLACEHOLDER) return "(hidden value)";
  if (v === undefined || v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v.length > 60 ? `${v.slice(0, 57)}...` : v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    if (v.every(isScalar)) {
      const shown = v.slice(0, 4).map(fmtValue).join(", ");
      return `[${shown}${v.length > 4 ? `, … ${v.length - 4} more` : ""}]`;
    }
    return `${v.length} block${v.length === 1 ? "" : "s"}`;
  }
  return "{…}";
}

export function transition(before: unknown, after: unknown, afterUnknown = false): string {
  return `${fmtValue(before)} → ${afterUnknown ? "(known after apply)" : fmtValue(after)}`;
}

/** True when after_unknown marks `path` (or a prefix of it) unknown. */
export function isUnknownAt(afterUnknown: unknown, path: AttrPath): boolean {
  let cur = afterUnknown;
  for (const step of path) {
    if (cur === true) return true;
    if (cur === null || typeof cur !== "object") return false;
    cur = (cur as Record<string | number, unknown>)[step];
  }
  return cur === true;
}

/** Concrete paths matching `pattern` ("*" = any list index) in any of the values. */
export function expandPattern(values: readonly unknown[], pattern: AttrPath): AttrPath[] {
  const out = new Map<string, AttrPath>();
  const visit = (v: unknown, i: number, prefix: AttrPath): void => {
    if (i === pattern.length) {
      out.set(pathKey(prefix), prefix);
      return;
    }
    const step = pattern[i]!;
    if (step === "*") {
      if (Array.isArray(v)) v.forEach((x, k) => visit(x, i + 1, [...prefix, k]));
      return;
    }
    if (typeof step === "number") {
      if (Array.isArray(v) && step < v.length) visit(v[step], i + 1, [...prefix, step]);
      return;
    }
    if (isObject(v) && step in v) visit(v[step], i + 1, [...prefix, step]);
  };
  for (const v of values) visit(v, 0, []);
  return [...out.values()];
}

function nonEmpty(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (isObject(v)) return Object.keys(v).length > 0;
  return true;
}

/** Last string step of a path: the attribute name a reviewer recognizes. */
export function leafName(path: AttrPath): string {
  for (let i = path.length - 1; i >= 0; i--) {
    const step = path[i];
    if (typeof step === "string") return step;
  }
  return "";
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

// ───────────────────────────── resource classes (PLAN-01) ─────────────────────────────

export interface ResourceClass {
  tier: Tier;
  impact: Impact;
  /** Plain noun used in reasons, e.g. "RDS database". */
  noun: string;
  /** Taxonomy rule id. */
  rule: string;
  /** Delete/replace severity when it differs from the tier default (A critical, B high, C medium). */
  destroy?: Severity | ((before: Rec, ctx: RuleContext) => Severity);
  /** What a destroy costs, as a clause ("every object in it is deleted"). */
  loss?: string | ((before: Rec, after?: Rec) => string);
}

export const TIER_DESTROY_SEVERITY: Readonly<Record<Tier, Severity>> = {
  A: "critical",
  B: "high",
  C: "medium",
};

const DATA_LOSS = "the data it holds is lost unless it is restored from a backup";
const IDENTITY_LOSS = "its ARN, endpoint or address changes, so anything that points at it breaks";

const A = (noun: string, rule: string, extra: Partial<ResourceClass> = {}): ResourceClass => ({
  tier: "A",
  impact: "data-loss",
  noun,
  rule,
  ...extra,
});
const B = (noun: string, rule: string, extra: Partial<ResourceClass> = {}): ResourceClass => ({
  tier: "B",
  impact: "identity",
  noun,
  rule,
  ...extra,
});
const C = (noun: string, rule: string, extra: Partial<ResourceClass> = {}): ResourceClass => ({
  tier: "C",
  impact: "outage",
  noun,
  rule,
  ...extra,
});

const LB_LOSS =
  "traffic stops until the new one and its listeners exist; DNS records this plan manages follow its new dns_name on apply, but anything else pointing at the old name (CNAMEs elsewhere, partner allowlists) breaks";

const rdsLoss = (b: Rec, a: Rec = {}): string => {
  const snap = a.snapshot_identifier;
  if (
    typeof snap === "string" &&
    snap !== "" &&
    snap !== b.snapshot_identifier &&
    !snap.includes("(sensitive)")
  )
    return `the new one is restored from snapshot ${snap}, so everything written since that snapshot was taken is lost`;
  return b.skip_final_snapshot === true
    ? "its data is lost: skip_final_snapshot is true, so no final snapshot is taken"
    : "the new one starts empty; the data survives only in the final snapshot, which has to be restored by hand";
};
const bucketLoss = (b: Rec): string =>
  b.force_destroy === true
    ? "force_destroy is on, so every object in it (all versions) is deleted and cannot be recovered"
    : "the destroy fails while the bucket still holds objects (emptying it to let the destroy through loses every object)";

/** Resource classes by type. Types not listed are Tier C cattle (medium on destroy). */
export const RESOURCE_CLASSES: Readonly<Record<string, ResourceClass>> = {
  // ── AWS Tier A: data-holding ──
  aws_db_instance: A("RDS database", "AWS-01", { loss: rdsLoss }), // AWS-01
  aws_rds_cluster: A("Aurora/RDS cluster", "AWS-03", { loss: rdsLoss }), // AWS-03
  aws_rds_global_cluster: A("RDS global cluster", "AWS-03"),
  aws_docdb_cluster: A("DocumentDB cluster", "AWS-12", { loss: rdsLoss }), // AWS-12
  aws_neptune_cluster: A("Neptune cluster", "AWS-12", { loss: rdsLoss }),
  aws_redshift_cluster: A("Redshift cluster", "AWS-12", { loss: rdsLoss }),
  aws_redshiftserverless_namespace: A("Redshift Serverless namespace", "AWS-12"),
  aws_dynamodb_table: A("DynamoDB table", "AWS-05", { loss: "every item in it is deleted" }), // AWS-05
  aws_dynamodb_global_table: A("DynamoDB global table", "AWS-05", { loss: "every item in it is deleted" }),
  aws_s3_bucket: A("S3 bucket", "AWS-06", { loss: bucketLoss }), // AWS-06
  aws_s3_directory_bucket: A("S3 directory bucket", "AWS-06", { loss: bucketLoss }),
  aws_ebs_volume: A("EBS volume", "AWS-08", { loss: "the block data on it is destroyed" }), // AWS-08
  aws_efs_file_system: A("EFS file system", "AWS-08", { loss: "every file on it is destroyed" }),
  aws_fsx_lustre_file_system: A("FSx file system", "AWS-08"),
  aws_fsx_windows_file_system: A("FSx file system", "AWS-08"),
  aws_fsx_ontap_file_system: A("FSx file system", "AWS-08"),
  aws_fsx_openzfs_file_system: A("FSx file system", "AWS-08"),
  aws_memorydb_cluster: A("MemoryDB cluster", "AWS-10"), // AWS-10
  aws_opensearch_domain: A("OpenSearch domain", "AWS-11", { loss: "every index in it is lost" }), // AWS-11
  aws_elasticsearch_domain: A("Elasticsearch domain", "AWS-11", { loss: "every index in it is lost" }),
  aws_msk_cluster: A("MSK (Kafka) cluster", "AWS-13", {
    loss: "every topic and retained message is lost and the bootstrap brokers change",
  }), // AWS-13
  aws_msk_serverless_cluster: A("MSK (Kafka) cluster", "AWS-13"),
  aws_kms_key: A("KMS key", "AWS-15", {
    loss: "the key is disabled at once and scheduled for deletion, so every encrypt and decrypt with it fails from this apply on, and once the waiting period ends everything encrypted with it is unreadable for good",
  }), // AWS-15
  aws_cognito_user_pool: A("Cognito user pool", "AWS-23", {
    loss: "every user, password hash and MFA enrolment is lost and cannot be exported",
  }), // AWS-23
  aws_backup_vault: A("AWS Backup vault", "AWS-24", {
    destroy: (b) => (b.force_destroy === true ? "critical" : "high"),
    loss: (b) =>
      b.force_destroy === true
        ? "force_destroy is on, so every recovery point in it is deleted"
        : "its recovery points are at risk (the destroy fails while it holds recovery points)",
  }), // AWS-24
  aws_ecr_repository: A("ECR repository", "AWS-24", {
    destroy: (b) => (b.force_delete === true ? "critical" : "high"),
    loss: (b) =>
      b.force_delete === true
        ? "force_delete is on, so every image in it is deleted"
        : "its images are at risk (the destroy fails while it holds images)",
  }),
  aws_db_snapshot: A("RDS snapshot", "AWS-01", { loss: "the recovery point is deleted" }),
  aws_db_cluster_snapshot: A("RDS cluster snapshot", "AWS-03", { loss: "the recovery point is deleted" }),
  aws_ebs_snapshot: A("EBS snapshot", "AWS-08", { loss: "the recovery point is deleted" }),
  aws_timestreamwrite_table: A("Timestream table", "PLAN-01"),
  aws_keyspaces_table: A("Keyspaces table", "PLAN-01"),
  aws_qldb_ledger: A("QLDB ledger", "PLAN-01"),
  aws_glacier_vault: A("Glacier vault", "PLAN-01"),
  // ── AWS Tier B: identity / addressing ──
  aws_rds_cluster_instance: B("Aurora instance", "AWS-04", {
    impact: "outage",
    loss: "its endpoint goes away and replacing the writer forces a failover",
  }), // AWS-04
  aws_elasticache_replication_group: B("ElastiCache replication group", "AWS-09", {
    loss: "the cache is flushed and the primary endpoint changes",
  }), // AWS-09
  aws_elasticache_cluster: B("ElastiCache cluster", "AWS-09", {
    loss: "the cache is flushed and its endpoint changes",
  }),
  aws_elasticache_serverless_cache: B("ElastiCache serverless cache", "AWS-09"),
  aws_kinesis_stream: B("Kinesis stream", "AWS-14", {
    loss: "records in flight are lost and the stream ARN changes for producers and consumers",
  }), // AWS-14
  aws_sqs_queue: B("SQS queue", "AWS-14", {
    loss: "messages in flight are lost and the queue URL changes for producers and consumers",
  }),
  aws_sns_topic: B("SNS topic", "PLAN-01", { loss: "its ARN changes and every subscription is dropped" }),
  aws_secretsmanager_secret: B("Secrets Manager secret", "AWS-16", {
    destroy: (b) => (b.recovery_window_in_days === 0 ? "critical" : "high"),
    loss: (b) =>
      b.recovery_window_in_days === 0
        ? "recovery_window_in_days is 0, so the secret is deleted at once with no recovery"
        : "its ARN suffix changes, so every consumer and policy that names it breaks",
  }), // AWS-16
  aws_route53_zone: B("Route 53 hosted zone", "AWS-17", {
    destroy: "critical",
    loss: "the new zone gets new name servers, so the parent delegation breaks and every record in it disappears",
  }), // AWS-17
  aws_route53_record: B("DNS record", "AWS-17", {
    impact: "outage",
    loss: "the name stops resolving until the new record propagates",
  }),
  aws_acm_certificate: B("ACM certificate", "AWS-18", {
    loss: "listeners and distributions using it fail over or break while the certificate is in use",
  }), // AWS-18
  aws_lb: B("load balancer", "AWS-19", {
    destroy: (b) => (b.internal === false ? "critical" : "high"),
    loss: LB_LOSS,
  }), // AWS-19
  aws_alb: B("load balancer", "AWS-19", {
    destroy: (b) => (b.internal === false ? "critical" : "high"),
    loss: LB_LOSS,
  }),
  aws_elb: B("classic load balancer", "AWS-19", { loss: "its dns_name changes, so every CNAME breaks" }),
  aws_lb_target_group: B("target group", "AWS-19", {
    impact: "outage",
    loss: "listeners lose their targets until the new group is attached",
  }),
  aws_alb_target_group: B("target group", "AWS-19", { impact: "outage" }),
  aws_lb_listener: B("load balancer listener", "AWS-19", {
    impact: "outage",
    loss: "traffic on that port is dropped",
  }),
  aws_cloudfront_distribution: B("CloudFront distribution", "AWS-20", {
    loss: "its *.cloudfront.net domain changes and traffic stops until DNS points at the new one",
  }), // AWS-20
  aws_vpc: B("VPC", "AWS-21", {
    destroy: "critical",
    loss: "everything with a network interface in it (databases, clusters, load balancers, instances) must be replaced too",
  }), // AWS-21
  aws_subnet: B("subnet", "AWS-21", {
    destroy: "critical",
    loss: "everything with a network interface in it (databases, clusters, load balancers, instances) must be replaced too",
  }),
  aws_iam_role: B("IAM role", "AWS-22", {
    loss: "trust and resource policies that name it stop matching, even after it is re-created",
  }), // AWS-22
  aws_iam_user: B("IAM user", "AWS-22", { loss: "its access keys and console password stop working" }),
  aws_iam_policy: B("IAM policy", "AWS-22", {
    destroy: "medium",
    loss: "it is detached from every role, user and group and re-attached",
  }),
  aws_iam_instance_profile: B("instance profile", "AWS-22"),
  aws_iam_openid_connect_provider: B("OIDC provider", "AWS-22", {
    loss: "every role that trusts it stops accepting tokens until it is re-created",
  }),
  aws_iam_access_key: B("IAM access key", "AWS-U04", { loss: "applications using the old key stop working" }),
  aws_kms_alias: B("KMS alias", "AWS-15", {
    loss: "anything that encrypts through the alias fails until it exists again",
  }),
  aws_cognito_user_pool_client: B("Cognito app client", "AWS-23", {
    loss: "its client id changes, so every app using it breaks",
  }),
  aws_eip: B("Elastic IP", "PLAN-01", { loss: "the public IP address is released and cannot be got back" }),
  aws_nat_gateway: B("NAT gateway", "PLAN-01", {
    impact: "outage",
    loss: "private subnets lose outbound internet access and its public IP changes",
  }),
  aws_internet_gateway: B("internet gateway", "PLAN-01", {
    impact: "outage",
    loss: "the VPC loses internet access",
  }),
  aws_vpc_endpoint: B("VPC endpoint", "PLAN-01", {
    impact: "outage",
    loss: "traffic to that service is cut",
  }),
  aws_vpc_peering_connection: B("VPC peering connection", "PLAN-01", { impact: "outage" }),
  aws_ec2_transit_gateway: B("transit gateway", "PLAN-01", { destroy: "critical" }),
  aws_ec2_transit_gateway_vpc_attachment: B("transit gateway attachment", "PLAN-01", { impact: "outage" }),
  aws_globalaccelerator_accelerator: B("Global Accelerator", "PLAN-01", {
    loss: "its static anycast IPs are released",
  }),
  aws_api_gateway_rest_api: B("API Gateway REST API", "PLAN-01", { loss: "its invoke URL changes" }),
  aws_apigatewayv2_api: B("API Gateway API", "PLAN-01", { loss: "its invoke URL changes" }),
  aws_api_gateway_domain_name: B("API Gateway custom domain", "PLAN-01"),
  aws_apigatewayv2_domain_name: B("API Gateway custom domain", "PLAN-01"),
  aws_eks_cluster: B("EKS cluster", "AWS-25", {
    destroy: "critical",
    loss: "a new control plane means a new endpoint, CA and OIDC issuer, so every workload, IRSA trust policy and access entry breaks",
  }), // AWS-25
  aws_eks_node_group: B("EKS node group", "AWS-26", {
    impact: "outage",
    loss: "every node is drained, so pods go Pending until new nodes join",
  }), // AWS-26
  aws_ecs_service: B("ECS service", "AWS-27", { impact: "outage", loss: "its running tasks are stopped" }), // AWS-27
  aws_ecs_cluster: B("ECS cluster", "AWS-27", { impact: "outage" }),
  aws_autoscaling_group: B("Auto Scaling group", "AWS-27", {
    impact: "outage",
    loss: "its instances are terminated",
  }),
  aws_lambda_function: B("Lambda function", "AWS-27", {
    destroy: "medium",
    loss: "its ARN changes and its permissions and event-source mappings are re-created",
  }),
  aws_security_group: B("security group", "AWS-27", {
    impact: "outage",
    loss: "attached interfaces lose its rules (and a delete-first replace fails while it is attached)",
  }),
  aws_instance: B("EC2 instance", "AWS-07", {
    loss: "its root volume is lost along with its instance id and private IP",
  }), // AWS-07
  aws_efs_mount_target: B("EFS mount target", "AWS-08", { impact: "outage", loss: "mounts through it drop" }),
  aws_volume_attachment: B("volume attachment", "AWS-08", {
    impact: "outage",
    loss: "the volume is detached from a running instance",
  }),
  aws_wafv2_web_acl: B("WAF web ACL", "AWS-20", {
    impact: "outage",
    loss: "the sites it protects lose WAF filtering",
  }),
  aws_wafv2_web_acl_association: C("WAF association", "AWS-20", {
    destroy: "high",
    loss: "the resource loses WAF protection",
  }),
  // ── AWS audit and guard resources whose destroy is the risk ──
  aws_cloudtrail: C("CloudTrail trail", "AWS-U09", {
    destroy: "high",
    loss: "the account's API audit trail stops",
  }), // AWS-U09
  aws_guardduty_detector: C("GuardDuty detector", "AWS-U09", {
    destroy: "high",
    loss: "threat detection stops",
  }),
  aws_config_configuration_recorder: C("AWS Config recorder", "AWS-U09", {
    destroy: "high",
    loss: "configuration history stops being recorded",
  }),
  aws_flow_log: C("VPC flow log", "AWS-U09", { loss: "network flow logging stops" }),
  aws_cloudwatch_log_group: C("CloudWatch log group", "AWS-U09", {
    loss: "the logs stored in it are deleted",
  }),
  aws_s3_bucket_public_access_block: C("S3 public access block", "AWS-U05", {
    destroy: "critical",
    loss: "nothing blocks public ACLs or public bucket policies on the bucket any more",
  }), // AWS-U05
  aws_s3_account_public_access_block: C("account-wide S3 public access block", "AWS-U05", {
    destroy: "critical",
    loss: "nothing blocks public ACLs or public bucket policies in the account any more",
  }),
  aws_s3_bucket_versioning: C("S3 versioning configuration", "AWS-U06", {
    destroy: (b, ctx) => {
      const status = asRecord(asArray(b.versioning_configuration)[0]).status;
      const bucket = str(b.bucket);
      return status === "Enabled" && !(bucket && ctx.bucketDestroyed(bucket)) ? "high" : "medium";
    },
    loss: "destroying it suspends versioning, so overwritten and deleted objects stop being recoverable",
  }), // AWS-U06
  aws_s3_bucket_server_side_encryption_configuration: C("S3 default encryption", "AWS-U06", {
    loss: "the bucket falls back to default SSE-S3 encryption",
  }),
  aws_s3_bucket_logging: C("S3 access logging", "AWS-U06", { loss: "access logging for the bucket stops" }),
  aws_s3_bucket_lifecycle_configuration: C("S3 lifecycle configuration", "AWS-U06"),
  aws_backup_vault_lock_configuration: C("Backup vault lock", "AWS-24"),
  // ── trivial / revision churn (NOISE-02) ──
  aws_ecs_task_definition: C("ECS task definition revision", "NOISE-02", {
    destroy: "low",
    loss: "a new revision is registered and the old one is deregistered",
  }),
  aws_launch_template: C("launch template", "PLAN-01", { destroy: "low" }),
  terraform_data: C("terraform_data", "PLAN-08", { destroy: "low" }),
  null_resource: C("null_resource", "PLAN-08", { destroy: "low" }),
  time_sleep: C("time_sleep", "PLAN-01", { destroy: "low" }),
  time_static: C("time_static", "PLAN-01", { destroy: "low" }),
  local_file: C("local file", "PLAN-01", { destroy: "low" }),
  // ── azurerm ──
  azurerm_mssql_server: A("Azure SQL server", "AZ-01", { loss: "every database on it is dropped" }), // AZ-01
  azurerm_mssql_database: A("Azure SQL database", "AZ-01"),
  azurerm_mssql_managed_instance: A("SQL managed instance", "AZ-01"),
  azurerm_sql_server: A("Azure SQL server", "AZ-01", { loss: "every database on it is dropped" }),
  azurerm_sql_database: A("Azure SQL database", "AZ-01"),
  azurerm_postgresql_flexible_server: A("PostgreSQL flexible server", "AZ-02"), // AZ-02
  azurerm_postgresql_flexible_server_database: A("PostgreSQL database", "AZ-02"),
  azurerm_postgresql_server: A("PostgreSQL server", "AZ-02"),
  azurerm_mysql_flexible_server: A("MySQL flexible server", "AZ-02"),
  azurerm_mysql_flexible_database: A("MySQL database", "AZ-02"),
  azurerm_mariadb_server: A("MariaDB server", "AZ-02"),
  azurerm_storage_account: A("storage account", "AZ-03", {
    loss: "every blob, file, queue and table in it is lost",
  }), // AZ-03
  azurerm_storage_container: A("storage container", "AZ-03", { loss: "every blob in it is deleted" }),
  azurerm_storage_share: A("file share", "AZ-03", { loss: "every file in it is deleted" }),
  azurerm_key_vault: A("Key Vault", "AZ-04", {
    destroy: (b) => (b.purge_protection_enabled === true ? "high" : "critical"),
    loss: (b) =>
      b.purge_protection_enabled === true
        ? "its keys and secrets go to soft-delete (purge protection is on)"
        : "the provider purges soft-deleted vaults on destroy by default, so every key and secret is gone for good",
  }), // AZ-04
  azurerm_key_vault_key: A("Key Vault key", "AZ-04", {
    loss: "data encrypted with it becomes unreadable once purged",
  }),
  azurerm_key_vault_secret: B("Key Vault secret", "AZ-04", { loss: "consumers of the secret break" }),
  azurerm_cosmosdb_account: A("Cosmos DB account", "AZ-06", { loss: "every container and its data is lost" }), // AZ-06
  azurerm_cosmosdb_sql_database: A("Cosmos DB database", "AZ-06"),
  azurerm_cosmosdb_sql_container: A("Cosmos DB container", "AZ-06"),
  azurerm_cosmosdb_mongo_database: A("Cosmos DB database", "AZ-06"),
  azurerm_resource_group: A("resource group", "AZ-06", {
    loss: "every resource in it is destroyed with it",
  }),
  azurerm_managed_disk: A("managed disk", "PLAN-01"),
  azurerm_log_analytics_workspace: A("Log Analytics workspace", "PLAN-01", { loss: "its logs are deleted" }),
  azurerm_recovery_services_vault: A("Recovery Services vault", "PLAN-01", {
    loss: "its recovery points are lost",
  }),
  azurerm_data_protection_backup_vault: A("backup vault", "PLAN-01", {
    loss: "its recovery points are lost",
  }),
  azurerm_container_registry: A("container registry", "PLAN-01", { loss: "every image in it is deleted" }),
  azurerm_kubernetes_cluster: B("AKS cluster", "AZ-05", {
    destroy: "critical",
    loss: "a new control plane and identities, so every workload is evicted and re-deployed",
  }), // AZ-05
  azurerm_kubernetes_cluster_node_pool: B("AKS node pool", "AZ-05", {
    impact: "outage",
    loss: "its workloads are evicted",
  }),
  azurerm_virtual_network: B("virtual network", "PLAN-01", {
    destroy: "critical",
    loss: "everything attached to it must be replaced too",
  }),
  azurerm_subnet: B("subnet", "PLAN-01", {
    destroy: "critical",
    loss: "everything attached to it must be replaced too",
  }),
  azurerm_public_ip: B("public IP", "PLAN-01", { loss: "the public IP address is released" }),
  azurerm_dns_zone: B("DNS zone", "AWS-17", {
    destroy: "critical",
    loss: "the new zone gets new name servers, so the parent delegation breaks",
  }),
  azurerm_private_dns_zone: B("private DNS zone", "AWS-17"),
  azurerm_user_assigned_identity: B("managed identity", "PLAN-01", {
    loss: "its principal id changes, so every role assignment and federated credential that names it breaks",
  }),
  azurerm_redis_cache: B("Redis cache", "AWS-09", {
    loss: "the cache is flushed and its host name may change",
  }),
  azurerm_servicebus_namespace: B("Service Bus namespace", "AWS-14", {
    loss: "every queue and message in it is lost",
  }),
  azurerm_servicebus_queue: B("Service Bus queue", "AWS-14", { loss: "messages in flight are lost" }),
  azurerm_eventhub_namespace: B("Event Hubs namespace", "AWS-14", {
    loss: "every event hub and retained event is lost",
  }),
  azurerm_linux_virtual_machine: B("virtual machine", "AWS-07", {
    loss: "its OS disk and private IP are lost",
  }),
  azurerm_windows_virtual_machine: B("virtual machine", "AWS-07", {
    loss: "its OS disk and private IP are lost",
  }),
  azurerm_application_gateway: B("application gateway", "AWS-19", { impact: "outage" }),
  azurerm_lb: B("load balancer", "AWS-19", { impact: "outage" }),
  azurerm_api_management: B("API Management service", "PLAN-01"),
  // ── google ──
  google_sql_database_instance: A("Cloud SQL instance", "GCP-01", {
    loss: "the instance and its data are recreated, and its name cannot be reused for up to a week",
  }), // GCP-01
  google_sql_database: A("Cloud SQL database", "GCP-01"),
  google_storage_bucket: A("GCS bucket", "GCP-02", {
    destroy: (b) => (b.force_destroy === true ? "critical" : "high"),
    loss: (b) =>
      b.force_destroy === true
        ? "force_destroy is on, so every object in it is deleted"
        : "its objects are at risk (the destroy fails while the bucket is not empty)",
  }), // GCP-02
  google_bigquery_dataset: A("BigQuery dataset", "PLAN-01", { loss: "every table in it is deleted" }),
  google_bigquery_table: A("BigQuery table", "PLAN-01", { loss: "every row in it is deleted" }),
  google_spanner_instance: A("Spanner instance", "PLAN-01"),
  google_spanner_database: A("Spanner database", "PLAN-01"),
  google_bigtable_instance: A("Bigtable instance", "PLAN-01"),
  google_bigtable_table: A("Bigtable table", "PLAN-01"),
  google_firestore_database: A("Firestore database", "PLAN-01"),
  google_compute_disk: A("persistent disk", "PLAN-01"),
  google_filestore_instance: A("Filestore instance", "PLAN-01"),
  google_alloydb_cluster: A("AlloyDB cluster", "PLAN-01"),
  google_kms_crypto_key: A("Cloud KMS key", "AWS-15", {
    loss: "its key versions are destroyed, so data encrypted with it becomes unreadable",
  }),
  google_container_cluster: B("GKE cluster", "GCP-03", {
    destroy: "critical",
    loss: "a new control plane, so every workload is evicted and re-deployed",
  }), // GCP-03
  google_container_node_pool: B("GKE node pool", "GCP-03", {
    impact: "outage",
    loss: "its workloads are evicted",
  }),
  google_compute_network: B("VPC network", "AWS-21", {
    destroy: "critical",
    loss: "everything attached to it must be replaced too",
  }),
  google_compute_subnetwork: B("subnetwork", "AWS-21", {
    destroy: "critical",
    loss: "everything attached to it must be replaced too",
  }),
  google_compute_instance: B("Compute Engine instance", "AWS-07", {
    loss: "its boot disk and internal IP may be lost",
  }),
  google_compute_address: B("static IP address", "PLAN-01", { loss: "the IP address is released" }),
  google_compute_global_address: B("static IP address", "PLAN-01", { loss: "the IP address is released" }),
  google_dns_managed_zone: B("Cloud DNS zone", "AWS-17", {
    destroy: "critical",
    loss: "the new zone gets new name servers, so the parent delegation breaks",
  }),
  google_dns_record_set: B("DNS record", "AWS-17", { impact: "outage" }),
  google_service_account: B("service account", "AWS-22", {
    loss: "its unique id changes, so IAM bindings and keys that name it stop working",
  }),
  google_project: A("GCP project", "PLAN-01", { loss: "every resource in it is shut down and deleted" }),
  google_redis_instance: B("Memorystore instance", "AWS-09", {
    loss: "the cache is flushed and its host changes",
  }),
  google_pubsub_topic: B("Pub/Sub topic", "AWS-14"),
  google_pubsub_subscription: B("Pub/Sub subscription", "AWS-14", {
    loss: "unacknowledged messages are lost",
  }),
  google_secret_manager_secret: B("Secret Manager secret", "AWS-16", {
    loss: "every version of the secret is deleted",
  }),
};

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

const DEFAULT_CLASS: ResourceClass = C("resource", "PLAN-01");

/** The class of a resource type; unknown types are Tier C cattle with the type as the noun. */
export function classify(type: string): ResourceClass {
  return RESOURCE_CLASSES[type] ?? { ...DEFAULT_CLASS, noun: type };
}

/** PLAN-01 base severity for deleting or replacing this object (before create_before_destroy). */
export function destroySeverity(change: ResourceChange, ctx: RuleContext): Severity {
  const cls = classify(change.type);
  const d = cls.destroy;
  if (typeof d === "function") return d(asRecord(change.before), ctx);
  return d ?? TIER_DESTROY_SEVERITY[cls.tier];
}

/** What destroying this object costs, as a clause; "" when nothing beyond the object itself. */
export function destroyLoss(change: ResourceChange): string {
  const cls = classify(change.type);
  const l = cls.loss;
  if (typeof l === "function") return l(asRecord(change.before), asRecord(change.after));
  if (l) return l;
  if (cls.tier === "A") return DATA_LOSS;
  if (cls.tier === "B" && cls.impact === "identity") return IDENTITY_LOSS;
  return "";
}

// ───────────────────────────── force-new explanations (AWS-xx / AZ-xx / GCP-xx) ─────────────────────────────

const AT_CREATION = "is fixed when it is created";

/** type → attribute (top-level, or "block.attr" without indexes) → why it cannot change in place. */
export const FORCE_NEW: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // AWS-01
  aws_db_instance: {
    storage_encrypted: "RDS cannot encrypt or decrypt an existing instance's storage; it creates a new one",
    kms_key_id: "RDS cannot re-key an existing instance's storage; it creates a new one",
    engine: "an RDS instance cannot switch database engines; a new instance is created",
    username: `the master username ${AT_CREATION}`,
    db_name: `the initial database name ${AT_CREATION}`,
    availability_zone: "a single-AZ instance cannot move to another availability zone in place",
    character_set_name: `the character set ${AT_CREATION}`,
    nchar_character_set_name: `the national character set ${AT_CREATION}`,
    timezone: `the time zone ${AT_CREATION}`,
    snapshot_identifier: "restoring from a different snapshot always creates a new instance",
    restore_to_point_in_time: "a point-in-time restore always creates a new instance",
    s3_import: "an S3 import only happens when the instance is created",
    custom_iam_instance_profile: `the RDS Custom instance profile ${AT_CREATION}`,
    backup_target: `the backup target ${AT_CREATION}`,
    multi_tenant: "a multi-tenant instance cannot be turned back into a single-tenant one",
  },
  // AWS-03
  aws_rds_cluster: {
    availability_zones:
      "the cluster's availability zones are fixed at creation (RDS fills in three, so listing fewer shows as a perpetual diff that replaces the cluster)",
    storage_encrypted: "Aurora cannot encrypt or decrypt an existing cluster's storage; it creates a new one",
    kms_key_id: "Aurora cannot re-key an existing cluster's storage; it creates a new one",
    engine: "a cluster cannot switch database engines",
    engine_mode: `the engine mode ${AT_CREATION}`,
    master_username: `the master username ${AT_CREATION}`,
    database_name: `the initial database name ${AT_CREATION}`,
    db_subnet_group_name: "an RDS cluster cannot move to another DB subnet group in place",
    cluster_identifier: "the provider cannot rename an RDS cluster in place",
    snapshot_identifier: "restoring from a different snapshot always creates a new cluster",
    publicly_accessible: "on AWS provider v6 this setting is fixed when the cluster is created",
    storage_type: "a non-Aurora cluster cannot change its storage type in place",
    restore_to_point_in_time: "a point-in-time restore always creates a new cluster",
  },
  // AWS-04
  aws_rds_cluster_instance: {
    identifier: "an Aurora instance cannot be renamed in place",
    cluster_identifier: "an instance cannot move to another cluster",
    engine: "an instance cannot switch engines",
    availability_zone: "an instance cannot move to another availability zone",
    db_subnet_group_name: "an instance cannot move to another DB subnet group",
  },
  // AWS-05
  aws_dynamodb_table: {
    name: "DynamoDB tables cannot be renamed",
    hash_key: `a table's key schema ${AT_CREATION}`,
    range_key: `a table's key schema ${AT_CREATION}`,
    local_secondary_index: "local secondary indexes can only be defined when the table is created",
    restore_source_name: "a restore always creates a new table",
    restore_date_time: "a restore always creates a new table",
    restore_to_latest_time: "a restore always creates a new table",
    import_table: "an S3 import only happens when the table is created",
  },
  // AWS-06
  aws_s3_bucket: {
    bucket: "S3 bucket names cannot be changed; a new bucket is created",
    bucket_prefix: "S3 bucket names cannot be changed; a new bucket is created",
    bucket_namespace: `the bucket namespace ${AT_CREATION}`,
    object_lock_enabled: "object lock cannot be turned off on an existing bucket",
  },
  // AWS-07
  aws_instance: {
    ami: "an instance cannot change its AMI; a new instance is launched",
    subnet_id: "an instance cannot move to another subnet",
    availability_zone: "an instance cannot move to another availability zone",
    key_name: "the SSH key pair is fixed when the instance is launched",
    private_ip: "the primary private IP is fixed when the instance is launched",
    security_groups: "the name-based security_groups list is fixed at launch (vpc_security_group_ids is not)",
    associate_public_ip_address: "a public IP can only be assigned at launch",
    tenancy: "tenancy is fixed at launch",
    host_id: "the dedicated host is fixed at launch",
    ebs_optimized: "EBS optimization is fixed at launch by the provider",
    hibernation: "hibernation is fixed at launch",
    user_data:
      "user_data_replace_on_change is true, so new user data launches a new instance instead of a stop/start",
    user_data_base64:
      "user_data_replace_on_change is true, so new user data launches a new instance instead of a stop/start",
    instance_type:
      "the new instance type uses a different CPU architecture, so it cannot be resized in place",
    "root_block_device.encrypted": "root volume encryption is fixed at launch",
    "root_block_device.kms_key_id": "the root volume's KMS key is fixed at launch",
    root_block_device: "root volume encryption and its KMS key are fixed at launch",
    ebs_block_device: "inline ebs_block_device volumes can only be attached at launch",
    ephemeral_block_device: "instance-store volumes are fixed at launch",
    network_interface: "inline network interfaces are fixed at launch",
    launch_template: "the launch template is fixed at launch",
    placement_group: "placement is fixed at launch",
    ipv6_addresses: "IPv6 addresses are fixed at launch",
    cpu_options: "CPU options are fixed at launch",
    instance_market_options: "spot/on-demand market options are fixed at launch",
  },
  // AWS-08
  aws_ebs_volume: {
    encrypted: "EBS cannot encrypt an existing volume in place",
    kms_key_id: "EBS cannot re-key an existing volume in place",
    availability_zone: "a volume cannot move to another availability zone",
    snapshot_id: "a volume is created from a snapshot only once",
    multi_attach_enabled: "multi-attach is fixed when the volume is created",
    outpost_arn: `the Outpost ${AT_CREATION}`,
  },
  aws_efs_file_system: {
    encrypted: "EFS cannot encrypt an existing file system in place",
    kms_key_id: "EFS cannot re-key an existing file system in place",
    performance_mode: `the performance mode ${AT_CREATION}`,
    creation_token: `the creation token ${AT_CREATION}`,
    availability_zone_name: "a One Zone file system cannot move to another zone",
  },
  // AWS-09
  aws_elasticache_replication_group: {
    at_rest_encryption_enabled: "at-rest encryption cannot be toggled on an existing replication group",
    transit_encryption_enabled: "in-transit encryption cannot be toggled in place on this engine version",
    kms_key_id: `the KMS key ${AT_CREATION}`,
    port: `the port ${AT_CREATION}`,
    subnet_group_name: "a replication group cannot move to another subnet group",
    replication_group_id: "a replication group cannot be renamed",
    engine: "an engine downgrade or change is not possible in place",
    engine_version: "ElastiCache cannot downgrade an engine version in place",
    data_tiering_enabled: `data tiering ${AT_CREATION}`,
    network_type: `the network type ${AT_CREATION}`,
    node_group_configuration: "explicit node group configuration cannot change in place",
  },
  aws_elasticache_cluster: {
    cluster_id: "a cache cluster cannot be renamed",
    engine: "a cache cluster cannot switch engines",
    port: `the port ${AT_CREATION}`,
    subnet_group_name: "a cache cluster cannot move to another subnet group",
    node_type: "Memcached clusters cannot scale node size in place",
    availability_zone: "a cache node cannot move to another availability zone",
    transit_encryption_enabled: `in-transit encryption ${AT_CREATION}`,
  },
  // AWS-10
  aws_memorydb_cluster: {
    auto_minor_version_upgrade:
      "MemoryDB cannot toggle auto_minor_version_upgrade in place (a surprise ForceNew)",
    name: "a MemoryDB cluster cannot be renamed",
    kms_key_arn: `the KMS key ${AT_CREATION}`,
    port: `the port ${AT_CREATION}`,
    tls_enabled: `TLS ${AT_CREATION}`,
    subnet_group_name: "a cluster cannot move to another subnet group",
    data_tiering: `data tiering ${AT_CREATION}`,
  },
  // AWS-11
  aws_opensearch_domain: {
    domain_name: "an OpenSearch domain cannot be renamed",
    engine_version: "this engine version change is not an in-place upgrade target",
    encrypt_at_rest: "encryption at rest cannot be turned off or re-keyed in place",
    node_to_node_encryption: "node-to-node encryption cannot be turned off in place",
    vpc_options: "a domain cannot move between public and VPC access, or to other subnets, in place",
    advanced_security_options: "fine-grained access control cannot be turned off in place",
  },
  // AWS-12
  aws_redshift_cluster: {
    cluster_identifier: "a Redshift cluster cannot be renamed by the provider",
    cluster_subnet_group_name: "a cluster cannot move to another subnet group",
    master_username: `the master username ${AT_CREATION}`,
    snapshot_identifier: "restoring from a snapshot always creates a new cluster",
  },
  aws_docdb_cluster: {
    port: "DocumentDB clusters cannot change port in place (a surprise ForceNew)",
    storage_encrypted: "DocumentDB cannot encrypt an existing cluster in place",
    kms_key_id: "DocumentDB cannot re-key an existing cluster in place",
    engine: "a cluster cannot switch engines",
    master_username: `the master username ${AT_CREATION}`,
    cluster_identifier: "a DocumentDB cluster cannot be renamed",
    availability_zones: `the cluster's availability zones are fixed at creation`,
    db_subnet_group_name: "a cluster cannot move to another subnet group",
    snapshot_identifier: "restoring from a snapshot always creates a new cluster",
  },
  aws_neptune_cluster: {
    port: "Neptune clusters cannot change port in place (a surprise ForceNew)",
    storage_encrypted: "Neptune cannot encrypt an existing cluster in place",
    kms_key_arn: "Neptune cannot re-key an existing cluster in place",
    engine: "a cluster cannot switch engines",
    cluster_identifier: "a Neptune cluster cannot be renamed",
    availability_zones: `the cluster's availability zones are fixed at creation`,
    neptune_subnet_group_name: "a cluster cannot move to another subnet group",
    snapshot_identifier: "restoring from a snapshot always creates a new cluster",
  },
  // AWS-13
  aws_msk_cluster: {
    cluster_name: "an MSK cluster cannot be renamed",
    broker_node_group_info: "broker subnets and security groups are fixed at creation",
    encryption_info: "MSK encryption settings are fixed at creation",
    kafka_version: "MSK cannot downgrade Kafka in place",
    storage_mode: "MSK cannot move back to local storage in place",
  },
  // AWS-14
  aws_kinesis_stream: { name: "a Kinesis stream cannot be renamed" },
  aws_sqs_queue: {
    name: "an SQS queue cannot be renamed",
    name_prefix: "an SQS queue cannot be renamed",
    fifo_queue: "a queue cannot switch between standard and FIFO",
  },
  // AWS-15
  aws_kms_key: {
    key_usage: `a key's usage ${AT_CREATION}`,
    customer_master_key_spec: `a key's spec ${AT_CREATION}`,
    multi_region: "a key cannot become (or stop being) multi-Region in place",
    custom_key_store_id: `the custom key store ${AT_CREATION}`,
    xks_key_id: `the external key ${AT_CREATION}`,
  },
  // AWS-16
  aws_secretsmanager_secret: {
    name: "a secret cannot be renamed; the new one gets a new ARN suffix",
    name_prefix: "a secret cannot be renamed; the new one gets a new ARN suffix",
  },
  // AWS-17
  aws_route53_zone: {
    name: "a hosted zone cannot be renamed",
    delegation_set_id: "a zone cannot move to another reusable delegation set",
  },
  aws_route53_record: {
    name: "a record cannot be renamed; it is deleted and re-created",
    zone_id: "a record cannot move to another zone",
    type: "a record cannot change its type",
    set_identifier: "a record's set identifier cannot change",
  },
  // AWS-18
  aws_acm_certificate: {
    domain_name: "a certificate's names cannot change; ACM issues a new certificate",
    subject_alternative_names: "a certificate's names cannot change; ACM issues a new certificate",
    validation_method: `the validation method ${AT_CREATION}`,
    key_algorithm: `the key algorithm ${AT_CREATION}`,
    certificate_authority_arn: `the issuing private CA ${AT_CREATION}`,
    validation_option: "validation options are fixed when the certificate is requested",
  },
  // AWS-19
  aws_lb: {
    name: "a load balancer cannot be renamed",
    name_prefix: "a load balancer cannot be renamed",
    internal: "a load balancer cannot switch between internal and internet-facing",
    load_balancer_type: "a load balancer cannot change its type",
    subnets: "a network load balancer cannot change subnets in this way in place",
    subnet_mapping: "a network load balancer cannot change subnet mappings in place",
    security_groups: "a network load balancer cannot add or remove all of its security groups in place",
    customer_owned_ipv4_pool: `the customer-owned IP pool ${AT_CREATION}`,
  },
  aws_lb_target_group: {
    port: `a target group's port ${AT_CREATION}`,
    protocol: `a target group's protocol ${AT_CREATION}`,
    protocol_version: `a target group's protocol version ${AT_CREATION}`,
    target_type: `a target group's target type ${AT_CREATION}`,
    vpc_id: "a target group cannot move to another VPC",
    name: "a target group cannot be renamed",
    ip_address_type: `a target group's IP address type ${AT_CREATION}`,
  },
  // AWS-20
  aws_cloudfront_distribution: { staging: "a staging distribution cannot become a production one" },
  // AWS-21
  aws_vpc: {
    cidr_block: "a VPC's primary CIDR block cannot change",
    instance_tenancy: "a VPC cannot go back from dedicated to default tenancy in place",
    ipv4_ipam_pool_id: `the IPAM pool ${AT_CREATION}`,
    ipv4_netmask_length: `the IPAM netmask ${AT_CREATION}`,
  },
  aws_subnet: {
    cidr_block: "a subnet's CIDR block cannot change; AWS creates a new subnet",
    availability_zone: "a subnet cannot move to another availability zone",
    availability_zone_id: "a subnet cannot move to another availability zone",
    vpc_id: "a subnet cannot move to another VPC",
    ipv6_native: `IPv6-only mode ${AT_CREATION}`,
    ipv6_cidr_block: "this subnet's IPv6 CIDR block cannot change in place",
    outpost_arn: `the Outpost ${AT_CREATION}`,
  },
  // AWS-22
  aws_iam_role: {
    name: "IAM roles cannot be renamed; the new role gets a new unique id",
    name_prefix: "IAM roles cannot be renamed; the new role gets a new unique id",
    path: "an IAM role's path cannot change",
  },
  aws_iam_policy: {
    name: "IAM policies cannot be renamed",
    name_prefix: "IAM policies cannot be renamed",
    path: "an IAM policy's path cannot change",
    description: "an IAM policy's description cannot change after creation (a surprise ForceNew)",
  },
  // AWS-23
  aws_cognito_user_pool: {
    alias_attributes: "a user pool's sign-in attributes are fixed when it is created",
    username_attributes: "a user pool's sign-in attributes are fixed when it is created",
    username_configuration: "username case sensitivity is fixed when the user pool is created",
  },
  // AWS-24
  aws_ecr_repository: {
    name: "an ECR repository cannot be renamed",
    encryption_configuration: "a repository's encryption settings are fixed at creation",
  },
  aws_backup_vault: {
    name: "a backup vault cannot be renamed",
    kms_key_arn: `the vault's KMS key ${AT_CREATION}`,
  },
  // AWS-25
  aws_eks_cluster: {
    name: "an EKS cluster cannot be renamed",
    role_arn: "the cluster IAM role cannot be changed after creation (a surprise ForceNew)",
    kubernetes_network_config: "the service CIDR and IP family are fixed at creation",
    encryption_config: "envelope encryption cannot be removed from a cluster",
    access_config: "bootstrap_cluster_creator_admin_permissions is fixed at creation",
    bootstrap_self_managed_addons: `self-managed add-on bootstrapping ${AT_CREATION}`,
    outpost_config: `the Outpost configuration ${AT_CREATION}`,
    compute_config: "the Auto Mode node role cannot change in place",
  },
  // AWS-26
  aws_eks_node_group: {
    instance_types: "a node group's instance types cannot change; a new group is created",
    ami_type: `a node group's AMI type ${AT_CREATION}`,
    capacity_type: "a node group cannot switch between on-demand and spot",
    disk_size: `a node group's disk size ${AT_CREATION}`,
    subnet_ids: "a node group cannot move to other subnets",
    node_role_arn: `a node group's IAM role ${AT_CREATION}`,
    launch_template: "a node group cannot switch to another launch template",
    remote_access: `remote access ${AT_CREATION}`,
    node_group_name: "a node group cannot be renamed",
    node_group_name_prefix: "a node group cannot be renamed",
    cluster_name: "a node group cannot move to another cluster",
  },
  // AWS-27
  aws_ecs_service: {
    name: "an ECS service cannot be renamed",
    cluster: "a service cannot move to another cluster",
    launch_type: "a service cannot switch launch type in place",
    scheduling_strategy: "a service cannot switch between REPLICA and DAEMON",
    iam_role: `the service's load balancer role ${AT_CREATION}`,
  },
  aws_autoscaling_group: {
    name: "an Auto Scaling group cannot be renamed",
    name_prefix: "an Auto Scaling group cannot be renamed",
    initial_lifecycle_hook: "initial lifecycle hooks only apply when the group is created",
  },
  aws_lambda_function: {
    function_name: "a Lambda function cannot be renamed; the new one has a new ARN",
    package_type: "a function cannot switch between zip and image packaging",
    tenancy_config: `tenancy ${AT_CREATION}`,
  },
  aws_security_group: {
    name: "a security group cannot be renamed",
    name_prefix: "a security group cannot be renamed",
    description: "a security group's description cannot change (a surprise ForceNew)",
    vpc_id: "a security group cannot move to another VPC",
  },
  // NOISE-02
  aws_ecs_task_definition: {
    container_definitions: "every task definition change registers a new revision",
  },
  // AZ-01
  azurerm_mssql_server: {
    version: "the SQL server version cannot change in place",
    administrator_login: `the administrator login ${AT_CREATION}`,
  },
  azurerm_mssql_database: {
    collation: "changing the collation means a new, empty database",
    create_mode: "the create mode only applies when the database is created",
    sku_name: "a Hyperscale database cannot move to another SKU in place",
    ledger_enabled: `ledger ${AT_CREATION}`,
    server_id: "a database cannot move to another server",
  },
  // AZ-02
  azurerm_postgresql_flexible_server: {
    storage_type: `the storage type ${AT_CREATION}`,
    delegated_subnet_id: "a server cannot move to another delegated subnet",
    geo_redundant_backup_enabled: "geo-redundant backup can only be chosen when the server is created",
    customer_managed_key: `the customer-managed key ${AT_CREATION}`,
  },
  azurerm_mysql_flexible_server: {
    administrator_login: `the administrator login ${AT_CREATION}`,
    delegated_subnet_id: "a server cannot move to another delegated subnet",
    geo_redundant_backup_enabled: "geo-redundant backup can only be chosen when the server is created",
    storage: "MySQL flexible server storage cannot shrink in place (a surprise ForceNew)",
    private_dns_zone_id: `the private DNS zone ${AT_CREATION}`,
  },
  // AZ-03
  azurerm_storage_account: {
    account_tier: "a storage account cannot switch between Standard and Premium",
    account_replication_type: "this replication change cannot be migrated in place",
    is_hns_enabled: "the hierarchical namespace (Data Lake) setting is fixed at creation",
    nfsv3_enabled: `NFSv3 ${AT_CREATION}`,
    infrastructure_encryption_enabled: `infrastructure encryption ${AT_CREATION}`,
    queue_encryption_key_type: `the queue encryption key type ${AT_CREATION}`,
    table_encryption_key_type: `the table encryption key type ${AT_CREATION}`,
  },
  // AZ-05
  azurerm_kubernetes_cluster: {
    dns_prefix: "an AKS cluster's DNS prefix cannot change",
    network_profile: "the cluster network settings are fixed at creation",
    linux_profile: "the Linux admin user and SSH key are fixed at creation (a surprise ForceNew)",
    private_cluster_enabled: "a cluster cannot switch between private and public API server",
    node_resource_group: `the node resource group ${AT_CREATION}`,
    default_node_pool: "the default node pool cannot be renamed unless temporary_name_for_rotation is set",
    role_based_access_control_enabled: `Kubernetes RBAC ${AT_CREATION}`,
  },
  // GCP-01
  google_sql_database_instance: {
    encryption_key_name: `the customer-managed encryption key ${AT_CREATION}`,
    settings: "the instance collation is fixed at creation",
    replica_configuration: "replica configuration cannot change in place",
    master_instance_name: "an instance cannot switch its primary in place",
  },
  // GCP-02
  google_storage_bucket: {
    enable_object_retention: `object retention ${AT_CREATION}`,
    custom_placement_config: "a dual-region bucket's regions are fixed",
    hierarchical_namespace: `the hierarchical namespace ${AT_CREATION}`,
    retention_policy: "a locked retention policy cannot be unlocked",
  },
  // GCP-03
  google_container_cluster: {
    network: "a GKE cluster cannot move to another VPC network",
    subnetwork: "a GKE cluster cannot move to another subnetwork",
    description: "a GKE cluster's description cannot change in place (a surprise ForceNew)",
    ip_allocation_policy: "pod and service IP ranges are fixed at creation",
    private_cluster_config: "the control-plane CIDR is fixed at creation",
    enable_autopilot: "a cluster cannot switch between Standard and Autopilot",
    initial_node_count: "the inline default node pool size is fixed at creation",
    node_pool: "inline node pools cannot change in place",
  },
};

/** Attributes that force replacement on most types, with a generic explanation. */
const COMMON_FORCE_NEW: Readonly<Record<string, string>> = {
  name: "the name cannot be changed in place, so a new one is created under the new name",
  location: "Azure and Google resources cannot move to another location in place",
  region: "a resource cannot move to another region in place",
  project: "a resource cannot move to another project in place",
  resource_group_name: "Azure resources cannot move to another resource group in place",
  vpc_id: "it cannot move to another VPC",
  availability_zone: "it cannot move to another availability zone",
  kms_key_id: `the encryption key ${AT_CREATION}`,
  kms_key_arn: `the encryption key ${AT_CREATION}`,
  encrypted: "encryption cannot be added or removed in place",
  storage_encrypted: "storage encryption cannot be added or removed in place",
  engine: "the engine cannot change in place",
  subnet_id: "it cannot move to another subnet",
  triggers_replace: "a trigger value changed, which always replaces this resource",
  bucket: "a bucket setting cannot move to another bucket in place",
  triggers: "a trigger value changed, which always replaces this resource",
};

/** Why a replace path cannot change in place, from the type table or the common table; null when unlisted. */
export function forceNewExplanation(type: string, path: AttrPath): string | null {
  const steps = path.filter((s): s is string => typeof s === "string");
  const table = FORCE_NEW[type] ?? {};
  for (let n = steps.length; n >= 1; n--) {
    const hit = table[steps.slice(0, n).join(".")];
    if (hit) return hit;
  }
  if (type === "aws_security_group_rule")
    return "every argument of aws_security_group_rule forces a new rule"; // AWS-27
  return COMMON_FORCE_NEW[steps[0] ?? ""] ?? null;
}

/** Plain-words reason a replace path cannot change in place, with a generic fallback for unlisted attributes. */
export function explainForceNew(type: string, path: AttrPath): string {
  return (
    forceNewExplanation(type, path) ??
    `${formatPath(path) || "this attribute"} cannot be changed in place, so the provider replaces it`
  );
}

/** True when the attribute is in the force-new table for the type (used by PLAN-14). */
export function isForceNewAttribute(type: string, attr: string): boolean {
  return Boolean(FORCE_NEW[type]?.[attr]);
}

// ───────────────────────────── attribute rules ─────────────────────────────

const turnedOff = (b: unknown, a: unknown): boolean =>
  b === true && (a === false || a === null || a === undefined);
const turnedOn = (b: unknown, a: unknown): boolean => a === true && b !== true;
const switchedOn = (b: unknown, a: unknown): boolean => a === true && b === false;
const toZero = (b: unknown, a: unknown): boolean => typeof b === "number" && b > 0 && a === 0;
const valueChanged = (b: unknown, a: unknown): boolean =>
  b !== undefined && b !== null && b !== "" && !deepEqual(b, a ?? null);
const boolChanged = (b: unknown, a: unknown): boolean =>
  typeof b === "boolean" && (typeof a === "boolean" || a === null) && Boolean(a) !== b;
const removedValue = (b: unknown, a: unknown): boolean => nonEmpty(b) && !nonEmpty(a);
const becomes =
  (values: readonly string[]) =>
  (b: unknown, a: unknown): boolean =>
    typeof a === "string" && values.includes(a) && !(typeof b === "string" && values.includes(b));
const leaves =
  (value: string) =>
  (b: unknown, a: unknown): boolean =>
    b === value && typeof a === "string" && a !== value;

/** U01/U02: high, critical when the same plan also destroys the object. */
const guardSeverity = (x: RuleInput): Severity =>
  x.change.action === "replace" || x.ctx.destroysSameConfig(x.change) ? "critical" : "high";
const guardTail = (x: RuleInput): string =>
  x.change.action === "replace" || x.ctx.destroysSameConfig(x.change)
    ? ", and this plan also destroys it"
    : ": the next destroy, by a later plan or by hand, goes through without a check";

const noun = (x: RuleInput): string => classify(x.change.type).noun;

const RDS_LIKE = ["aws_db_instance", "aws_rds_cluster", "aws_docdb_cluster", "aws_neptune_cluster"];
const SNAPSHOT_TYPES = [...RDS_LIKE, "aws_redshift_cluster"];
const PUBLIC_S3_ACLS = ["public-read", "public-read-write", "authenticated-read"];
const PAB_TYPES = ["aws_s3_bucket_public_access_block", "aws_s3_account_public_access_block"];
const ALL_WRITES: readonly RuleAction[] = ["create", "update", "replace", "import"];
const UPDATE_OR_REPLACE: readonly RuleAction[] = ["update", "replace", "import"];

function rule(
  id: string,
  ruleId: string,
  types: readonly string[],
  path: AttrPath,
  when: AttributeRule["when"],
  severity: AttributeRule["severity"],
  reason: AttributeRule["reason"],
  on?: readonly RuleAction[],
): AttributeRule {
  return { id, ruleId, types, path, when, severity, reason, ...(on && { on }) };
}

export const ATTRIBUTE_RULES: readonly AttributeRule[] = [
  // ── AWS-U01 deletion guard switched off (GCP-01 / GCP-03 equivalents) ──
  ...(
    [
      ["AWS-U01", [...RDS_LIKE, "aws_rds_global_cluster"], ["deletion_protection"]],
      ["AWS-U01", ["aws_dynamodb_table"], ["deletion_protection_enabled"]],
      ["AWS-U01", ["aws_dynamodb_table"], ["replica", "*", "deletion_protection_enabled"]],
      ["AWS-U01", ["aws_lb", "aws_alb"], ["enable_deletion_protection"]],
      ["AWS-U01", ["aws_eks_cluster"], ["deletion_protection"]],
      ["AWS-U01", ["aws_instance"], ["disable_api_termination"]],
      ["GCP-01", ["google_sql_database_instance", "google_container_cluster"], ["deletion_protection"]],
      ["GCP-01", ["google_sql_database_instance"], ["settings", "*", "deletion_protection_enabled"]],
    ] as const
  ).map(([id, types, path]) =>
    rule(
      id,
      "deletion-protection-off",
      types,
      [...path],
      turnedOff,
      guardSeverity,
      (x) =>
        `${x.attr} ${transition(x.before, x.after)} removes the guard against deleting the ${noun(x.input)}${guardTail(x.input)}.`,
      UPDATE_OR_REPLACE,
    ),
  ),
  rule(
    "AWS-U01",
    "deletion-protection-off",
    ["aws_cognito_user_pool"],
    ["deletion_protection"],
    leaves("ACTIVE"),
    guardSeverity,
    (x) =>
      `${x.attr} ${transition(x.before, x.after)} removes the guard against deleting the user pool${guardTail(x.input)}.`,
    UPDATE_OR_REPLACE,
  ),
  // ── AWS-U02 final snapshot / backups off ──
  rule(
    "AWS-U02",
    "final-snapshot-off",
    SNAPSHOT_TYPES,
    ["skip_final_snapshot"],
    switchedOn,
    guardSeverity,
    (x) =>
      `${x.attr} ${transition(x.before, x.after)} means no final snapshot is taken when the ${noun(x.input)} is destroyed${x.input.change.action === "replace" || x.input.ctx.destroysSameConfig(x.input.change) ? ", and this plan destroys it" : ""}.`,
    UPDATE_OR_REPLACE,
  ),
  rule(
    "AWS-U02",
    "final-snapshot-off",
    SNAPSHOT_TYPES,
    ["final_snapshot_identifier"],
    removedValue,
    guardSeverity,
    (x) =>
      `${x.attr} is removed (${fmtValue(x.before)} → null), so no final snapshot is named for when the ${noun(x.input)} is destroyed.`,
    UPDATE_OR_REPLACE,
  ),
  rule(
    "AWS-U02",
    "backups-off",
    ["aws_db_instance"],
    ["delete_automated_backups"],
    switchedOn,
    guardSeverity,
    (x) =>
      `${x.attr} ${transition(x.before, x.after)} deletes the automated backups together with the database when it is destroyed.`,
    UPDATE_OR_REPLACE,
  ),
  rule(
    "AWS-U02",
    "backups-off",
    ["aws_db_instance", "aws_rds_cluster"],
    ["backup_retention_period"],
    toZero,
    guardSeverity,
    (x) =>
      `${x.attr} ${transition(x.before, x.after)} turns automated backups off: applying it deletes the existing automated backups and point-in-time recovery, with a brief outage while the instance restarts.`,
    UPDATE_OR_REPLACE,
  ),
  rule(
    "GCP-04",
    "backups-off",
    ["google_sql_database_instance"],
    ["settings", "*", "backup_configuration", "*", "enabled"],
    turnedOff,
    "high",
    (x) =>
      `${x.attr} ${transition(x.before, x.after)} turns automated backups off, leaving no recovery point.`,
  ),
  // ── AWS-U04 exposure, replica promotion ──
  rule(
    "AWS-U04",
    "db-public",
    ["aws_db_instance", "aws_rds_cluster", "aws_rds_cluster_instance", "aws_redshift_cluster"],
    ["publicly_accessible"],
    turnedOn,
    "critical",
    (x) =>
      `${x.attr} ${transition(x.before, x.after)} gives the ${noun(x.input)} a public endpoint, and AWS applies this immediately.`,
    ALL_WRITES,
  ),
  rule(
    "AWS-U04",
    "replica-promoted",
    ["aws_db_instance"],
    ["replicate_source_db"],
    removedValue,
    "high",
    (x) =>
      `${x.attr} is removed (${fmtValue(x.before)} → null), which promotes the replica to a standalone database, so replication silently stops.`,
  ),
  rule(
    "AWS-U04",
    "replica-promoted",
    ["aws_rds_cluster"],
    ["replication_source_identifier"],
    removedValue,
    "high",
    (x) =>
      `${x.attr} is removed (${fmtValue(x.before)} → null), which promotes the cluster to standalone, so replication silently stops.`,
  ),
  rule(
    "AWS-U04",
    "managed-password-toggled",
    [...RDS_LIKE, "aws_redshift_cluster"],
    ["manage_master_user_password"],
    boolChanged,
    "medium",
    (x) =>
      `${x.attr} ${transition(x.before, x.after)} switches who owns the master password, so applications reading it from the old place must be updated.`,
  ),
  // ── AWS-U05 S3 public exposure ──
  ...["block_public_acls", "block_public_policy", "ignore_public_acls", "restrict_public_buckets"].map(
    (attr) =>
      rule(
        "AWS-U05",
        "s3-public-access-block-off",
        PAB_TYPES,
        [attr],
        turnedOff,
        "critical",
        (x) =>
          `${x.attr} ${transition(x.before, x.after)} removes a guard against public S3 access, so a public ACL or bucket policy can now expose data.`,
      ),
  ),
  rule(
    "AWS-U05",
    "s3-public-acl",
    ["aws_s3_bucket_acl", "aws_s3_bucket"],
    ["acl"],
    becomes(PUBLIC_S3_ACLS),
    "critical",
    (x) => `${x.attr} ${transition(x.before, x.after)} makes the bucket readable outside the account.`,
    ALL_WRITES,
  ),
  rule(
    "AWS-U05",
    "s3-public-acl",
    ["aws_s3_object"],
    ["acl"],
    becomes(PUBLIC_S3_ACLS),
    "high",
    (x) => `${x.attr} ${transition(x.before, x.after)} makes the object readable outside the account.`,
    ALL_WRITES,
  ),
  // ── AWS-U06 recoverability ──
  rule(
    "AWS-U06",
    "versioning-suspended",
    ["aws_s3_bucket_versioning"],
    ["versioning_configuration", "*", "status"],
    leaves("Enabled"),
    "high",
    (x) =>
      `${x.attr} ${transition(x.before, x.after)} stops keeping old object versions, so overwritten or deleted objects can no longer be recovered.`,
    UPDATE_OR_REPLACE,
  ),
  rule(
    "AWS-U06",
    "versioning-suspended",
    ["aws_s3_bucket"],
    ["versioning", "*", "enabled"],
    turnedOff,
    "high",
    (x) =>
      `${x.attr} ${transition(x.before, x.after)} stops keeping old object versions, so overwritten or deleted objects can no longer be recovered.`,
  ),
  rule(
    "AWS-U06",
    "force-destroy-armed",
    ["aws_s3_bucket", "google_storage_bucket"],
    ["force_destroy"],
    switchedOn,
    "high",
    (x) =>
      `${x.attr} ${transition(x.before, x.after)} arms unrecoverable deletion: destroying the bucket later deletes every object in it.`,
  ),
  rule(
    "AWS-U06",
    "encryption-key-changed",
    ["aws_s3_bucket_server_side_encryption_configuration"],
    ["rule", "*", "apply_server_side_encryption_by_default", "*", "kms_master_key_id"],
    valueChanged,
    "medium",
    (x) =>
      `${x.attr} ${transition(x.before, x.after)} encrypts new objects with a different key, so readers need access to it.`,
  ),
  // ── GCP-02 bucket recoverability / exposure ──
  rule(
    "GCP-02",
    "versioning-suspended",
    ["google_storage_bucket"],
    ["versioning", "*", "enabled"],
    turnedOff,
    "high",
    (x) =>
      `${x.attr} ${transition(x.before, x.after)} stops keeping noncurrent object versions, so overwritten or deleted objects can no longer be recovered.`,
  ),
  rule(
    "GCP-02",
    "bucket-public-access-prevention-off",
    ["google_storage_bucket"],
    ["public_access_prevention"],
    leaves("enforced"),
    "high",
    (x) =>
      `${x.attr} ${transition(x.before, x.after)} allows the bucket to be made public through IAM or ACLs.`,
  ),
  // ── AZ-03 storage account exposure ──
  rule(
    "AZ-03",
    "storage-public",
    ["azurerm_storage_account"],
    ["allow_nested_items_to_be_public"],
    switchedOn,
    "high",
    (x) => `${x.attr} ${transition(x.before, x.after)} lets containers in the account be made public.`,
  ),
  rule(
    "AZ-03",
    "storage-shared-key-on",
    ["azurerm_storage_account"],
    ["shared_access_key_enabled"],
    switchedOn,
    "high",
    (x) =>
      `${x.attr} ${transition(x.before, x.after)} allows account-key and SAS access, which bypasses Entra ID.`,
  ),
  rule(
    "AZ-03",
    "storage-https-off",
    ["azurerm_storage_account"],
    ["https_traffic_only_enabled"],
    turnedOff,
    "high",
    (x) =>
      `${x.attr} ${transition(x.before, x.after)} allows unencrypted HTTP access to the storage account.`,
  ),
  rule(
    "AZ-03",
    "network-default-allow",
    ["azurerm_storage_account", "azurerm_key_vault"],
    ["network_rules", "*", "default_action"],
    becomes(["Allow"]),
    "high",
    (x) => `${x.attr} ${transition(x.before, x.after)} opens the service to every network.`,
  ),
  rule(
    "AZ-04",
    "network-default-allow",
    ["azurerm_key_vault"],
    ["network_acls", "*", "default_action"],
    becomes(["Allow"]),
    "high",
    (x) => `${x.attr} ${transition(x.before, x.after)} opens the vault to every network.`,
  ),
  rule(
    "AZ-03",
    "public-network-access-on",
    ["azurerm_storage_account"],
    ["public_network_access"],
    becomes(["Enabled"]),
    "high",
    (x) => `${x.attr} ${transition(x.before, x.after)} exposes the account's public endpoint.`,
  ),
  rule(
    "AZ-03",
    "public-network-access-on",
    ["azurerm_storage_account", "azurerm_key_vault"],
    ["public_network_access_enabled"],
    switchedOn,
    "high",
    (x) => `${x.attr} ${transition(x.before, x.after)} exposes the public endpoint.`,
  ),
  rule(
    "AZ-03",
    "storage-soft-delete-off",
    ["azurerm_storage_account"],
    ["blob_properties", "*", "delete_retention_policy"],
    removedValue,
    "high",
    (x) => `${x.attr} is removed, so deleted blobs can no longer be restored.`,
  ),
  rule(
    "AZ-03",
    "storage-soft-delete-off",
    ["azurerm_storage_account"],
    ["blob_properties", "*", "container_delete_retention_policy"],
    removedValue,
    "high",
    (x) => `${x.attr} is removed, so deleted containers can no longer be restored.`,
  ),
  rule(
    "AZ-03",
    "versioning-suspended",
    ["azurerm_storage_account"],
    ["blob_properties", "*", "versioning_enabled"],
    turnedOff,
    "high",
    (x) => `${x.attr} ${transition(x.before, x.after)} stops keeping previous blob versions.`,
  ),
  rule(
    "AZ-04",
    "key-vault-access-model-changed",
    ["azurerm_key_vault"],
    ["rbac_authorization_enabled"],
    boolChanged,
    "high",
    (x) =>
      `${x.attr} ${transition(x.before, x.after)} switches the vault's whole access model, so existing access policies or role assignments stop applying.`,
  ),
  rule(
    "AZ-04",
    "key-vault-access-model-changed",
    ["azurerm_key_vault"],
    ["enable_rbac_authorization"],
    boolChanged,
    "high",
    (x) =>
      `${x.attr} ${transition(x.before, x.after)} switches the vault's whole access model, so existing access policies or role assignments stop applying.`,
  ),
  // ── AWS-U09 audit and detection off ──
  rule(
    "AWS-U09",
    "audit-off",
    ["aws_cloudtrail"],
    ["enable_logging"],
    turnedOff,
    "high",
    (x) => `${x.attr} ${transition(x.before, x.after)} stops CloudTrail recording API activity.`,
  ),
  rule(
    "AWS-U09",
    "audit-off",
    ["aws_cloudtrail"],
    ["is_multi_region_trail"],
    turnedOff,
    "high",
    (x) => `${x.attr} ${transition(x.before, x.after)} stops recording API activity in every other region.`,
  ),
  rule(
    "AWS-U09",
    "audit-off",
    ["aws_config_configuration_recorder_status"],
    ["is_enabled"],
    turnedOff,
    "high",
    (x) => `${x.attr} ${transition(x.before, x.after)} stops AWS Config recording configuration changes.`,
  ),
  rule(
    "AWS-U09",
    "audit-off",
    ["aws_guardduty_detector"],
    ["enable"],
    turnedOff,
    "high",
    (x) => `${x.attr} ${transition(x.before, x.after)} stops GuardDuty threat detection.`,
  ),
  rule(
    "AWS-U09",
    "access-logs-off",
    ["aws_lb", "aws_alb"],
    ["access_logs", "*", "enabled"],
    turnedOff,
    "medium",
    (x) => `${x.attr} ${transition(x.before, x.after)} stops load balancer access logging.`,
  ),
  // ── AWS-U10 capacity to zero / failover off ──
  ...(
    [
      ["aws_autoscaling_group", ["min_size"]],
      ["aws_autoscaling_group", ["desired_capacity"]],
      ["aws_autoscaling_group", ["max_size"]],
      ["aws_eks_node_group", ["scaling_config", "*", "min_size"]],
      ["aws_eks_node_group", ["scaling_config", "*", "desired_size"]],
      ["aws_ecs_service", ["desired_count"]],
      ["aws_appautoscaling_target", ["min_capacity"]],
    ] as const
  ).map(([type, path]) =>
    rule(
      "AWS-U10",
      "capacity-zero",
      [type],
      [...path],
      toZero,
      "high",
      (x) =>
        `${x.attr} ${transition(x.before, x.after)} scales the ${noun(x.input)} to zero, which is an outage.`,
    ),
  ),
  ...(
    [
      ["aws_elasticache_replication_group", "automatic_failover_enabled"],
      ["aws_elasticache_replication_group", "multi_az_enabled"],
      ["aws_db_instance", "multi_az"],
    ] as const
  ).map(([type, attr]) =>
    rule(
      "AWS-U10",
      "failover-off",
      [type],
      [attr],
      turnedOff,
      "high",
      (x) =>
        `${x.attr} ${transition(x.before, x.after)} removes the standby, so a zone or node failure becomes an outage.`,
    ),
  ),
  rule(
    "GCP-04",
    "failover-off",
    ["google_sql_database_instance"],
    ["settings", "*", "availability_type"],
    leaves("REGIONAL"),
    "high",
    (x) =>
      `${x.attr} ${transition(x.before, x.after)} removes the standby, so a zone failure becomes an outage.`,
  ),
  // ── AWS-U11 DynamoDB / EKS ──
  rule(
    "AWS-U11",
    "pitr-off",
    ["aws_dynamodb_table"],
    ["point_in_time_recovery", "*", "enabled"],
    turnedOff,
    "high",
    (x) =>
      `${x.attr} ${transition(x.before, x.after)} turns point-in-time recovery off, so the table can no longer be restored to an earlier moment.`,
  ),
  rule(
    "AWS-U11",
    "stream-changed",
    ["aws_dynamodb_table"],
    ["stream_enabled"],
    boolChanged,
    "high",
    (x) =>
      `${x.attr} ${transition(x.before, x.after)} changes the table's stream ARN, so Lambda event-source mappings and other consumers of the old stream break.`,
  ),
  rule(
    "AWS-U11",
    "stream-changed",
    ["aws_dynamodb_table"],
    ["stream_view_type"],
    (b, a) => typeof b === "string" && b !== "" && typeof a === "string" && a !== "" && a !== b,
    "high",
    (x) =>
      `${x.attr} ${transition(x.before, x.after)} recreates the table's stream with a new ARN, so its consumers break.`,
  ),
  rule(
    "AWS-U11",
    "ttl-changed",
    ["aws_dynamodb_table"],
    ["ttl", "*", "enabled"],
    boolChanged,
    "medium",
    (x) => `${x.attr} ${transition(x.before, x.after)} changes which items DynamoDB expires automatically.`,
  ),
  rule(
    "AWS-U11",
    "ttl-changed",
    ["aws_dynamodb_table"],
    ["ttl", "*", "attribute_name"],
    valueChanged,
    "medium",
    (x) => `${x.attr} ${transition(x.before, x.after)} changes which items DynamoDB expires automatically.`,
  ),
  // AWS-25 EKS in place
  rule(
    "AWS-25",
    "eks-upgrade",
    ["aws_eks_cluster"],
    ["version"],
    valueChanged,
    "high",
    (x) =>
      `${x.attr} ${transition(x.before, x.after)} upgrades the Kubernetes control plane, which cannot be rolled back.`,
  ),
  rule(
    "AWS-25",
    "eks-network-change",
    ["aws_eks_cluster"],
    ["vpc_config", "*", "subnet_ids"],
    valueChanged,
    "medium",
    (x) => `${x.attr} changes the control plane's subnets in place (${transition(x.before, x.after)}).`,
  ),
  rule(
    "AWS-25",
    "eks-network-change",
    ["aws_eks_cluster"],
    ["vpc_config", "*", "security_group_ids"],
    valueChanged,
    "medium",
    (x) =>
      `${x.attr} changes the control plane's security groups in place (${transition(x.before, x.after)}).`,
  ),
  // ── AWS-14 retention / DLQ ──
  rule(
    "AWS-14",
    "dlq-removed",
    ["aws_sqs_queue"],
    ["redrive_policy"],
    removedValue,
    "medium",
    (x) => `${x.attr} is removed, so messages that keep failing are no longer moved to a dead-letter queue.`,
  ),
  // ── AWS-15 KMS ──
  rule(
    "AWS-15",
    "kms-key-disabled",
    ["aws_kms_key"],
    ["is_enabled"],
    turnedOff,
    "critical",
    (x) =>
      `${x.attr} ${transition(x.before, x.after)} disables the key, so everything encrypted with it becomes unreadable immediately.`,
  ),
  rule(
    "AWS-15",
    "kms-lockout-check-bypassed",
    ["aws_kms_key"],
    ["bypass_policy_lockout_safety_check"],
    turnedOn,
    "high",
    (x) =>
      `${x.attr} ${transition(x.before, x.after)} skips the check that stops a policy from locking everyone out of the key.`,
    ALL_WRITES,
  ),
  rule(
    "AWS-15",
    "kms-rotation-off",
    ["aws_kms_key"],
    ["enable_key_rotation"],
    turnedOff,
    "medium",
    (x) => `${x.attr} ${transition(x.before, x.after)} stops automatic key rotation.`,
  ),
  rule(
    "AWS-15",
    "kms-alias-retarget",
    ["aws_kms_alias"],
    ["target_key_id"],
    valueChanged,
    "high",
    (x) =>
      `${x.attr} ${transition(x.before, x.after)} points the alias at another key, so new data is encrypted with a different key than before.`,
  ),
  // ── AWS-20 CloudFront ──
  rule(
    "AWS-20",
    "cdn-disabled",
    ["aws_cloudfront_distribution"],
    ["enabled"],
    turnedOff,
    "high",
    (x) => `${x.attr} ${transition(x.before, x.after)} stops the distribution serving traffic.`,
  ),
  rule(
    "AWS-20",
    "waf-detached",
    ["aws_cloudfront_distribution"],
    ["web_acl_id"],
    valueChanged,
    "high",
    (x) =>
      `${x.attr} ${transition(x.before, x.after)} ${nonEmpty(x.after) ? "switches the distribution to another WAF" : "detaches WAF from the distribution"}.`,
  ),
  rule(
    "AWS-20",
    "cdn-aliases-changed",
    ["aws_cloudfront_distribution"],
    ["aliases"],
    valueChanged,
    "high",
    (x) =>
      `${x.attr} ${transition(x.before, x.after)} changes which host names the distribution answers for.`,
  ),
  rule(
    "AWS-20",
    "cdn-origin-changed",
    ["aws_cloudfront_distribution"],
    ["default_cache_behavior", "*", "target_origin_id"],
    valueChanged,
    "medium",
    (x) => `${x.attr} ${transition(x.before, x.after)} sends default traffic to another origin.`,
  ),
  // ── AWS-17 DNS answers ──
  rule(
    "AWS-17",
    "dns-answer-changed",
    ["aws_route53_record"],
    ["records"],
    valueChanged,
    "medium",
    (x) => `${x.attr} ${transition(x.before, x.after)} changes what the name resolves to.`,
  ),
  rule(
    "AWS-17",
    "dns-answer-changed",
    ["aws_route53_record"],
    ["alias"],
    valueChanged,
    "medium",
    () => "The alias target changes, so the name resolves to a different endpoint.",
  ),
  // ── GCP-01 / GCP-04 Cloud SQL in place ──
  rule(
    "GCP-01",
    "db-major-upgrade",
    ["google_sql_database_instance"],
    ["database_version"],
    valueChanged,
    "high",
    (x) => `${x.attr} ${transition(x.before, x.after)} upgrades the database engine in place, with downtime.`,
  ),
  rule(
    "GCP-04",
    "db-restart",
    ["google_sql_database_instance"],
    ["settings", "*", "tier"],
    valueChanged,
    "medium",
    (x) => `${x.attr} ${transition(x.before, x.after)} restarts the instance.`,
  ),
  rule(
    "GCP-04",
    "pitr-off",
    ["google_sql_database_instance"],
    ["settings", "*", "backup_configuration", "*", "point_in_time_recovery_enabled"],
    turnedOff,
    "medium",
    (x) => `${x.attr} ${transition(x.before, x.after)} turns point-in-time recovery off.`,
  ),
  // ── NOISE-02 follow-on: a new task definition revision rolls the service ──
  rule(
    "NOISE-02",
    "ecs-rolling-deploy",
    ["aws_ecs_service"],
    ["task_definition"],
    valueChanged,
    "medium",
    (x) => `${x.attr} ${transition(x.before, x.after)} starts a rolling deployment of the service.`,
  ),
];

// ───────────────────────────── change rules ─────────────────────────────

/** Admin and data ports (AWS-U07 heuristic list), with names for reasons. */
export const SENSITIVE_PORTS: Readonly<Record<number, string>> = {
  22: "SSH",
  3389: "RDP",
  3306: "MySQL",
  5432: "PostgreSQL",
  1433: "SQL Server",
  1521: "Oracle",
  6379: "Redis",
  11211: "Memcached",
  9200: "Elasticsearch",
  9300: "Elasticsearch",
  27017: "MongoDB",
  2379: "etcd",
  6443: "Kubernetes API",
  10250: "kubelet",
};

const WORLD = new Set(["0.0.0.0/0", "::/0", "*", "Internet", "Any", "any", "internet"]);

interface Exposure {
  protocol: string;
  from: number | null;
  to: number | null;
  source: string;
}

function toPort(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return null;
}

function portRanges(v: unknown): [number | null, number | null][] {
  const list = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
  if (!list.length) return [[null, null]];
  return list.map((p) => {
    const s = String(p);
    if (s === "*") return [null, null];
    const m = /^(\d+)(?:-(\d+))?$/.exec(s);
    if (!m) return [null, null];
    return [Number(m[1]), Number(m[2] ?? m[1])];
  });
}

/** World-open ingress entries of one object, per resource type (AWS-U07 and its GCP/Azure analogues). */
function worldIngress(type: string, v: unknown): Exposure[] {
  const o = asRecord(v);
  const out: Exposure[] = [];
  const pushCidrs = (cidrs: unknown[], protocol: unknown, from: unknown, to: unknown): void => {
    for (const c of cidrs) {
      if (typeof c === "string" && WORLD.has(c)) {
        out.push({
          protocol: String(protocol ?? "tcp").toLowerCase(),
          from: toPort(from),
          to: toPort(to),
          source: c,
        });
      }
    }
  };
  if (type === "aws_security_group" || type === "aws_default_security_group") {
    for (const r of asArray(o.ingress)) {
      const ing = asRecord(r);
      pushCidrs(
        [...asArray(ing.cidr_blocks), ...asArray(ing.ipv6_cidr_blocks)],
        ing.protocol,
        ing.from_port,
        ing.to_port,
      );
    }
  } else if (type === "aws_security_group_rule") {
    if (o.type === "ingress") {
      pushCidrs(
        [...asArray(o.cidr_blocks), ...asArray(o.ipv6_cidr_blocks)],
        o.protocol,
        o.from_port,
        o.to_port,
      );
    }
  } else if (type === "aws_vpc_security_group_ingress_rule") {
    pushCidrs([o.cidr_ipv4, o.cidr_ipv6], o.ip_protocol, o.from_port, o.to_port);
  } else if (type === "google_compute_firewall") {
    const direction = o.direction ?? "INGRESS";
    const sources = asArray(o.source_ranges).filter((s) => typeof s === "string" && WORLD.has(s));
    if (direction === "INGRESS" && sources.length) {
      for (const a of asArray(o.allow)) {
        const allow = asRecord(a);
        for (const [from, to] of portRanges(allow.ports)) {
          out.push({
            protocol: String(allow.protocol ?? "all").toLowerCase(),
            from,
            to,
            source: String(sources[0]),
          });
        }
      }
    }
  } else if (type === "azurerm_network_security_rule" || type === "azurerm_network_security_group") {
    const rules = type === "azurerm_network_security_rule" ? [o] : asArray(o.security_rule).map(asRecord);
    for (const r of rules) {
      if (r.direction !== "Inbound" || r.access !== "Allow") continue;
      const sources = [r.source_address_prefix, ...asArray(r.source_address_prefixes)].filter(
        (s) => typeof s === "string" && WORLD.has(s),
      );
      if (!sources.length) continue;
      const ports = [r.destination_port_range, ...asArray(r.destination_port_ranges)].filter((p) =>
        nonEmpty(p),
      );
      for (const [from, to] of portRanges(ports.length ? ports : ["*"])) {
        out.push({ protocol: String(r.protocol ?? "*").toLowerCase(), from, to, source: String(sources[0]) });
      }
    }
  }
  return out;
}

const ALL_PROTOCOLS = new Set(["-1", "all", "*"]);
const ICMP = new Set(["icmp", "icmpv6", "1", "58"]);

function exposureSeverity(e: Exposure): { severity: Severity; what: string } {
  if (ALL_PROTOCOLS.has(e.protocol)) return { severity: "critical", what: "all traffic on every port" };
  if (ICMP.has(e.protocol)) return { severity: "low", what: "ICMP (ping)" };
  const from = e.from ?? 0;
  const to = e.to ?? 65535;
  const proto = e.protocol.toUpperCase();
  const range = from === to ? `${proto} port ${from}` : `${proto} ports ${from}-${to}`;
  const hit = Object.entries(SENSITIVE_PORTS).filter(([p]) => Number(p) >= from && Number(p) <= to);
  if (hit.length) {
    const names = [...new Set(hit.map(([, n]) => n))].slice(0, 3).join(", ");
    return { severity: "critical", what: `${range} (${names})` };
  }
  if (from === to && (from === 80 || from === 443)) return { severity: "low", what: range };
  return { severity: "high", what: range };
}

const exposureKey = (e: Exposure): string => `${e.protocol}|${e.from}|${e.to}|${e.source}`;

/** AWS-U07: ingress newly open to 0.0.0.0/0 or ::/0 (inline blocks, rule resources, new resources). */
const sgOpenWorld: ChangeRule = {
  id: "AWS-U07",
  types: [
    "aws_security_group",
    "aws_default_security_group",
    "aws_security_group_rule",
    "aws_vpc_security_group_ingress_rule",
    "google_compute_firewall",
    "azurerm_network_security_rule",
    "azurerm_network_security_group",
  ],
  on: ALL_WRITES,
  evaluate(x) {
    const type = x.change.type;
    const before = new Set(worldIngress(type, x.before).map(exposureKey));
    const added = worldIngress(type, x.after).filter((e) => !before.has(exposureKey(e)));
    if (!added.length) return [];
    const judged = added
      .map((e) => ({ e, ...exposureSeverity(e) }))
      .sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
    const worst = judged[0]!;
    const more =
      judged.length > 1 ? ` (plus ${judged.length - 1} more open rule${judged.length > 2 ? "s" : ""})` : "";
    const verb = x.action === "create" ? "allows" : "now allows";
    const tail =
      worst.severity === "low"
        ? ", which is normal for a public web endpoint"
        : ", so anyone on the internet can reach it";
    return [
      {
        ruleId: "sg-open-world",
        severity: worst.severity,
        reason: `Ingress ${verb} ${worst.what} from ${worst.e.source}${more}${tail}.`,
      },
    ];
  },
};

/** AWS-U08 / AWS-U05: policy JSON analysis (see policy.ts). */
const policyRule: ChangeRule = {
  id: "AWS-U08",
  types: Object.keys(POLICY_ATTRIBUTES),
  on: ALL_WRITES,
  evaluate(x) {
    const hits: RuleHit[] = [];
    for (const spec of POLICY_ATTRIBUTES[x.change.type] ?? []) {
      const paths = expandPattern([x.before, x.after], spec.path);
      if (paths.some((p) => isUnknownAt(x.change.afterUnknown, p))) continue;
      const docs = (side: Rec): ReturnType<typeof mergePolicyDocuments> =>
        mergePolicyDocuments(
          expandPattern([side], spec.path).map((p) => parsePolicyDocument(getAtPath(side, p))),
        );
      const attr = leafName(spec.path);
      const findings = analyzePolicyChange(docs(x.before), docs(x.after), spec.kind, {
        attr,
        isCreate: x.action === "create",
        knownAccounts: x.ctx.knownAccounts,
      });
      for (const f of findings) hits.push({ ...f, path: spec.path.filter((s) => s !== "*") });
    }
    return hits;
  },
};

/** AWS-U08: AdministratorAccess / PowerUserAccess / IAMFullAccess attached. */
const adminAttachment: ChangeRule = {
  id: "AWS-U08",
  types: [
    "aws_iam_role_policy_attachment",
    "aws_iam_user_policy_attachment",
    "aws_iam_group_policy_attachment",
    "aws_iam_policy_attachment",
    "aws_iam_role",
    "aws_iam_role_policy_attachments_exclusive",
    "aws_ssoadmin_managed_policy_attachment",
  ],
  on: ALL_WRITES,
  evaluate(x) {
    const arns = (o: Rec): string[] =>
      [
        o.policy_arn,
        o.managed_policy_arn,
        ...asArray(o.managed_policy_arns),
        ...asArray(o.policy_arns),
      ].filter((a): a is string => typeof a === "string");
    const before = new Set(arns(x.before));
    const added = arns(x.after).filter((a) => isAdminPolicyArn(a) && !before.has(a));
    const first = added[0];
    if (!first) return [];
    const who =
      str(x.after.role) ?? str(x.after.user) ?? str(x.after.group) ?? str(x.after.name) ?? "the principal";
    return [
      {
        ruleId: "admin-policy-attached",
        severity: "critical",
        reason: `${first.split("/").pop()} is attached to ${who}, which grants near-full control of the account.`,
      },
    ];
  },
};

/** AWS-15: a KMS key policy change (beyond formatting) can lock out or open up the key. */
const kmsPolicyChange: ChangeRule = {
  id: "AWS-15",
  types: ["aws_kms_key", "aws_kms_key_policy"],
  on: ["update", "import"],
  evaluate(x) {
    if (isUnknownAt(x.change.afterUnknown, ["policy"])) return [];
    const eq = policiesEquivalent(x.before.policy, x.after.policy);
    if (eq !== false) return [];
    return [
      {
        ruleId: "kms-policy-changed",
        severity: "high",
        reason:
          "The KMS key policy changes, which decides who can use and manage the key, so a mistake can lock everyone out or open the key to others.",
        path: ["policy"],
      },
    ];
  },
};

/** AWS-02: aws_db_instance.identifier renames in place; the endpoint changes. */
const rdsIdentifierRename: ChangeRule = {
  id: "AWS-02",
  types: ["aws_db_instance"],
  on: ["update"],
  evaluate(x) {
    const b = x.before.identifier;
    const a = x.after.identifier;
    if (typeof b !== "string" || typeof a !== "string" || a === b) return [];
    const deferred = x.after.apply_immediately !== true ? " (deferred to the next maintenance window)" : "";
    return [
      {
        ruleId: "db-identifier-rename",
        severity: "high",
        reason: `identifier ${transition(b, a)} renames the database in place${deferred}: its endpoint hostname changes, so every connection string that points at it breaks, and AWS documents downtime.`,
        path: ["identifier"],
      },
    ];
  },
};

const RDS_DOWNTIME_ATTRS = [
  "instance_class",
  "engine_version",
  "db_subnet_group_name",
  "port",
  "license_model",
  "network_type",
  "storage_type",
  "ca_cert_identifier",
];

const SIZE_ORDER = ["nano", "micro", "small", "medium", "large"];

/** Rank of an instance size ("db.r6g.2xlarge" → 7); null when it cannot be read. */
export function instanceSizeRank(cls: unknown): { family: string; rank: number } | null {
  if (typeof cls !== "string") return null;
  const m = /^(.*)\.(\d*)x?large$|^(.*)\.(nano|micro|small|medium)$/.exec(cls);
  if (!m) return null;
  if (m[3] !== undefined) return { family: m[3], rank: SIZE_ORDER.indexOf(m[4] ?? "") };
  const family = m[1] ?? "";
  if (!cls.endsWith("xlarge")) return { family, rank: 4 };
  const n = m[2] ? Number(m[2]) : 1;
  return { family, rank: 5 + Math.log2(n) };
}

/** AWS-U03: RDS in-place changes with documented downtime; apply_immediately decides when. */
const rdsDowntime: ChangeRule = {
  id: "AWS-U03",
  types: ["aws_db_instance", "aws_rds_cluster"],
  on: ["update"],
  evaluate(x) {
    const hits: RuleHit[] = [];
    if (x.change.type === "aws_rds_cluster") {
      const b = x.before.engine_version;
      const a = x.after.engine_version;
      if (valueChanged(b, a)) {
        hits.push({
          ruleId: "db-downtime",
          severity: "high",
          reason: `engine_version ${transition(b, a)} upgrades the cluster in place, which the provider documents as an outage.`,
          path: ["engine_version"],
        });
      }
      return hits;
    }
    const changed = RDS_DOWNTIME_ATTRS.filter((k) => valueChanged(x.before[k], x.after[k]));
    if (!changed.length) return [];
    const immediate = x.after.apply_immediately === true;
    const first = changed[0]!;
    const list = changed.map((k) => `${k} ${transition(x.before[k], x.after[k])}`).join(", ");
    const bRank = instanceSizeRank(x.before.instance_class);
    const aRank = instanceSizeRank(x.after.instance_class);
    const downsize = Boolean(bRank && aRank && bRank.family === aRank.family && aRank.rank < bRank.rank);
    const when = immediate
      ? "apply_immediately is true, so the outage happens during this apply"
      : "apply_immediately is false, so the outage is deferred to the next maintenance window";
    hits.push({
      ruleId: "db-downtime",
      severity: immediate || downsize ? "high" : "medium",
      reason: `${list} causes database downtime per AWS${downsize ? " and shrinks the instance" : ""}; ${when}.`,
      path: [first],
    });
    return hits;
  },
};

const CREDENTIAL_NAME =
  /^(master_)?password$|^(master_)?password_wo_version$|^secret_string$|^secret_binary$|^secret_string_wo_version$|^auth_token$|^client_secret$|^admin_password$|^administrator_login_password$|^administrator_password$/;

/** AWS-U04 / AWS-16: a credential changes; consumers holding the old one fail. Value never shown. */
const credentialChange: ChangeRule = {
  id: "AWS-U04",
  types: [],
  on: ["update", "import"],
  evaluate(x) {
    const paths = [...x.change.sensitiveChangedPaths, ...x.change.changedPaths].filter((p) =>
      CREDENTIAL_NAME.test(leafName(p)),
    );
    const first = paths[0];
    if (!first) return [];
    return [
      {
        ruleId: "credential-change",
        severity: "high",
        reason: `${formatPath(first)} changes (value hidden), so applications still using the old credential will fail until they pick up the new one.`,
        path: first,
      },
    ];
  },
};

function lifecycleExpirations(
  o: Rec,
  gcs: boolean,
): Map<string, { days: number | null; noncurrent: number | null }> {
  const out = new Map<string, { days: number | null; noncurrent: number | null }>();
  if (gcs) {
    asArray(o.lifecycle_rule).forEach((r, i) => {
      const rr = asRecord(r);
      const action = asRecord(asArray(rr.action)[0]);
      if (action.type !== "Delete") return;
      const cond = asRecord(asArray(rr.condition)[0]);
      out.set(stableStringify(cond) || String(i), {
        days: typeof cond.age === "number" ? cond.age : null,
        noncurrent: null,
      });
    });
    return out;
  }
  asArray(o.rule).forEach((r, i) => {
    const rr = asRecord(r);
    if (rr.status !== undefined && rr.status !== "Enabled") return;
    const exp = asRecord(asArray(rr.expiration)[0]);
    const nc = asRecord(asArray(rr.noncurrent_version_expiration)[0]);
    const days = typeof exp.days === "number" && exp.days > 0 ? exp.days : nonEmpty(exp.date) ? 0 : null;
    const noncurrent =
      typeof nc.noncurrent_days === "number" && nc.noncurrent_days > 0 ? nc.noncurrent_days : null;
    if (days === null && noncurrent === null) return;
    out.set(str(rr.id) ?? String(i), { days, noncurrent });
  });
  return out;
}

/** AWS-U06 / GCP-02: a lifecycle rule starts (or sooner) deleting objects on a schedule. */
const lifecycleExpiration: ChangeRule = {
  id: "AWS-U06",
  types: ["aws_s3_bucket_lifecycle_configuration", "google_storage_bucket"],
  on: ["create", "update", "replace"],
  evaluate(x) {
    const gcs = x.change.type === "google_storage_bucket";
    if (x.action === "create") {
      // A lifecycle on a bucket created in the same plan is ordinary setup.
      if (gcs) return [];
      const bucket = x.after.bucket;
      if (typeof bucket !== "string" || x.ctx.bucketCreated(bucket)) return [];
    }
    const before = lifecycleExpirations(x.before, gcs);
    const after = lifecycleExpirations(x.after, gcs);
    for (const [id, a] of after) {
      const b = before.get(id);
      const sooner = (bv: number | null | undefined, av: number | null): boolean =>
        av !== null && (bv === null || bv === undefined || av < bv);
      if (!b || sooner(b.days, a.days) || sooner(b.noncurrent, a.noncurrent)) {
        const when =
          a.days !== null
            ? a.days === 0
              ? "on a fixed date"
              : `${a.days} days after they are written`
            : `${a.noncurrent} days after they become noncurrent`;
        const was = b ? ` (was ${b.days ?? b.noncurrent} days)` : "";
        return [
          {
            ruleId: "lifecycle-expiration",
            severity: "high",
            reason: `Lifecycle rule "${id}" now deletes objects ${when}${was}, so data disappears on a schedule.`,
          },
        ];
      }
    }
    return [];
  },
};

/** AWS-U05: grants to the AllUsers / AuthenticatedUsers groups in an S3 ACL. */
const s3AclGrants: ChangeRule = {
  id: "AWS-U05",
  types: ["aws_s3_bucket_acl"],
  on: ALL_WRITES,
  evaluate(x) {
    const publicGrants = (o: Rec): Set<string> => {
      const out = new Set<string>();
      for (const p of asArray(o.access_control_policy)) {
        for (const g of asArray(asRecord(p).grant)) {
          const gr = asRecord(g);
          for (const grantee of asArray(gr.grantee)) {
            const uri = str(asRecord(grantee).uri) ?? "";
            if (/AllUsers|AuthenticatedUsers/.test(uri)) out.add(`${uri}|${String(gr.permission)}`);
          }
        }
      }
      return out;
    };
    const b = publicGrants(x.before);
    const added = [...publicGrants(x.after)].filter((g) => !b.has(g));
    const first = added[0];
    if (!first) return [];
    const [uri, permission] = first.split("|");
    return [
      {
        ruleId: "s3-public-acl",
        severity: "critical",
        reason: `The bucket ACL grants ${permission} to ${uri?.split("/").pop()}, which makes the bucket accessible outside the account.`,
      },
    ];
  },
};

/** AWS-23: modifying or removing a Cognito schema attribute fails at apply. */
const cognitoSchema: ChangeRule = {
  id: "AWS-23",
  types: ["aws_cognito_user_pool"],
  on: ["update"],
  evaluate(x) {
    const byName = (o: Rec): Map<string, unknown> =>
      new Map(asArray(o.schema).map((s) => [str(asRecord(s).name) ?? stableStringify(s), s]));
    const b = byName(x.before);
    const a = byName(x.after);
    const broken = [...b].filter(([name, s]) => !a.has(name) || !deepEqual(s, a.get(name)));
    const first = broken[0];
    if (!first) return [];
    return [
      {
        ruleId: "cognito-schema-change",
        severity: "high",
        reason: `Schema attribute "${first[0]}" is ${a.has(first[0]) ? "modified" : "removed"}, which Cognito rejects at apply (attributes can be added but never changed or removed).`,
        path: ["schema"],
      },
    ];
  },
};

/** AWS-U11: a DynamoDB global table replica removed deletes that region's copy. */
const dynamoReplicaRemoved: ChangeRule = {
  id: "AWS-U11",
  types: ["aws_dynamodb_table"],
  on: ["update"],
  evaluate(x) {
    const regions = (o: Rec): string[] =>
      asArray(o.replica)
        .map((r) => str(asRecord(r).region_name))
        .filter((r): r is string => r !== undefined);
    const after = new Set(regions(x.after));
    const gone = regions(x.before).filter((r) => !after.has(r));
    if (!gone.length) return [];
    return [
      {
        ruleId: "replica-removed",
        severity: "high",
        reason: `The replica in ${gone.join(", ")} is removed, which deletes that region's copy of the table.`,
        path: ["replica"],
      },
    ];
  },
};

/** AWS-U11: EKS public endpoint open to the internet. */
const eksPublicEndpoint: ChangeRule = {
  id: "AWS-U11",
  types: ["aws_eks_cluster"],
  on: ALL_WRITES,
  evaluate(x) {
    const open = (o: Rec): boolean => {
      const vpc = asRecord(asArray(o.vpc_config)[0]);
      if (vpc.endpoint_public_access !== true) return false;
      const cidrs = asArray(vpc.public_access_cidrs);
      return !cidrs.length || cidrs.includes("0.0.0.0/0");
    };
    if (!open(x.after) || open(x.before)) return [];
    if (isUnknownAt(x.change.afterUnknown, ["vpc_config", 0, "public_access_cidrs"]) && x.action === "create")
      return [];
    return [
      {
        ruleId: "eks-public-endpoint",
        severity: "high",
        reason:
          "The Kubernetes API endpoint is public with public_access_cidrs including 0.0.0.0/0, so anyone can reach it.",
        path: ["vpc_config"],
      },
    ];
  },
};

/** AWS-U11: EKS cluster-admin access policy granted. */
const eksAdminAccess: ChangeRule = {
  id: "AWS-U11",
  types: ["aws_eks_access_policy_association"],
  on: ALL_WRITES,
  evaluate(x) {
    const a = str(x.after.policy_arn) ?? "";
    if (!a.endsWith("/AmazonEKSClusterAdminPolicy") || x.before.policy_arn === a) return [];
    return [
      {
        ruleId: "eks-cluster-admin",
        severity: "high",
        reason: `${str(x.after.principal_arn) ?? "A principal"} is granted AmazonEKSClusterAdminPolicy, full admin of the Kubernetes cluster.`,
        path: ["policy_arn"],
      },
    ];
  },
};

/** AWS-24: a backup vault lock becomes immutable after changeable_for_days. */
const backupVaultLock: ChangeRule = {
  id: "AWS-24",
  types: ["aws_backup_vault_lock_configuration"],
  on: ["create"],
  evaluate(x) {
    const days = x.after.changeable_for_days;
    return [
      {
        ruleId: "backup-vault-lock",
        severity: "high",
        reason: `A compliance lock is added to the backup vault${typeof days === "number" ? `; after ${days} days it can never be removed or loosened` : " and cannot be undone once its grace period ends"}.`,
      },
    ];
  },
};

/** AWS-U12: instance_type or user_data changed in place stops and starts the instance. */
const instanceStopStart: ChangeRule = {
  id: "AWS-U12",
  types: ["aws_instance"],
  on: ["update"],
  evaluate(x) {
    const attrs = ["instance_type", "user_data", "user_data_base64"].filter((k) =>
      valueChanged(x.before[k], x.after[k]),
    );
    if (x.after.user_data_replace_on_change === true)
      attrs.splice(0, attrs.length, ...attrs.filter((a) => a === "instance_type"));
    const first = attrs[0];
    if (!first) return [];
    const singleton = x.ctx.siblingCount(x.change) <= 1;
    const what =
      first === "instance_type"
        ? `instance_type ${transition(x.before[first], x.after[first])}`
        : `${first} changes`;
    return [
      {
        ruleId: "instance-stop-start",
        severity: singleton ? "high" : "medium",
        reason: `${what} stops and starts the instance, an outage${singleton ? " for this single instance" : ""}; instance-store data is lost and the public IP changes unless an Elastic IP is attached.`,
        path: [first],
      },
    ];
  },
};

/** NOISE-03: only source_code_hash changes on a Lambda function: a code deploy. */
const lambdaCodeDeploy: ChangeRule = {
  id: "NOISE-03",
  types: ["aws_lambda_function"],
  on: ["update"],
  evaluate(x) {
    const known = x.change.changedPaths.filter((p) => !isTagPath(p));
    if (!known.length || !known.every((p) => p[0] === "source_code_hash")) return [];
    return [
      {
        ruleId: "code-deploy",
        severity: "low",
        reason:
          "Only source_code_hash changes, so this deploys new function code (or a non-deterministic build re-zipped the same code).",
        path: ["source_code_hash"],
      },
    ];
  },
};

/** Retention attributes; a decrease loses data sooner (AWS-U09, AWS-14, GCP-04, AZ-04). */
export const RETENTION_ATTRIBUTES: ReadonlySet<string> = new Set([
  "retention_in_days",
  "message_retention_seconds",
  "retention_period",
  "backup_retention_period",
  "snapshot_retention_limit",
  "recovery_window_in_days",
  "soft_delete_retention_days",
  "retained_backups",
  "retention_days",
  "log_retention_days",
]);

/** Retention values where 0 or null means "keep forever" (CloudWatch Logs). */
function retentionValue(type: string, attr: string, v: unknown): number | null {
  if (type === "aws_cloudwatch_log_group" && attr === "retention_in_days") {
    return typeof v === "number" && v > 0 ? v : Infinity;
  }
  return typeof v === "number" ? v : null;
}

function retentionPaths(change: ResourceChange): AttrPath[] {
  return change.changedPaths.filter((p) => RETENTION_ATTRIBUTES.has(leafName(p)));
}

/** Retention shortened (log groups, queues, streams, backups, soft delete). */
const retentionDecrease: ChangeRule = {
  id: "AWS-U09",
  types: [],
  on: ["update"],
  evaluate(x) {
    for (const p of retentionPaths(x.change)) {
      const attr = leafName(p);
      const b = retentionValue(x.change.type, attr, getAtPath(x.before, p));
      const a = retentionValue(x.change.type, attr, getAtPath(x.after, p));
      if (b === null || a === null || a >= b) continue;
      if (attr === "backup_retention_period" && a === 0) continue; // AWS-U02 covers backups off
      const shown = (v: unknown, n: number | null): string => (n === Infinity ? "never expire" : fmtValue(v));
      return [
        {
          ruleId: "retention-decrease",
          severity: "medium",
          reason: `${formatPath(p)} ${shown(getAtPath(x.before, p), b)} → ${shown(getAtPath(x.after, p), a)} shortens how long data is kept, so older ${x.change.type === "aws_cloudwatch_log_group" ? "logs are" : "data is"} deleted sooner.`,
          path: p,
        },
      ];
    }
    return [];
  },
};

/** GCP-04: Cloud SQL authorized networks open to the internet. */
const cloudSqlOpen: ChangeRule = {
  id: "GCP-04",
  types: ["google_sql_database_instance"],
  on: ALL_WRITES,
  evaluate(x) {
    const open = (o: Rec): boolean =>
      asArray(o.settings).some((s) =>
        asArray(asRecord(s).ip_configuration).some((ip) => {
          const ipc = asRecord(ip);
          return (
            ipc.ipv4_enabled !== false &&
            asArray(ipc.authorized_networks).some((n) => asRecord(n).value === "0.0.0.0/0")
          );
        }),
      );
    if (!open(x.after) || open(x.before)) return [];
    return [
      {
        ruleId: "db-public",
        severity: "critical",
        reason:
          "The instance's public IP now accepts connections from 0.0.0.0/0 (authorized_networks), so the whole internet can reach the database.",
        path: ["settings"],
      },
    ];
  },
};

/** GCP-02: bucket IAM granting allUsers / allAuthenticatedUsers. */
const gcsPublicIam: ChangeRule = {
  id: "GCP-02",
  types: ["google_storage_bucket_iam_member", "google_storage_bucket_iam_binding"],
  on: ALL_WRITES,
  evaluate(x) {
    const members = (o: Rec): string[] =>
      [o.member, ...asArray(o.members)].filter(
        (m): m is string => m === "allUsers" || m === "allAuthenticatedUsers",
      );
    const b = new Set(members(x.before));
    const added = members(x.after).filter((m) => !b.has(m));
    const first = added[0];
    if (!first) return [];
    return [
      {
        ruleId: "bucket-public-iam",
        severity: "critical",
        reason: `The bucket grants ${fmtValue(x.after.role)} to ${first}, which makes it accessible to ${first === "allUsers" ? "anyone on the internet" : "any Google account"}.`,
      },
    ];
  },
};

const TLS_ORDER = ["1.0", "1.1", "1.2", "1.3"];
const CLOUDFRONT_TLS = [
  "SSLv3",
  "TLSv1",
  "TLSv1_2016",
  "TLSv1.1_2016",
  "TLSv1.2_2018",
  "TLSv1.2_2019",
  "TLSv1.2_2021",
];

function tlsRank(v: unknown): number {
  if (typeof v !== "string") return -1;
  const cf = CLOUDFRONT_TLS.indexOf(v);
  if (cf >= 0) return cf;
  const m = /(\d)[._](\d)/.exec(v);
  return m ? TLS_ORDER.indexOf(`${m[1]}.${m[2]}`) : -1;
}

/** AZ-03 / AWS-20: minimum TLS version lowered. */
const tlsLowered: ChangeRule = {
  id: "AZ-03",
  types: ["azurerm_storage_account", "aws_cloudfront_distribution"],
  on: ["update"],
  evaluate(x) {
    const path: AttrPath =
      x.change.type === "azurerm_storage_account"
        ? ["min_tls_version"]
        : ["viewer_certificate", 0, "minimum_protocol_version"];
    const b = getAtPath(x.before, path);
    const a = getAtPath(x.after, path);
    const rb = tlsRank(b);
    const ra = tlsRank(a);
    if (rb < 0 || ra < 0 || ra >= rb) return [];
    return [
      {
        ruleId: "tls-lowered",
        severity: x.change.type === "azurerm_storage_account" ? "high" : "medium",
        reason: `${formatPath(path)} ${transition(b, a)} allows older, weaker TLS versions.`,
        path,
      },
    ];
  },
};

export const CHANGE_RULES: readonly ChangeRule[] = [
  sgOpenWorld,
  policyRule,
  adminAttachment,
  kmsPolicyChange,
  rdsIdentifierRename,
  rdsDowntime,
  credentialChange,
  lifecycleExpiration,
  s3AclGrants,
  cognitoSchema,
  dynamoReplicaRemoved,
  eksPublicEndpoint,
  eksAdminAccess,
  backupVaultLock,
  instanceStopStart,
  lambdaCodeDeploy,
  retentionDecrease,
  cloudSqlOpen,
  gcsPublicIam,
  tlsLowered,
];

function applies(types: readonly string[], type: string): boolean {
  return types.length === 0 || types.includes(type);
}

/** An import that also updates is judged like an update (PLAN-09). */
function runsOn(on: readonly RuleAction[] | undefined, action: RuleAction): boolean {
  const list = on ?? ["update"];
  return list.includes(action) || (action === "import" && list.includes("update"));
}

/** Run every attribute and change rule that applies to this change and action. */
export function evaluateRules(input: RuleInput): RuleHit[] {
  const hits: RuleHit[] = [];
  const { change } = input;
  for (const r of ATTRIBUTE_RULES) {
    if (!applies(r.types, change.type) || !runsOn(r.on, input.action)) continue;
    for (const p of expandPattern([input.before, input.after], r.path)) {
      if (isUnknownAt(change.afterUnknown, p)) continue;
      const b = getAtPath(input.before, p);
      const a = getAtPath(input.after, p);
      if (!r.when(b, a, input)) continue;
      const severity = typeof r.severity === "function" ? r.severity(input) : r.severity;
      hits.push({
        ruleId: r.ruleId,
        severity,
        reason: r.reason({ attr: formatPath(p), before: b, after: a, input }),
        path: p,
      });
    }
  }
  for (const r of CHANGE_RULES) {
    if (!applies(r.types, change.type) || !runsOn(r.on, input.action)) continue;
    hits.push(...r.evaluate(input));
  }
  return hits;
}

// ───────────────────────────── noise (NOISE-01..05) ─────────────────────────────

/** Tag-like roots: AWS tags/tags_all, azurerm tags, google labels/effective_labels/terraform_labels. */
export const TAG_ROOTS: ReadonlySet<string> = new Set([
  "tags",
  "tags_all",
  "labels",
  "effective_labels",
  "terraform_labels",
]);

/** NOISE-01: tag keys that change behaviour, never noise. */
const FUNCTIONAL_TAG_PATTERNS: readonly RegExp[] = [
  /^kubernetes\.io\/role\/(internal-)?elb$/,
  /^kubernetes\.io\/cluster\//,
  /^karpenter\.sh\/discovery$/,
  /^Patch Group$/,
];

/** tags / tags_all, at the top level or inside a nested block (`root_block_device[0].tags`). */
export function isTagPath(path: AttrPath): boolean {
  if (typeof path[0] === "string" && TAG_ROOTS.has(path[0])) return true;
  return path.some(
    (s, i) => i > 0 && typeof s === "string" && TAG_ROOTS.has(s) && typeof path[i - 1] === "number",
  );
}

function isFunctionalTag(key: string, ctx: RuleContext): boolean {
  return FUNCTIONAL_TAG_PATTERNS.some((re) => re.test(key)) || ctx.functionalTagKeys.has(key.toLowerCase());
}

export type NoiseKind = "tags" | "description" | "retention-increase" | "policy-format" | "conflicting-rules";

export interface NoiseResult {
  /** Paths that are noise, by kind. */
  kinds: Map<NoiseKind, AttrPath[]>;
  /** Paths that are not noise and not unknown-only (known material changes). */
  material: AttrPath[];
  /** Paths that only become unknown (computed after apply). */
  unknownOnly: AttrPath[];
  /** Tag keys that drive behaviour (NOISE-01 exception). */
  functionalTags: string[];
}

/** Every path an update touches: known changes, unknowns, hidden-value changes; deduped. */
export function touchedPaths(change: ResourceChange): AttrPath[] {
  const seen = new Map<string, AttrPath>();
  for (const p of [...change.changedPaths, ...change.unknownPaths, ...change.sensitiveChangedPaths]) {
    seen.set(pathKey(p), p);
  }
  return [...seen.values()];
}

/** Classify each path an update touches into noise kinds, unknown-only, or material. */
export function classifyNoise(change: ResourceChange, ctx: RuleContext): NoiseResult {
  const result: NoiseResult = { kinds: new Map(), material: [], unknownOnly: [], functionalTags: [] };
  const add = (k: NoiseKind, p: AttrPath): void => {
    const list = result.kinds.get(k) ?? [];
    list.push(p);
    result.kinds.set(k, list);
  };
  const known = new Set(change.changedPaths.map(pathKey));
  const sensitive = new Set(change.sensitiveChangedPaths.map(pathKey));
  const before = asRecord(change.before);
  const after = asRecord(change.after);
  const sgManagedElsewhere =
    (change.type === "aws_security_group" &&
      [before.id, after.id].some((id) => typeof id === "string" && ctx.ruleManagedGroups.has(id))) ||
    false;
  for (const p of touchedPaths(change)) {
    const top = typeof p[0] === "string" ? p[0] : "";
    if (isTagPath(p)) {
      const tagKeys =
        p.length > 1 ? [String(p[1])] : Object.keys({ ...asRecord(before[top]), ...asRecord(after[top]) });
      const functional = tagKeys.filter((k) => isFunctionalTag(k, ctx));
      if (functional.length) {
        result.functionalTags.push(...functional);
        result.material.push(p);
      } else add("tags", p);
      continue;
    }
    if (sensitive.has(pathKey(p))) {
      result.material.push(p);
      continue;
    }
    if (!known.has(pathKey(p))) {
      result.unknownOnly.push(p);
      continue;
    }
    if (top === "description" && p.length === 1) {
      add("description", p);
      continue;
    }
    if (RETENTION_ATTRIBUTES.has(leafName(p))) {
      const attr = leafName(p);
      const b = retentionValue(change.type, attr, getAtPath(before, p));
      const a = retentionValue(change.type, attr, getAtPath(after, p));
      const zeroSwitch = attr === "backup_retention_period" && (b === 0 || a === 0);
      if (b !== null && a !== null && a > b && !zeroSwitch) {
        add("retention-increase", p);
        continue;
      }
    }
    if (
      POLICY_ATTRIBUTE_NAMES.has(leafName(p)) &&
      policiesEquivalent(getAtPath(before, p), getAtPath(after, p))
    ) {
      add("policy-format", p);
      continue;
    }
    if (sgManagedElsewhere && (top === "ingress" || top === "egress")) {
      add("conflicting-rules", p);
      continue;
    }
    result.material.push(p);
  }
  return result;
}

function tagSummary(paths: AttrPath[]): string {
  const keys = [
    ...new Set(paths.map((p) => (p.length > 1 ? `${String(p[0])}.${String(p[1])}` : String(p[0])))),
  ];
  const shown = keys.slice(0, 3).join(", ");
  return keys.length > 3 ? `${shown} and ${keys.length - 3} more` : shown;
}

/** One noise signal per kind, for an update whose every touched path is noise. */
export function noiseSignals(change: ResourceChange, noise: NoiseResult): RiskSignal[] {
  const out: RiskSignal[] = [];
  const tags = noise.kinds.get("tags");
  if (tags) {
    const onlyTagsAll = tags.every((p) => p[0] === "tags_all");
    out.push({
      ruleId: "tags-only",
      severity: "noise",
      reason: onlyTagsAll
        ? `Only tags_all changes (${tagSummary(tags)}), which comes from the provider's default_tags, so nothing about how the resource behaves changes.`
        : `Only tags change (${tagSummary(tags)}), so nothing about how the resource behaves changes.`,
    });
  }
  if (noise.kinds.has("description")) {
    out.push({ ruleId: "description-only", severity: "noise", reason: "Only the description text changes." });
  }
  const retention = noise.kinds.get("retention-increase");
  if (retention?.[0]) {
    const p = retention[0];
    out.push({
      ruleId: "retention-increase",
      severity: "noise",
      reason: `${formatPath(p)} ${transition(getAtPath(change.before, p), getAtPath(change.after, p))} keeps data longer, which loses nothing.`,
      path: p,
    });
  }
  const policy = noise.kinds.get("policy-format");
  if (policy?.[0]) {
    out.push({
      ruleId: "policy-reformatted",
      severity: "noise",
      reason: `${formatPath(policy[0])} differs only in formatting, key order or statement order; the policy grants exactly the same access.`,
      path: policy[0],
    });
  }
  if (noise.kinds.has("conflicting-rules")) {
    out.push({
      ruleId: "sg-conflicting-management",
      severity: "noise",
      reason:
        "The inline ingress/egress rules flip-flop because separate security group rule resources also manage this group; the provider docs warn against mixing the two.",
    });
  }
  return out;
}

// ───────────────────────────── NOISE-02 task definitions ─────────────────────────────

function normalizeContainers(v: unknown): unknown[] | null {
  if (typeof v !== "string" || v === SENSITIVE_PLACEHOLDER) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(v) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const prune = (x: unknown): unknown => {
    if (Array.isArray(x)) {
      const items = x.map(prune).filter((i) => i !== undefined);
      return items.length ? items : undefined;
    }
    if (isObject(x)) {
      const out: Rec = {};
      for (const [k, val] of Object.entries(x)) {
        const pv = prune(val);
        if (pv !== undefined && pv !== null) out[k] = pv;
      }
      return Object.keys(out).length ? out : undefined;
    }
    return x;
  };
  return parsed.map((c) => {
    const o = asRecord(prune(c));
    if (o.essential === true) delete o.essential;
    if (Array.isArray(o.environment)) {
      o.environment = [...o.environment].sort((p, q) =>
        String(asRecord(p).name).localeCompare(String(asRecord(q).name)),
      );
    }
    return o;
  });
}

/** NOISE-02: compare container definitions after normalization; returns image changes when they differ. */
export function taskDefinitionDiff(change: ResourceChange): { equal: boolean; images: string[] } | null {
  const b = normalizeContainers(asRecord(change.before).container_definitions);
  const a = normalizeContainers(asRecord(change.after).container_definitions);
  if (!b || !a) return null;
  if (stableStringify(b) === stableStringify(a)) return { equal: true, images: [] };
  const imageOf = (list: unknown[], name: unknown): unknown =>
    asRecord(list.find((c) => asRecord(c).name === name)).image;
  const images = a
    .map((c) => {
      const name = asRecord(c).name;
      const before = imageOf(b, name);
      const after = asRecord(c).image;
      const short = (v: unknown): unknown => (typeof v === "string" ? v.split("/").pop() : v);
      return before !== undefined && before !== after
        ? `${String(name)} image ${transition(short(before), short(after))}`
        : null;
    })
    .filter((s): s is string => s !== null);
  return { equal: false, images };
}

/** Plan-wide helper: do these two paths overlap (one is a prefix of the other)? */
export function pathsOverlap(a: AttrPath, b: AttrPath): boolean {
  return isPrefix(a, b) || isPrefix(b, a);
}
