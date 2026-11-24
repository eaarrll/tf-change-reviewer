/*
 * Secret redaction for every string that leaves the process (model input, PR comment, logs).
 *
 * - redactSecrets: secret FORMATS anywhere in free text (AWS keys, GitHub tokens, JWTs, PEM blocks,
 *   Slack, Azure, GCP, generic `password=...` assignments, ...), ported from ci-triage-agent.
 * - isCredentialName / isSecretAssignment: the attribute-name heuristic shared with plan/mask.ts.
 * - maskSourceText: redactSecrets + `(sensitive)` for literal values assigned to credential-like
 *   names in HCL / tfvars / JSON source (`password = "..."`, `"admin_password": "..."`, heredocs).
 */
import { SENSITIVE_PLACEHOLDER } from "./types.js";

export interface RedactionResult {
  text: string;
  /** number of secrets replaced */
  count: number;
}

type Groups = Readonly<Record<string, string | undefined>>;

/**
 * One detector. `pattern` is global and defines a named group `secret`; when it also defines
 * `pre`, the match is exactly `pre` + `secret` and only `secret` is replaced, so keys,
 * schemes, user names and hosts stay readable for the model. Conditions after the secret
 * are lookaheads, never consumed.
 *
 * Linear time: every pattern begins either with a literal that cannot recur inside the run
 * it then consumes, or with a lookbehind that forbids starting inside that run. The engine
 * therefore never rescans a long token (a base64 blob, a minified line) from each of its
 * positions, which is what turns naive secret regexes quadratic on real logs.
 */
interface Rule {
  readonly kind: string | ((groups: Groups) => string);
  readonly pattern: RegExp;
  /** Final say on a candidate, for checks a regex cannot express cleanly. */
  readonly accept?: (secret: string) => boolean;
}

const MARKER_PREFIX = "[REDACTED:";
/** A whole marker, for rules whose context may legitimately be one (a token used as a URL user). */
const MARKER_PATTERN = String.raw`\[REDACTED:\w{1,32}\]`;
const GITHUB_MASK = "***";

/** Generic `key=value` matches shorter than this are words or flags, not credentials. */
const MIN_GENERIC_SECRET_LENGTH = 8;
/** Passes over the text; each one after the first only finds secrets glued to another secret. */
const MAX_PASSES = 4;
/** Upper bound for a PEM block body, so an unterminated header cannot scan the whole log. */
const MAX_PEM_BODY_CHARS = 16_384;

/** GitHub prefixes every raw log line with an ISO-8601 timestamp and a space. */
const LOG_TIMESTAMP = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z `;
const PEM_LABEL = String.raw`(?:[A-Z0-9]{2,10} ){0,2}PRIVATE KEY(?: BLOCK)?`;
const LINE_BREAK_AND_TIMESTAMP = new RegExp(String.raw`\r?\n(?:${LOG_TIMESTAMP})?`, "g");

const GENERIC_KEYWORDS = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "api[_-]?key",
  "access[_-]?key",
  "account[_-]?key",
  "secret[_-]?key",
  "client[_-]?secret",
  "private[_-]?key",
].join("|");

/** Marker kind per generic keyword, keyed by the keyword lower-cased without `_`/`-`. */
const GENERIC_KINDS: Readonly<Record<string, string>> = {
  password: "password",
  passwd: "password",
  pwd: "password",
  secret: "secret",
  token: "token",
  apikey: "api_key",
  accesskey: "access_key",
  accountkey: "account_key",
  secretkey: "secret_key",
  clientsecret: "client_secret",
  privatekey: "private_key",
};

// Order matters: specific formats run first, so a token inside an Authorization header or a
// `token=` assignment is labelled by its format, and the context rules after it skip the
// marker it leaves behind instead of counting the same secret twice.
const RULES: readonly Rule[] = [
  {
    // Whole PEM block: multi-line, or JSON-escaped on one line (GCP service-account keys).
    // The body may not cross another BEGIN/END marker, which keeps a pile of unterminated
    // headers linear instead of rescanning up to the size cap from each one.
    kind: "private_key",
    pattern: new RegExp(
      String.raw`(?<secret>-----BEGIN (?<label>${PEM_LABEL})-----(?:(?!-----(?:BEGIN|END) )[\s\S]){0,${MAX_PEM_BODY_CHARS}}-----END \k<label>-----)`,
      "g",
    ),
  },
  {
    // A header with no matching END (truncated log, `head` of a key file): take the header
    // and the base64 lines that follow it.
    kind: "private_key",
    pattern: new RegExp(
      String.raw`(?<secret>-----BEGIN ${PEM_LABEL}-----(?:(?:\r?\n(?:${LOG_TIMESTAMP})?[ \t]{0,32}|(?:\\r)?\\n)[A-Za-z0-9+/=]{16,}(?=\r?\n|\\[rn]|"|$))*)`,
      "g",
    ),
  },
  { kind: "jwt", pattern: /(?<![\w-])(?<secret>eyJ[\w-]{2,}\.eyJ[\w-]{2,}\.[\w-]*)/g },
  { kind: "github_token", pattern: /(?<!\w)(?<secret>gh[pousr]_[A-Za-z0-9]{36,}|github_pat_\w{50,})/g },
  { kind: "anthropic_key", pattern: /(?<![\w-])(?<secret>sk-ant-[\w-]{20,})/g },
  {
    // Classic `sk-` and `sk-proj-` keys. Requiring digits and both cases keeps kebab-case
    // identifiers that happen to start with `sk-` out.
    kind: "openai_key",
    pattern: /(?<![\w-])(?<secret>sk-(?!ant-)[\w-]{20,})/g,
    accept: (secret) => /\d/.test(secret) && /[a-z]/.test(secret) && /[A-Z]/.test(secret),
  },
  { kind: "google_api_key", pattern: /(?<![\w-])(?<secret>AIza[\w-]{35})(?![\w-])/g },
  {
    kind: "aws_access_key_id",
    pattern:
      /(?<![A-Za-z0-9])(?<secret>(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16})(?![A-Za-z0-9])/g,
  },
  {
    kind: "aws_secret",
    pattern:
      /(?<pre>(?:aws[_-]?)?secret[_-]?access[_-]?key["']?[ \t]*[=:][ \t]*["']?)(?<secret>[A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi,
  },
  {
    // Storage connection strings (AccountKey=) and Service Bus / Event Hubs ones (SharedAccessKey=).
    kind: "azure_key",
    pattern: /(?<pre>(?:AccountKey|SharedAccessKey)[ \t]*=[ \t]*)(?<secret>[A-Za-z0-9+/]{20,}={0,2})/gi,
  },
  {
    // SAS signatures in URLs and in `SharedAccessSignature sr=...&sig=...` tokens. The double
    // negative reads "preceded by a delimiter or the start of the text".
    kind: "azure_sas",
    pattern: /(?<pre>(?<![^?&;\s"'])sig=)(?<secret>[A-Za-z0-9%+/=_-]{16,})/g,
  },
  {
    // Entra ID client secrets have a recognisable shape (`xxx8Q~...`) even outside an assignment.
    kind: "azure_client_secret",
    pattern: /(?<![\w~.-])(?<secret>[\w~.]{3}\dQ~[\w~.-]{31,34})(?![\w~.-])/g,
  },
  {
    kind: "slack_webhook",
    pattern: /(?<pre>https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/)(?<secret>[\w/-]{8,})/g,
  },
  { kind: "slack_token", pattern: /(?<![\w-])(?<secret>xox[abprs]-[A-Za-z0-9-]{10,})/g },
  { kind: "stripe_key", pattern: /(?<!\w)(?<secret>(?:sk|rk)_live_[A-Za-z0-9]{16,})/g },
  { kind: "npm_token", pattern: /(?<!\w)(?<secret>npm_[A-Za-z0-9]{36})(?![A-Za-z0-9])/g },
  {
    // ~/.docker/config.json, possibly JSON-escaped inside another string. The value is padded
    // base64 of `user:password`, so its length is a multiple of 4.
    kind: "docker_auth",
    pattern: /(?<pre>\\?"auth\\?"[ \t]*:[ \t]*\\?")(?<secret>[A-Za-z0-9+/=]{12,})(?=\\?")/g,
    accept: (secret) => secret.length % 4 === 0,
  },
  {
    kind: "kubeconfig",
    // YAML, or JSON from `kubectl config view --raw -o json`.
    pattern:
      /(?<pre>(?<![\w-])client-(?:key|certificate)-data(?:\\?["'])?[ \t]*:[ \t]*(?:\\?["'])?)(?<secret>[A-Za-z0-9+/=]{16,})/g,
  },
  {
    kind: "authorization",
    pattern:
      /(?<pre>(?<![\w-])(?:proxy-)?authorization["']?[ \t]*[:=][ \t]*["']?(?:bearer|basic|token|bot)[ \t]+)(?<secret>[\w.~+/=-]{16,})/gi,
  },
  {
    // `Bearer <token>` outside a header (curl traces, SDK debug output). Prose such as
    // "Bearer authentication-required" has no digits.
    kind: "bearer_token",
    pattern: /(?<pre>(?<![\w-])bearer[ \t]+)(?<secret>[\w.~+/=-]{16,})/gi,
    accept: (secret) => /\d/.test(secret) && /[A-Za-z]/.test(secret),
  },
  {
    // scheme://user:password@host keeps the user and host. A URL password is a credential
    // even when it is short or a plain word, so only masks and references are spared.
    // As in WHATWG URL parsing, the user ends at the first ":" and the password at the last
    // "@" of the authority, so an e-mail user or an "@" in the password cannot leak part of
    // it. A user that is already a marker (`https://<token>@host`) is taken whole: splitting
    // it at its own ":" would mangle the marker and count the token twice. Quotes and angle
    // brackets end the URL, so a JSON string after it cannot be swallowed up to its "@".
    kind: "url_password",
    pattern: new RegExp(
      String.raw`(?<pre>(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/(?:${MARKER_PATTERN}|[^\s:/?#[\\"'\x60<>]){0,256}:)(?<secret>[^\s/?#\\"'\x60<>]{1,256})(?=@)`,
      "g",
    ),
    accept: (secret) => !isMaskedOrReference(secret),
  },
  {
    // `password=...`, `"api_key": "..."`, `client_secret: ...`. The keyword must end the key
    // (DB_PASSWORD, accessToken), so `TOKEN_PERMISSIONS: read` or `secret-scanning: enabled`
    // never reach the value checks. Quoted values may contain spaces; bare ones stop at
    // whitespace and common delimiters. `==`, `=~` and `::` are comparisons or paths.
    // Quotes may be JSON-escaped (`{\"password\":\"...\"}`), as in a secret manager's
    // SecretString or a JSON document logged inside another string.
    kind: (groups) => GENERIC_KINDS[(groups.kw ?? "").toLowerCase().replace(/[_-]/g, "")] ?? "secret",
    pattern: new RegExp(
      String.raw`(?<pre>(?<kw>${GENERIC_KEYWORDS})(?:\\?["'])?[ \t]*(?:=>|:=|=(?![=~])|:(?!:))[ \t]*(?:\\?["'])?)` +
        String.raw`(?<secret>(?<=\\")[^"\\\r\n]{1,1024}(?=\\")|(?<=")[^"\r\n]{1,1024}(?=")|(?<=')[^'\r\n]{1,1024}(?=')|(?<!["'])[^\s"'\x60,;&)\]}]+)`,
      "gi",
    ),
    accept: isPlausibleGenericSecret,
  },
];

/** Replace secrets in free text with `[REDACTED:<kind>]`. Pure and idempotent. */
export function redactSecrets(text: string): RedactionResult {
  // A secret glued to another one can fail its rule's boundary check (the neighbour's
  // characters continue the token) and only match once a later rule has turned that
  // neighbour into a marker. Repeating the pass until it finds nothing redacts it and keeps
  // the function idempotent; the cap guarantees termination on hostile input.
  let current = text;
  let count = 0;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const result = redactPass(current);
    if (result.count === 0) break;
    current = result.text;
    count += result.count;
  }
  return { text: current, count };
}

/** One application of every rule, in order. */
function redactPass(text: string): RedactionResult {
  let count = 0;
  let current = text;
  for (const rule of RULES) {
    current = current.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
      const replacement = redactMatch(rule, match, rest[rest.length - 1] as Groups);
      if (replacement === null) return match;
      count += 1;
      return replacement;
    });
  }
  return { text: current, count };
}

/** The replacement for one match, or null when the rule's candidate is rejected. */
function redactMatch(rule: Rule, match: string, groups: Groups): string | null {
  const secret = groups.secret;
  if (secret === undefined || secret.includes(MARKER_PREFIX)) return null;
  if (rule.accept !== undefined && !rule.accept(secret)) return null;
  const pre = groups.pre ?? "";
  const kind = typeof rule.kind === "string" ? rule.kind : rule.kind(groups);
  return pre + mask(kind, secret) + match.slice(pre.length + secret.length);
}

/**
 * The marker for a secret. A multi-line secret (a PEM block) keeps its line breaks and the
 * GitHub timestamps after them, so line numbers past it still match GitHub's log viewer and
 * every line still carries the timestamp that attributes it to a step.
 */
function mask(kind: string, secret: string): string {
  const marker = `${MARKER_PREFIX}${kind}]`;
  if (!secret.includes("\n")) return marker;
  return marker + (secret.match(LINE_BREAK_AND_TIMESTAMP) ?? []).join("");
}

/** GitHub's own mask, text already redacted, or a reference such as `$VAR`, `${{ secrets.X }}` or `<token>`. */
function isMaskedOrReference(value: string): boolean {
  return value.includes(MARKER_PREFIX) || value.includes(GITHUB_MASK) || /^[$<]/.test(value);
}

/**
 * Whether a value assigned to a secret-sounding key is plausibly the secret itself. This is
 * where false positives come from, so anything that reads as a reference, a placeholder, a
 * number, a path, a word or a code expression is spared.
 */
function isPlausibleGenericSecret(raw: string): boolean {
  const value = raw.trim();
  return (
    value.length >= MIN_GENERIC_SECRET_LENGTH &&
    !isMaskedOrReference(value) &&
    // Terraform's "(sensitive value)", {{ templates }}, [lists], %WINDOWS_VARS%, ***masks.
    !/^[({[%*]/.test(value) &&
    // Interpolation anywhere: "Bearer ${token}", "#{secret}", "%(password)s".
    !/\$\{|\{\{|#\{|%\(/.test(value) &&
    // One character repeated: xxxxxxxx, ........
    !/^(.)\1+$/.test(value) &&
    // Counts, ports, versions, dates.
    !/^[\d\s.,:_+-]+$/.test(value) &&
    // Paths and URLs (credentials inside URLs have their own rule).
    !/^(?:~|\.{1,2})?\/|^[A-Za-z]:[\\/]|^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) &&
    // Calls and lookups in code: getToken(), os.environ["TOKEN"].
    !/^[A-Za-z_$][\w$.]*[([]/.test(value) &&
    !isWordLike(value)
  );
}

/**
 * Letters split into words by separators or case changes, every word at least two letters:
 * `read`, `enabled`, `READ_WRITE`, `not-found`, `accessToken`, `config.apiKey`,
 * `XXXXX-XXXXX`. Random letter-only strings such as short base64 (`aHVudGVy`) break into
 * single-letter fragments and stay suspicious.
 */
function isWordLike(value: string): boolean {
  if (!/^[A-Za-z]+(?:[ _./-][A-Za-z]+)*$/.test(value)) return false;
  const words = value.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) ?? [];
  return words.every((word) => word.length >= 2);
}

// ───────────────────────────── credential names ─────────────────────────────

/** Words that name a credential on their own: `db_password`, `id_token`, `client_secret`. */
const CREDENTIAL_WORDS = new Set([
  "password",
  "passwords",
  "passwd",
  "passphrase",
  "pwd",
  "secret",
  "secrets",
  "token",
  "tokens",
  "credential",
  "credentials",
  "apikey",
  "accesskey",
  "secretkey",
  "privatekey",
  "clientsecret",
  "connectionstring",
]);

/** `<qualifier>_key` names a credential (`access_key`, `primary_key`); `kms_key`, `hash_key` do not. */
const KEY_QUALIFIERS = new Set([
  "access",
  "secret",
  "api",
  "account",
  "private",
  "shared",
  "master",
  "primary",
  "secondary",
  "signing",
  "auth",
  "storage",
  "admin",
  "client",
  "subscription",
  "instrumentation",
  "service",
  "webhook",
  "hmac",
  "sas",
]);

/** Trailing words that only describe an encoding or variant: `password_wo`, `secret_string`, `private_key_pem`. */
const TRANSPARENT_SUFFIXES = new Set([
  "wo",
  "value",
  "values",
  "b64",
  "base64",
  "pem",
  "openssh",
  "pkcs8",
  "raw",
  "plaintext",
  "string",
  "binary",
  "data",
  "encoded",
  "text",
]);

/** Prefixes on `*_key` names that are not secrets even when the value is long. */
const NON_SECRET_KEY_QUALIFIERS = new Set([
  "public",
  "kms",
  "cmk",
  "partition",
  "hash",
  "range",
  "sort",
  "row",
]);

const MAX_NAME_LENGTH = 128;

/** `adminPassword`, `DB_PASSWORD`, `private-key.pem` → lower-case words. */
function nameWords(name: string): string[] {
  return name
    .slice(0, MAX_NAME_LENGTH)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

/** Words without trailing variant suffixes and digits (`password_wo` → password, `token2` → token). */
function significantWords(name: string): string[] {
  const words = nameWords(name).map((word) => word.replace(/(?<=[a-z])\d+$/, ""));
  while (words.length > 1) {
    const last = words[words.length - 1]!;
    const prev = words[words.length - 2];
    if (last === "string" && prev === "connection") break;
    if (!TRANSPARENT_SUFFIXES.has(last) && !/^\d+$/.test(last)) break;
    words.pop();
  }
  return words;
}

/**
 * Whether an attribute, argument or variable name holds a credential: `password`,
 * `master_user_password`, `client_secret`, `auth_token`, `access_key`, `private_key_pem`,
 * `primary_connection_string`, `kube_config_raw`. Names that only describe a credential stay
 * readable: `kms_key_id`, `secret_arn`, `token_validity_units`, `min_password_length`.
 */
export function isCredentialName(name: string): boolean {
  const words = significantWords(name);
  const last = words[words.length - 1];
  const prev = words[words.length - 2];
  if (last === undefined) return false;
  if (CREDENTIAL_WORDS.has(last)) return true;
  if ((last === "key" || last === "keys") && prev !== undefined && KEY_QUALIFIERS.has(prev)) return true;
  if ((last === "string" || last === "strings") && prev === "connection") return true;
  if (last === "config" && words.includes("kube")) return true;
  return false;
}

/** A long opaque token (base64 / hex / url-safe): what a `*_key` attribute holding a secret looks like. */
export function looksOpaque(value: string): boolean {
  return (
    value.length >= 20 &&
    value.length <= 4096 &&
    /^[A-Za-z0-9+/=_.~-]+$/.test(value) &&
    /\d/.test(value) &&
    /[A-Za-z]/.test(value) &&
    !/^arn:|^projects\//.test(value) &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) &&
    // dotted names and paths: `module.db.key`, `a/b/c`
    !/^[A-Za-z_][\w-]*(?:[./][A-Za-z_][\w-]*)+$/.test(value)
  );
}

/**
 * Settings that credential-named attributes take as values: `http_tokens = "required"` (IMDSv2),
 * Cognito `token_validity_units { access_token = "hours" }`, `password_policy = "enabled"`.
 */
const SETTING_VALUES = new Set([
  "required",
  "optional",
  "enabled",
  "disabled",
  "enable",
  "disable",
  "true",
  "false",
  "none",
  "null",
  "auto",
  "default",
  "seconds",
  "minutes",
  "hours",
  "days",
]);

/** A setting keyword (`enabled`, `required`, `hours`, …): readable even under a credential name. */
export function isSettingValue(value: string): boolean {
  return SETTING_VALUES.has(value.toLowerCase());
}

/**
 * Whether a literal string assigned to `name` should be hidden: credential names always (when the
 * value is not empty or a setting keyword), and any other `*_key` name when the value is a long
 * opaque token.
 */
export function isSecretAssignment(name: string, value: string): boolean {
  if (value === "" || value === SENSITIVE_PLACEHOLDER || SETTING_VALUES.has(value.toLowerCase()))
    return false;
  if (isCredentialName(name)) return true;
  const words = significantWords(name);
  if (words[words.length - 1] !== "key") return false;
  const prev = words[words.length - 2];
  return (prev === undefined || !NON_SECRET_KEY_QUALIFIERS.has(prev)) && looksOpaque(value);
}

// ───────────────────────────── source text ─────────────────────────────

/**
 * `name = "literal"`, `"name": "literal"`, `name: 'literal'`. The name may not start inside another
 * word; the value is one quoted string on the line (HCL strings cannot span lines). Linear: the
 * lookbehind stops a name match from restarting inside the run it consumed.
 */
const QUOTED_ASSIGNMENT =
  /(?<![\w$-])(?<q>["']?)(?<name>[A-Za-z_][\w-]{0,127})\k<q>(?<sep>[ \t]*(?:=(?![=~>])|:(?!:))[ \t]*)(?<val>"(?:[^"\\\r\n]|\\.){0,4096}"|'(?:[^'\\\r\n]|\\.){0,4096}')/g;

/** `name = <<EOF` / `name = <<-EOF` at the end of a line. */
const HEREDOC_START =
  /^(?<head>[ \t]*["']?(?<name>[A-Za-z_][\w-]{0,127})["']?[ \t]*[=:][ \t]*)<<-?(?<tag>[A-Za-z_]\w*)[ \t]*\r?$/;

/** Interpolations and template directives make a string an expression, not a literal secret. */
function isTemplate(inner: string): boolean {
  return /\$\{|%\{/.test(inner);
}

/**
 * Mask source text read from `.tf` / `.tfvars` / `.tf.json` files: literal values assigned to
 * credential-like names become `(sensitive)` (quotes kept, heredoc line count kept), references and
 * function calls stay (`password = var.db_password`), then every secret format goes through
 * redactSecrets. Line numbers are preserved, so locations computed on the raw file stay valid.
 */
export function maskSourceText(text: string): string {
  const masked = maskHeredocs(text).replace(QUOTED_ASSIGNMENT, (match: string, ...rest: unknown[]) => {
    const groups = rest[rest.length - 1] as Groups;
    const name = groups.name ?? "";
    const val = groups.val ?? "";
    const inner = val.slice(1, -1);
    if (isTemplate(inner) || !isSecretAssignment(name, inner)) return match;
    const quote = val[0] ?? '"';
    return match.slice(0, match.length - val.length) + quote + SENSITIVE_PLACEHOLDER + quote;
  });
  return redactSecrets(masked).text;
}

/** Heredoc bodies of credential-like names: first body line → `(sensitive)`, the rest blank. */
function maskHeredocs(text: string): string {
  if (!text.includes("<<")) return text;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = HEREDOC_START.exec(lines[i]!);
    if (!m?.groups || !isCredentialName(m.groups.name ?? "")) continue;
    const tag = m.groups.tag ?? "";
    let end = i + 1;
    while (end < lines.length && lines[end]!.trim() !== tag) end++;
    for (let j = i + 1; j < end; j++) {
      const cr = lines[j]!.endsWith("\r") ? "\r" : "";
      lines[j] = j === i + 1 ? `${/^[ \t]*/.exec(lines[j]!)?.[0] ?? ""}${SENSITIVE_PLACEHOLDER}${cr}` : cr;
    }
    i = end;
  }
  return lines.join("\n");
}
