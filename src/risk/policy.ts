/*
 * IAM and resource-policy JSON analysis (taxonomy AWS-U08, AWS-U05 bucket policies, NOISE-04).
 *
 * Policies arrive as JSON strings in plan values (`policy`, `assume_role_policy`, `access_policies`, …).
 * They are parsed, normalized (Statement / Action / Resource / Principal wrapped into sorted arrays,
 * actions lower-cased, Sid ignored) and compared statement by statement, so a policy that only changed
 * whitespace, key order or array order compares equal, and only statements that are new in `after`
 * are judged. Unknown or masked values are skipped, never guessed.
 */
import { SENSITIVE_PLACEHOLDER } from "../types.js";
import type { AttrPath, Severity } from "../types.js";

export type PolicyKind = "identity" | "resource" | "trust";

export interface PolicyStatement {
  sid?: string;
  /** "Allow" or "Deny" (anything else is kept as written). */
  effect: string;
  action: string[];
  notAction: string[];
  resource: string[];
  notResource: string[];
  /** Principal type ("AWS", "Service", "Federated", "CanonicalUser", "*") → sorted values. */
  principal: Record<string, string[]> | null;
  notPrincipal: Record<string, string[]> | null;
  /** Operator → condition key (lower-cased) → sorted values. */
  condition: Record<string, Record<string, string[]>> | null;
}

export interface PolicyDocument {
  version: string | null;
  statements: PolicyStatement[];
}

export interface PolicyFinding {
  ruleId: string;
  severity: Severity;
  reason: string;
}

export interface PolicyAnalysisOptions {
  /** Attribute name used in reasons, e.g. "policy" or "assume_role_policy". */
  attr: string;
  /** A new object: only critical/high findings, no "new statement" chatter. */
  isCreate: boolean;
  /** AWS account ids seen elsewhere in the plan (ARNs), to tell a new external account from ours. */
  knownAccounts?: ReadonlySet<string>;
}

/** Where each resource type keeps policy JSON. "*" matches any list index (nested blocks). */
export const POLICY_ATTRIBUTES: Readonly<Record<string, readonly { path: AttrPath; kind: PolicyKind }[]>> = {
  // AWS-U08 identity policies
  aws_iam_policy: [{ path: ["policy"], kind: "identity" }],
  aws_iam_role_policy: [{ path: ["policy"], kind: "identity" }],
  aws_iam_user_policy: [{ path: ["policy"], kind: "identity" }],
  aws_iam_group_policy: [{ path: ["policy"], kind: "identity" }],
  aws_iam_role: [
    { path: ["assume_role_policy"], kind: "trust" },
    { path: ["inline_policy", "*", "policy"], kind: "identity" },
  ],
  // AWS-U05 / AWS-U08 resource policies
  aws_s3_bucket_policy: [{ path: ["policy"], kind: "resource" }],
  aws_s3_bucket: [{ path: ["policy"], kind: "resource" }],
  aws_s3_access_point: [{ path: ["policy"], kind: "resource" }],
  aws_sqs_queue_policy: [{ path: ["policy"], kind: "resource" }],
  aws_sqs_queue: [{ path: ["policy"], kind: "resource" }],
  aws_sns_topic_policy: [{ path: ["policy"], kind: "resource" }],
  aws_sns_topic: [{ path: ["policy"], kind: "resource" }],
  aws_kms_key: [{ path: ["policy"], kind: "resource" }],
  aws_kms_key_policy: [{ path: ["policy"], kind: "resource" }],
  aws_ecr_repository_policy: [{ path: ["policy"], kind: "resource" }],
  aws_ecr_registry_policy: [{ path: ["policy"], kind: "resource" }],
  aws_secretsmanager_secret_policy: [{ path: ["policy"], kind: "resource" }],
  aws_secretsmanager_secret: [{ path: ["policy"], kind: "resource" }],
  aws_opensearch_domain: [{ path: ["access_policies"], kind: "resource" }],
  aws_opensearch_domain_policy: [{ path: ["access_policies"], kind: "resource" }],
  aws_elasticsearch_domain: [{ path: ["access_policies"], kind: "resource" }],
  aws_elasticsearch_domain_policy: [{ path: ["access_policies"], kind: "resource" }],
  aws_efs_file_system_policy: [{ path: ["policy"], kind: "resource" }],
  aws_backup_vault_policy: [{ path: ["policy"], kind: "resource" }],
  aws_glacier_vault: [{ path: ["access_policy"], kind: "resource" }],
  aws_api_gateway_rest_api_policy: [{ path: ["policy"], kind: "resource" }],
  aws_api_gateway_rest_api: [{ path: ["policy"], kind: "resource" }],
  aws_cloudwatch_log_resource_policy: [{ path: ["policy_document"], kind: "resource" }],
};

/** Attribute names that hold policy JSON, for NOISE-04 on any type. */
export const POLICY_ATTRIBUTE_NAMES: ReadonlySet<string> = new Set([
  "policy",
  "assume_role_policy",
  "access_policies",
  "access_policy",
  "policy_document",
]);

// ───────────────────────────── parse + normalize ─────────────────────────────

type Rec = Record<string, unknown>;

function isObject(v: unknown): v is Rec {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function toList(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  const list = Array.isArray(v) ? v : [v];
  return list.filter((x) => x !== null && x !== undefined && typeof x !== "object").map((x) => String(x));
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function normalizePrincipal(v: unknown): Record<string, string[]> | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return { AWS: [v] };
  if (!isObject(v)) return null;
  const out: Record<string, string[]> = {};
  for (const key of Object.keys(v).sort()) out[key] = sortedUnique(toList(v[key]));
  return out;
}

function normalizeCondition(v: unknown): Record<string, Record<string, string[]>> | null {
  if (!isObject(v)) return null;
  const out: Record<string, Record<string, string[]>> = {};
  for (const op of Object.keys(v).sort()) {
    const block = v[op];
    if (!isObject(block)) continue;
    const keys: Record<string, string[]> = {};
    for (const k of Object.keys(block).sort()) keys[k.toLowerCase()] = sortedUnique(toList(block[k]));
    out[op] = keys;
  }
  return Object.keys(out).length ? out : null;
}

function normalizeEffect(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "Allow";
  if (/^allow$/i.test(s)) return "Allow";
  if (/^deny$/i.test(s)) return "Deny";
  return s;
}

function normalizeStatement(raw: Rec): PolicyStatement {
  const sid = typeof raw.Sid === "string" && raw.Sid ? raw.Sid : undefined;
  return {
    ...(sid !== undefined && { sid }),
    effect: normalizeEffect(raw.Effect),
    action: sortedUnique(toList(raw.Action).map((a) => a.toLowerCase())),
    notAction: sortedUnique(toList(raw.NotAction).map((a) => a.toLowerCase())),
    resource: sortedUnique(toList(raw.Resource)),
    notResource: sortedUnique(toList(raw.NotResource)),
    principal: normalizePrincipal(raw.Principal),
    notPrincipal: normalizePrincipal(raw.NotPrincipal),
    condition: normalizeCondition(raw.Condition),
  };
}

/**
 * Parse a policy document from a JSON string (or an already-parsed object). Returns null for
 * unknown, masked, empty or malformed values: callers skip those rather than guess.
 */
export function parsePolicyDocument(value: unknown): PolicyDocument | null {
  let doc: unknown = value;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text || text === SENSITIVE_PLACEHOLDER || !text.startsWith("{")) return null;
    try {
      doc = JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }
  if (!isObject(doc)) return null;
  const raw = doc.Statement;
  const list = Array.isArray(raw) ? raw : isObject(raw) ? [raw] : [];
  return {
    version: typeof doc.Version === "string" ? doc.Version : null,
    statements: list.filter(isObject).map(normalizeStatement),
  };
}

/** Several documents (e.g. every inline_policy of a role) as one statement set. */
export function mergePolicyDocuments(docs: readonly (PolicyDocument | null)[]): PolicyDocument | null {
  const present = docs.filter((d): d is PolicyDocument => d !== null);
  if (!present.length) return null;
  return { version: present[0]?.version ?? null, statements: present.flatMap((d) => d.statements) };
}

/** JSON with object keys sorted at every level. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (isObject(v)) {
    const keys = Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** Order-, whitespace- and Sid-insensitive identity of one statement. */
export function statementKey(st: PolicyStatement): string {
  const { sid: _sid, ...rest } = st;
  return stableStringify(rest);
}

export function canonicalPolicy(doc: PolicyDocument): string {
  return stableStringify({ version: doc.version, statements: doc.statements.map(statementKey).sort() });
}

/**
 * True when both values parse and are the same policy after normalization (NOISE-04); false when
 * they differ; null when either side cannot be parsed (unknown, masked, not JSON).
 */
export function policiesEquivalent(before: unknown, after: unknown): boolean | null {
  const b = parsePolicyDocument(before);
  const a = parsePolicyDocument(after);
  if (!b || !a) return null;
  return canonicalPolicy(b) === canonicalPolicy(a);
}

// ───────────────────────────── analysis ─────────────────────────────

const ADMIN_POLICY_NAMES = ["AdministratorAccess", "PowerUserAccess", "IAMFullAccess"];

/** AWS-U08: managed policies that amount to admin. */
export function isAdminPolicyArn(arn: unknown): boolean {
  return typeof arn === "string" && ADMIN_POLICY_NAMES.some((n) => arn.endsWith(`:policy/${n}`));
}

/** Condition keys that limit who can use a statement granted to Principal "*". */
const RESTRICTIVE_CONDITION_KEYS = new Set([
  "aws:sourcearn",
  "aws:sourceaccount",
  "aws:sourceowner",
  "aws:sourcevpc",
  "aws:sourcevpce",
  "aws:sourceip",
  "aws:vpcsourceip",
  "aws:sourceorgid",
  "aws:sourceorgpaths",
  "aws:principalorgid",
  "aws:principalorgpaths",
  "aws:principalaccount",
  "aws:principalarn",
  "aws:userid",
  "aws:username",
  "kms:calleraccount",
  "kms:viaservice",
  "s3:dataaccesspointaccount",
  "s3:dataaccesspointarn",
]);

function hasRestrictiveCondition(st: PolicyStatement): boolean {
  if (!st.condition) return false;
  return Object.values(st.condition).some((keys) =>
    Object.entries(keys).some(
      ([k, values]) => RESTRICTIVE_CONDITION_KEYS.has(k) && values.some((v) => v !== "*" && v !== ""),
    ),
  );
}

function conditionKeys(st: PolicyStatement): string[] {
  return st.condition ? Object.values(st.condition).flatMap((keys) => Object.keys(keys)) : [];
}

function conditionValues(st: PolicyStatement, suffix: string): string[] {
  if (!st.condition) return [];
  return Object.values(st.condition).flatMap((keys) =>
    Object.entries(keys)
      .filter(([k]) => k.endsWith(suffix))
      .flatMap(([, v]) => v),
  );
}

function isWildcardAction(action: string): boolean {
  return action === "*" || /^[a-z0-9-]+:\*$/.test(action);
}

function isAllResources(resource: string): boolean {
  return resource === "*" || /^arn:[^:]+:[^:]+:[^:]*:[^:]*:\*$/.test(resource);
}

function isPublicPrincipal(p: Record<string, string[]> | null): boolean {
  if (!p) return false;
  return Object.entries(p).some(([type, values]) => (type === "AWS" || type === "*") && values.includes("*"));
}

/** Account id of an AWS principal: a bare 12-digit id or the account field of an ARN. */
export function principalAccount(principal: string): string | null {
  if (/^\d{12}$/.test(principal)) return principal;
  const m = /^arn:[^:]+:(?:iam|sts)::(\d{12}):/.exec(principal);
  return m?.[1] ?? null;
}

function listText(values: string[], max = 3): string {
  const shown = values.slice(0, max).join(", ");
  return values.length > max ? `${shown} and ${values.length - max} more` : shown;
}

function actionsText(st: PolicyStatement): string {
  if (st.action.includes("*")) return "every action";
  if (st.action.length) return listText(st.action);
  return `everything except ${listText(st.notAction)}`;
}

function resourcesText(st: PolicyStatement): string {
  if (st.resource.some(isAllResources)) return 'every resource (Resource "*")';
  if (st.resource.length) return listText(st.resource, 2);
  if (st.notResource.length) return `everything except ${listText(st.notResource, 2)}`;
  return "this resource";
}

/** "full control of S3" for s3:*; "full control of S3 and SQS" for several services. */
function serviceControl(wildcards: readonly string[]): string {
  const services = [
    ...new Set(
      wildcards
        .map((w) => /^([a-z0-9-]+):/i.exec(w)?.[1]?.toLowerCase())
        .filter((s): s is string => s !== undefined),
    ),
  ];
  if (!services.length) return "full control of those services";
  const names = services.map((s) => SERVICE_NAMES[s] ?? s);
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return wildcards.every((w) => /:\*$/.test(w)) ? `full control of ${list}` : `every matching ${list} action`;
}

const SERVICE_NAMES: Readonly<Record<string, string>> = {
  s3: "S3 (every bucket and object)",
  iam: "IAM",
  kms: "KMS",
  ec2: "EC2",
  dynamodb: "DynamoDB",
  sqs: "SQS",
  sns: "SNS",
  lambda: "Lambda",
  secretsmanager: "Secrets Manager",
  ssm: "SSM",
  rds: "RDS",
  logs: "CloudWatch Logs",
  sts: "STS",
};

const STS_ASSUME = /^sts:(assumerole|assumerolewithwebidentity|assumerolewithsaml|\*)$|^\*$/;

function judgeIdentity(st: PolicyStatement, attr: string): PolicyFinding[] {
  const out: PolicyFinding[] = [];
  const allResources = st.resource.some(isAllResources);
  const wildcard = st.action.filter(isWildcardAction);
  if (wildcard.length && allResources) {
    const reason = wildcard.includes("*")
      ? `${attr} now allows every action on every resource (Action "*" and Resource "*"), which is full administrator access to the account.`
      : `${attr} now allows ${listText(wildcard)} on every resource (Resource "*"), so whoever holds it gets ${serviceControl(wildcard)} across the whole account.`;
    out.push({ ruleId: "iam-wildcard", severity: "critical", reason });
  }
  if (st.notAction.length || st.notResource.length) {
    const what = st.notAction.length ? "NotAction" : "NotResource";
    out.push({
      ruleId: "iam-not-action",
      severity: "high",
      reason: `${attr} gains an Allow statement with ${what}, which grants ${actionsText(st)} on ${resourcesText(st)} and silently widens as AWS adds new actions or resources.`,
    });
  }
  if (allResources && !(wildcard.length && allResources)) {
    if (st.action.some((a) => a === "iam:passrole" || a === "iam:*")) {
      out.push({
        ruleId: "iam-passrole-wildcard",
        severity: "high",
        reason: `${attr} now allows iam:PassRole on every role (Resource "*"), so the holder can hand any role, including admin roles, to a service it controls.`,
      });
    } else if (st.action.some((a) => STS_ASSUME.test(a))) {
      out.push({
        ruleId: "iam-assume-any-role",
        severity: "high",
        reason: `${attr} now allows sts:AssumeRole on every role (Resource "*"), so the holder can become any role that trusts this account.`,
      });
    }
  }
  return out;
}

function judgeResource(st: PolicyStatement, attr: string): PolicyFinding[] {
  if (!isPublicPrincipal(st.principal)) return [];
  if (hasRestrictiveCondition(st)) return [];
  return [
    {
      ruleId: "policy-public",
      severity: "critical",
      reason: `${attr} now allows ${actionsText(st)} to Principal "*" with no condition limiting who can use it, which grants access to everyone, including anonymous users.`,
    },
  ];
}

const OIDC_HINT =
  /oidc-provider\/|token\.actions\.githubusercontent\.com|accounts\.google\.com|cognito-identity\.amazonaws\.com/;

function judgeTrust(
  st: PolicyStatement,
  attr: string,
  beforeAccounts: ReadonlySet<string>,
  knownAccounts: ReadonlySet<string>,
): PolicyFinding[] {
  const out: PolicyFinding[] = [];
  if (isPublicPrincipal(st.principal) && !hasRestrictiveCondition(st)) {
    out.push({
      ruleId: "trust-public",
      severity: "critical",
      reason: `${attr} now lets any AWS principal (Principal "*") assume this role, with no condition limiting who.`,
    });
  }
  for (const p of st.principal?.AWS ?? []) {
    const account = principalAccount(p);
    if (!account || beforeAccounts.has(account)) continue;
    if (knownAccounts.size && !knownAccounts.has(account)) {
      out.push({
        ruleId: "trust-external-account",
        severity: "critical",
        reason: `${attr} now trusts AWS account ${account}, which appears nowhere else in this plan, so that account can assume this role.`,
      });
    } else if (!knownAccounts.size) {
      out.push({
        ruleId: "trust-new-account",
        severity: "high",
        reason: `${attr} now trusts AWS account ${account}; confirm it is one of yours, because that account can assume this role.`,
      });
    }
  }
  for (const f of st.principal?.Federated ?? []) {
    if (!OIDC_HINT.test(f)) continue;
    const provider = f.replace(/^arn:[^:]+:iam::\d{12}:oidc-provider\//, "");
    const keys = conditionKeys(st);
    const subs = conditionValues(st, ":sub");
    const hasSub = subs.some((v) => v !== "*" && !/^repo:\*/.test(v));
    const hasAud = keys.some((k) => k.endsWith(":aud"));
    if (!hasSub && !hasAud) {
      out.push({
        ruleId: "trust-oidc-unscoped",
        severity: "critical",
        reason: `${attr} now trusts the OIDC provider ${provider} with no :sub or :aud condition, so any identity it issues (for GitHub, any repository) can assume this role.`,
      });
    } else if (!hasSub) {
      out.push({
        ruleId: "trust-oidc-unscoped",
        severity: "high",
        reason: `${attr} now trusts the OIDC provider ${provider} without a specific :sub condition, so any workload or repository that provider issues tokens for can assume this role.`,
      });
    }
  }
  return out;
}

/**
 * Compare two policy documents and judge the statements that are new in `after` (AWS-U08 / AWS-U05):
 * - identity: Action "*" or "svc:*" on Resource "*" (critical); NotAction/NotResource,
 *   iam:PassRole or sts:AssumeRole on "*" (high);
 * - resource: Principal "*" with no restrictive condition (critical);
 * - trust: Principal "*", a new external account, an OIDC provider without sub/aud conditions;
 * - on updates only: other new Allow statements and removed Deny statements (medium).
 * Equal documents (after normalization) and unparseable `after` values yield nothing.
 */
export function analyzePolicyChange(
  before: PolicyDocument | null,
  after: PolicyDocument | null,
  kind: PolicyKind,
  opts: PolicyAnalysisOptions,
): PolicyFinding[] {
  if (!after) return [];
  if (before && canonicalPolicy(before) === canonicalPolicy(after)) return [];
  const beforeKeys = new Set((before?.statements ?? []).map(statementKey));
  const added = after.statements.filter((s) => !beforeKeys.has(statementKey(s)));
  const beforeAccounts = new Set(
    (before?.statements ?? [])
      .flatMap((s) => s.principal?.AWS ?? [])
      .map(principalAccount)
      .filter((a): a is string => a !== null),
  );
  const known = opts.knownAccounts ?? new Set<string>();
  const findings: PolicyFinding[] = [];
  for (const st of added) {
    if (st.effect !== "Allow") continue;
    if (kind === "identity") findings.push(...judgeIdentity(st, opts.attr));
    else if (kind === "resource") findings.push(...judgeResource(st, opts.attr));
    else findings.push(...judgeTrust(st, opts.attr, beforeAccounts, known));
  }
  if (!opts.isCreate && before) {
    const afterKeys = new Set(after.statements.map(statementKey));
    const removedDeny = before.statements.filter(
      (s) => s.effect === "Deny" && !afterKeys.has(statementKey(s)),
    );
    const first = removedDeny[0];
    if (first) {
      findings.push({
        ruleId: "policy-deny-removed",
        severity: "medium",
        reason: `${opts.attr} drops a Deny statement (${actionsText(first)}), which removes a guardrail.`,
      });
    }
    const newAllow = added.filter((s) => s.effect === "Allow");
    const firstAllow = newAllow[0];
    if (firstAllow && !findings.some((f) => f.severity === "critical" || f.severity === "high")) {
      const more = newAllow.length > 1 ? ` (and ${newAllow.length - 1} more)` : "";
      findings.push({
        ruleId: "policy-new-statement",
        severity: "medium",
        reason: `${opts.attr} gains a new Allow statement${more}: ${actionsText(firstAllow)} on ${resourcesText(firstAllow)}.`,
      });
    }
  }
  // One finding per rule id, worst first.
  const seen = new Set<string>();
  return findings.filter((f) => (seen.has(f.ruleId) ? false : (seen.add(f.ruleId), true)));
}

/** Tag keys a policy keys access on (ABAC): aws:ResourceTag/<key>, aws:RequestTag/<key>, aws:PrincipalTag/<key>. */
export function abacTagKeys(doc: PolicyDocument | null): string[] {
  if (!doc) return [];
  const out: string[] = [];
  for (const st of doc.statements) {
    for (const k of conditionKeys(st)) {
      const m = /^aws:(?:resourcetag|requesttag|principaltag)\/(.+)$/.exec(k);
      if (m?.[1]) out.push(m[1]);
    }
  }
  return out;
}
