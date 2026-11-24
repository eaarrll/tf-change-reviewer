import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isCredentialName as fromRedact } from "../../src/redact.js";
import {
  isCredentialName,
  maskPlanJson,
  maskPlanJsonWithSecrets,
  maskSensitive,
} from "../../src/plan/mask.js";
import { SENSITIVE_PLACEHOLDER } from "../../src/types.js";

const S = SENSITIVE_PLACEHOLDER;

// Real `terraform show -json` output (terraform 1.10.5). See test/plan/load.test.ts for how they were made.
const readJson = (url: URL): Record<string, unknown> =>
  JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
const fixture = (name: string) => readJson(new URL(`../fixtures/plan/${name}`, import.meta.url));
const dbPlan = () =>
  readJson(new URL("../../evals/fixtures/db-encryption-replace/plan.json", import.meta.url));

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test navigation through plan JSON
type Any = any;

describe("maskSensitive", () => {
  it("replaces marked leaves and keeps the rest", () => {
    const value = { password: "p@ss", username: "app", port: 5432 };
    expect(maskSensitive(value, { password: true })).toEqual({ password: S, username: "app", port: 5432 });
  });

  it("hides a whole subtree marked true", () => {
    expect(maskSensitive({ creds: { user: "a", pass: "b" }, keep: 1 }, { creds: true })).toEqual({
      creds: S,
      keep: 1,
    });
    expect(maskSensitive({ a: [1, 2] }, true)).toBe(S);
  });

  it("follows marks through lists and nested blocks", () => {
    const value = {
      ingress: [
        { cidr: "0.0.0.0/0", secret: "s1" },
        { cidr: "10.0.0.0/8", secret: "s2" },
      ],
    };
    const marks = { ingress: [{}, { secret: true }] };
    expect(maskSensitive(value, marks)).toEqual({
      ingress: [
        { cidr: "0.0.0.0/0", secret: "s1" },
        { cidr: "10.0.0.0/8", secret: S },
      ],
    });
  });

  it("keeps null and missing values (nothing set, nothing to hide)", () => {
    expect(maskSensitive({ password: null }, { password: true })).toEqual({ password: null });
    expect(maskSensitive(null, true)).toBeNull();
    expect(maskSensitive({}, { password: true })).toEqual({});
  });

  it("masks booleans and numbers when marked (their value can be the secret)", () => {
    expect(maskSensitive({ pin: 1234, flag: false }, { pin: true, flag: true })).toEqual({ pin: S, flag: S });
  });

  it("ignores false, empty and mismatched marks", () => {
    const value = { a: "x", list: ["y"] };
    expect(maskSensitive(value, false)).toEqual(value);
    expect(maskSensitive(value, {})).toEqual(value);
    expect(maskSensitive(value, [true])).toEqual(value);
    expect(maskSensitive(value, { a: { nested: true }, list: { 0: true } })).toEqual(value);
    expect(maskSensitive("plain", { a: true })).toBe("plain");
  });

  it("does not mutate its input", () => {
    const value = { password: "p@ss", nested: { token: "t" } };
    const copy = structuredClone(value);
    maskSensitive(value, { password: true, nested: { token: true } });
    expect(value).toEqual(copy);
  });

  it("never throws on odd input", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => maskSensitive(cyclic, { self: { a: true } })).not.toThrow();
    expect(maskSensitive(undefined, undefined)).toBeUndefined();
    expect(maskSensitive(() => 1, true)).toBeNull();
  });
});

describe("isCredentialName", () => {
  it("is the shared heuristic from redact.ts", () => {
    expect(isCredentialName).toBe(fromRedact);
    expect(isCredentialName("master_user_password")).toBe(true);
    expect(isCredentialName("kms_key_id")).toBe(false);
  });
});

describe("maskPlanJson: real AWS plan (db-encryption-replace)", () => {
  it("hides the RDS password and the provider credentials everywhere", () => {
    const masked = JSON.stringify(maskPlanJson(dbPlan()));

    expect(masked).not.toContain("not-a-real-password-123");
    expect(masked).not.toContain("mock_secret_key");
    expect(masked).not.toContain("mock_access_key");
  });

  it("puts the placeholder exactly where the values were", () => {
    const m = maskPlanJson(dbPlan()) as Any;
    const db = m.resource_changes[0];

    expect(db.change.before.password).toBe(S);
    expect(db.change.after.password).toBe(S);
    expect(m.configuration.provider_config.aws.expressions.access_key).toEqual({ constant_value: S });
    expect(m.configuration.provider_config.aws.expressions.secret_key).toEqual({ constant_value: S });
    expect(
      m.configuration.root_module.module_calls.orders_db.module.resources[0].expressions.password,
    ).toEqual({ constant_value: S });
    // planned_values lacks the password mark here; the resource change's mark covers it.
    expect(m.planned_values.root_module.child_modules[0].resources[0].values.password).toBe(S);
    expect(m.prior_state.values.root_module.child_modules[0].resources[0].values.password).toBe(S);
  });

  it("keeps everything a reviewer needs readable", () => {
    const m = maskPlanJson(dbPlan()) as Any;
    const db = m.resource_changes[0];

    expect(db.change.before.storage_encrypted).toBe(true);
    expect(db.change.after.storage_encrypted).toBe(false);
    expect(db.change.after.identifier).toBe("orders-prod");
    expect(db.change.after.username).toBe("app");
    expect(db.change.before.kms_key_id).toBe("mock-kms_key_id");
    expect(db.change.before.master_user_secret_kms_key_id).toBe("mock-master_user_secret_kms_key_id");
    expect(db.change.replace_paths).toEqual([["storage_encrypted"]]);
    expect(m.configuration.provider_config.aws.expressions.region).toEqual({ constant_value: "eu-west-1" });
    expect(m.configuration.provider_config.aws.version_constraint).toBe("~> 6.0");
    expect(m.variables).toEqual({ orders_db_encrypted: { value: false } });
  });

  it("only changes the values it hides", () => {
    const raw = dbPlan();
    const masked = maskPlanJson(raw);
    const changed: string[] = [];
    const diff = (a: unknown, b: unknown, path: string): void => {
      if (a && b && typeof a === "object" && typeof b === "object") {
        for (const k of Object.keys(a)) diff((a as Any)[k], (b as Any)[k], `${path}.${k}`);
      } else if (JSON.stringify(a) !== JSON.stringify(b)) {
        expect(b, path).toBe(S);
        changed.push(path.replace(/\.\d+\./g, ".N."));
      }
    };
    diff(raw, masked, "");

    // The attribute each hidden value belongs to (a configuration constant is named by its parent).
    const names = changed.map((p) => {
      const parts = p.split(".");
      return parts.at(-1) === "constant_value" ? parts.at(-2) : parts.at(-1);
    });
    // `value` is aws_ssm_parameter.value, which the provider marks sensitive.
    expect(new Set(names)).toEqual(new Set(["password", "value", "access_key", "secret_key"]));
    expect(changed.filter((p) => p.endsWith(".constant_value")).sort()).toEqual([
      ".configuration.provider_config.aws.expressions.access_key.constant_value",
      ".configuration.provider_config.aws.expressions.secret_key.constant_value",
      ".configuration.root_module.module_calls.orders_db.module.resources.N.expressions.password.constant_value",
    ]);
  });

  it("does not mutate the input and is idempotent", () => {
    const raw = dbPlan();
    const once = maskPlanJson(raw);

    expect(raw).toEqual(dbPlan());
    expect(maskPlanJson(once)).toEqual(once);
  });
});

describe("maskPlanJson: real terraform_data plans", () => {
  const SECRETS = ["v1-secret-value-AAA", "v2-secret-value-BBB", "plain-in-map-123", "zzz-password-999"];

  it("hides sensitive values, including copies terraform leaves unmarked", () => {
    const raw = fixture("lifecycle.json") as Any;
    // Precondition (verified terraform behaviour): `output` repeats the sensitive `input` unmarked.
    const holder = raw.resource_changes.find((rc: Any) => rc.address === "terraform_data.secret_holder");
    expect(holder.change.before_sensitive).toEqual({ input: true });
    expect(holder.change.before.output).toBe("v1-secret-value-AAA");

    const masked = maskPlanJson(raw) as Any;
    const text = JSON.stringify(masked);
    for (const secret of SECRETS) expect(text, secret).not.toContain(secret);

    const m = masked.resource_changes.find((rc: Any) => rc.address === "terraform_data.secret_holder");
    expect(m.change.before).toMatchObject({ input: S, output: S });
    expect(m.change.after.input).toBe(S);
  });

  it("hides sensitive root variables, their defaults and sensitive outputs, keeps plain ones", () => {
    const m = maskPlanJson(fixture("lifecycle.json")) as Any;

    expect(m.variables).toEqual({ db_password: { value: S }, plain: { value: "p2" } });
    expect(m.configuration.root_module.variables.db_password).toEqual({ default: S, sensitive: true });
    expect(m.configuration.root_module.variables.plain).toEqual({ default: "p2" });
    expect(m.output_changes.secret_out).toMatchObject({ before: S, after: S });
    expect(m.output_changes.plain_out).toMatchObject({ before: "p1", after: "p2" });
    expect(m.planned_values.outputs.secret_out.value).toBe(S);
    expect(m.prior_state.values.outputs.secret_out.value).toBe(S);
    expect(m.planned_values.outputs.plain_out.value).toBe("p2");
  });

  it("hides unmarked credential-named values but not their neighbours", () => {
    const m = maskPlanJson(fixture("lifecycle.json")) as Any;
    const update = m.resource_changes.find((rc: Any) => rc.address === "terraform_data.update");

    expect(update.change.before.input).toEqual({ password: S, plain: "p1", size: 1 });
    expect(update.change.after.input).toEqual({ password: S, plain: "p2", size: 2 });
  });

  it("hides module variable defaults and inline secrets by name", () => {
    const masked = maskPlanJson(fixture("modules.json")) as Any;
    const text = JSON.stringify(masked);

    expect(text).not.toContain("svc-default-token-Q7");
    expect(text).not.toContain("inline-client-secret-77");
    expect(masked.configuration.root_module.module_calls.svc.module.variables.api_token).toEqual({
      default: S,
    });
    expect(masked.resource_changes[0].change.before.input).toEqual({ client_secret: S, key: "a" });
  });

  it("leaves a plan without secrets unchanged", () => {
    const raw = fixture("import.json");
    expect(maskPlanJson(raw)).toEqual(raw);
  });
});

describe("maskPlanJson: handcrafted shapes", () => {
  const rc = (change: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    address: "aws_db_instance.db",
    mode: "managed",
    type: "aws_db_instance",
    name: "db",
    change: { actions: ["update"], after_unknown: {}, ...change },
    ...extra,
  });

  it("masks resource_drift like resource_changes", () => {
    const m = maskPlanJson({
      format_version: "1.2",
      resource_drift: [
        rc({
          before: { password: "drift-pw-1" },
          after: { password: "drift-pw-2" },
          before_sensitive: { password: true },
          after_sensitive: { password: true },
        }),
      ],
    }) as Any;
    expect(m.resource_drift[0].change.before.password).toBe(S);
    expect(m.resource_drift[0].change.after.password).toBe(S);
  });

  it("sweeps a hidden value's escaped and line-split copies (jsonencode, heredocs) too", () => {
    const pw = 'Def&Pass<w>"q1-x';
    // jsonencode() output as Terraform writes it: Go's encoder escapes & < > and the quote.
    const encoded = JSON.stringify({ env: [{ value: pw }] }).replace(
      /[&<>]/g,
      (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
    );
    const m = maskPlanJson({
      format_version: "1.2",
      resource_changes: [
        rc({
          before: null,
          after: { password: pw, config: "host=db.internal\nkey=Zq81-Line-Secret\n" },
          before_sensitive: false,
          after_sensitive: { password: true, config: true },
        }),
        rc(
          {
            before: null,
            after: { container_definitions: encoded, lines: ["host=x", "key=Zq81-Line-Secret"] },
            before_sensitive: false,
            after_sensitive: {},
          },
          { address: "aws_ecs_task_definition.app", type: "aws_ecs_task_definition", name: "app" },
        ),
      ],
    }) as Any;
    const after = m.resource_changes[1].change.after;
    expect(after.container_definitions).toBe(`{"env":[{"value":"${S}"}]}`);
    expect(after.lines).toEqual(["host=x", S]);
  });

  it("keeps lines a multi-line secret shares with an unmarked value, unless they are all there in a row", () => {
    const worker = [
      "#!/bin/bash",
      "set -euo pipefail",
      "export DB_PASS='Qp7-Real-Db-Pass'",
      "systemctl restart worker-service",
      "",
    ].join("\n");
    const web = [
      "#!/bin/bash",
      "set -euo pipefail",
      "systemctl restart worker-service",
      "curl -fsS http://localhost/health",
      "",
    ].join("\n");
    const m = maskPlanJson({
      format_version: "1.2",
      resource_changes: [
        rc({
          before: null,
          after: { input: worker },
          before_sensitive: false,
          after_sensitive: { input: true },
        }),
        rc(
          {
            before: null,
            after: { input: web, copy: `# run\n  ${worker.split("\n").join("\n  ")}` },
            before_sensitive: false,
            after_sensitive: {},
          },
          { address: "terraform_data.web", type: "terraform_data", name: "web" },
        ),
      ],
    }) as Any;
    const after = m.resource_changes[1].change.after;
    expect(after.input).toBe(web);
    // An indented copy of the whole script is hidden line by line.
    expect(after.copy).toBe(`# run\n  ${S}\n  ${S}\n  ${S}\n  ${S}\n  `);
  });

  it("keeps the change of a non-sensitive script that shares secret-looking ordinary lines with a sensitive one", () => {
    // A templatefile() user_data with one sensitive var is sensitive as a whole; its region and
    // echo lines (mixed character classes) are no secrets, and web's region change must stay visible.
    const lines = (...l: string[]) => [...l, ""].join("\n");
    const worker = lines(
      "#!/bin/bash",
      "export AWS_DEFAULT_REGION=us-east-1",
      'echo "Installing Docker 24"',
      "export DB_PASS='Qp7-Real-Db-Pass'",
    );
    const webBefore = lines(
      "#!/bin/bash",
      "export AWS_DEFAULT_REGION=us-east-1",
      'echo "Installing Docker 24"',
      "curl -fsS http://localhost/health",
    );
    const webAfter = webBefore.replace("us-east-1", "us-west-2");
    const m = maskPlanJson({
      format_version: "1.2",
      resource_changes: [
        rc(
          {
            before: { user_data: worker },
            after: { user_data: worker },
            before_sensitive: { user_data: true },
            after_sensitive: { user_data: true },
          },
          { address: "aws_instance.worker", type: "aws_instance", name: "worker" },
        ),
        rc(
          {
            actions: ["delete", "create"],
            before: { user_data: webBefore, note: "key line: export DB_PASS='Qp7-Real-Db-Pass' (old)" },
            after: { user_data: webAfter },
            before_sensitive: {},
            after_sensitive: {},
          },
          { address: "aws_instance.web", type: "aws_instance", name: "web" },
        ),
      ],
    }) as Any;
    const web = m.resource_changes[1].change;
    expect(web.before.user_data).toBe(webBefore);
    expect(web.after.user_data).toBe(webAfter);
    // The secret line itself is hidden wherever it is copied, inside a longer line too.
    expect(web.before.note).toBe(`key line: ${S} (old)`);
    expect(m.resource_changes[0].change.after.user_data).toBe(S);
  });

  it("sweeps a hidden value out of longer strings elsewhere (connection strings, URLs)", () => {
    const m = maskPlanJson({
      format_version: "1.2",
      resource_changes: [
        rc({
          before: null,
          after: { master_password: "Correct-Horse-9", endpoint: "db.internal" },
          before_sensitive: false,
          after_sensitive: { master_password: true },
        }),
        rc(
          {
            before: null,
            after: { value: "postgres://app:Correct-Horse-9@db.internal:5432/app", name: "/app/dsn" },
            before_sensitive: false,
            after_sensitive: {},
          },
          { address: "aws_ssm_parameter.dsn", type: "aws_ssm_parameter", name: "dsn" },
        ),
      ],
    }) as Any;
    const dsn = m.resource_changes[1].change.after;

    expect(JSON.stringify(m)).not.toContain("Correct-Horse-9");
    expect(dsn.name).toBe("/app/dsn");
    expect(dsn.value).toContain("db.internal");
  });

  it("sweeps short hidden values only on exact match, and very short ones not at all", () => {
    const m = maskPlanJson({
      format_version: "1.2",
      resource_changes: [
        rc({
          before: null,
          after: { pin: "4711", code: "ab", other: "4711", text: "room 4711", ab: "ab" },
          before_sensitive: false,
          after_sensitive: { pin: true, code: true },
        }),
      ],
    }) as Any;
    expect(m.resource_changes[0].change.after).toEqual({
      pin: S,
      code: S,
      other: S,
      text: "room 4711",
      ab: "ab",
    });
  });

  it("masks credential-named constants in resource and module-call expressions, nested blocks included", () => {
    const m = maskPlanJson({
      format_version: "1.2",
      planned_values: {},
      configuration: {
        root_module: {
          resources: [
            {
              address: "aws_mq_broker.b",
              mode: "managed",
              type: "aws_mq_broker",
              name: "b",
              expressions: {
                user: [
                  { username: { constant_value: "admin" }, password: { constant_value: "broker-pass-1" } },
                ],
                engine_type: { constant_value: "RabbitMQ" },
              },
            },
          ],
          module_calls: {
            db: {
              source: "./db",
              expressions: {
                admin_password: { constant_value: "module-arg-pass" },
                password_ref: { references: ["var.db_password"] },
                kms_key_id: { constant_value: "alias/db" },
              },
              module: {
                outputs: {
                  dsn: { sensitive: true, expression: { constant_value: "not-even-a-secret-name" } },
                },
              },
            },
          },
        },
      },
    }) as Any;
    const res = m.configuration.root_module.resources[0].expressions;
    const call = m.configuration.root_module.module_calls.db;

    expect(res.user[0]).toEqual({ username: { constant_value: "admin" }, password: { constant_value: S } });
    expect(res.engine_type).toEqual({ constant_value: "RabbitMQ" });
    expect(call.expressions.admin_password).toEqual({ constant_value: S });
    expect(call.expressions.password_ref).toEqual({ references: ["var.db_password"] });
    expect(call.expressions.kms_key_id).toEqual({ constant_value: "alias/db" });
    expect(call.module.outputs.dsn.expression).toEqual({ constant_value: S });
  });

  it("masks credential-named root variables even when not declared sensitive", () => {
    const m = maskPlanJson({
      format_version: "1.2",
      resource_changes: [],
      variables: { github_token: { value: "tok-from-tfvars" }, region: { value: "eu-west-1" } },
    }) as Any;
    expect(m.variables).toEqual({ github_token: { value: S }, region: { value: "eu-west-1" } });
  });

  it("keeps non-string values under credential names and descriptive names readable", () => {
    const after = {
      manage_master_user_password: true,
      password_wo_version: 2,
      token_validity_units: [{ access_token: "hours" }],
      secret_arn: "arn:aws:secretsmanager:eu-west-1:123456789012:secret:db",
      kms_key_id: "arn:aws:kms:eu-west-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab",
      passwords: ["pw-one-1", "pw-two-2"],
      credentials: [{ username: "u", password: "pw-three-3" }],
    };
    const m = maskPlanJson({
      format_version: "1.2",
      resource_changes: [rc({ before: null, after, before_sensitive: false, after_sensitive: {} })],
    }) as Any;
    expect(m.resource_changes[0].change.after).toEqual({
      manage_master_user_password: true,
      password_wo_version: 2,
      // a setting keyword, not a token
      token_validity_units: [{ access_token: "hours" }],
      secret_arn: after.secret_arn,
      kms_key_id: after.kms_key_id,
      passwords: [S, S],
      credentials: [{ username: "u", password: S }],
    });
  });

  it("keeps setting keywords under credential names, hides and sweeps the rest", () => {
    const m = maskPlanJson({
      format_version: "1.2",
      resource_changes: [
        rc({
          before: null,
          after: {
            token_validity_units: [{ access_token: "hours", id_token: "minutes" }],
            metadata_options: [{ http_tokens: "required" }],
            schedule: "hours",
            api_token: "tok-2024-abc",
            note: "rotated tok-2024-abc",
          },
          before_sensitive: false,
          after_sensitive: {},
        }),
      ],
    }) as Any;
    expect(m.resource_changes[0].change.after).toEqual({
      token_validity_units: [{ access_token: "hours", id_token: "minutes" }],
      metadata_options: [{ http_tokens: "required" }],
      schedule: "hours",
      api_token: S,
      note: `rotated ${S}`,
    });
  });

  it("sweeps every marked value document-wide, plain over-marked ones included (value equality)", () => {
    // aws_ssm_parameter.value is marked sensitive by the provider even for a plain queue name.
    const ssm = (key: string, value: string) =>
      rc(
        {
          actions: ["update"],
          before: { name: `/app/${key}`, value, echo: value },
          after: { name: `/app/${key}`, value, echo: value },
          before_sensitive: { value: true },
          after_sensitive: { value: true },
        },
        { address: `aws_ssm_parameter.p["${key}"]`, type: "aws_ssm_parameter", name: "p" },
      );
    const queue = rc(
      {
        actions: ["update"],
        before: { name: "prod-cart-events", dlq: "prod-cart-events-dlq", secret_copy: "s3cr3t-Value-77" },
        after: { name: "prod-cart-events", dlq: "prod-cart-events-dlq", secret_copy: "s3cr3t-Value-77" },
      },
      { address: "aws_sqs_queue.q", type: "aws_sqs_queue", name: "q" },
    );
    const m = maskPlanJson({
      format_version: "1.2",
      resource_changes: [ssm("cart", "prod-cart-events"), ssm("key", "s3cr3t-Value-77"), queue],
      prior_state: {
        values: {
          root_module: {
            resources: [
              {
                address: 'aws_ssm_parameter.p["cart"]',
                values: { value: "prod-cart-events", echo: "prod-cart-events" },
                sensitive_values: { value: true },
              },
            ],
          },
        },
      },
    }) as Any;
    const [cart, key, q] = m.resource_changes;

    expect(cart.change.after).toEqual({ name: "/app/cart", value: S, echo: S });
    expect(key.change.after).toEqual({ name: "/app/key", value: S, echo: S });
    expect(m.prior_state.values.root_module.resources[0].values).toEqual({ value: S, echo: S });
    // Strict union: Terraform leaves derived copies unmarked, so a marked value is hidden everywhere,
    // even when the provider over-marks a plain queue name. Addresses are never rewritten.
    expect(q.change.after).toEqual({ name: S, dlq: `${S}-dlq`, secret_copy: S });
    expect(m.resource_changes[0].address).toBe('aws_ssm_parameter.p["cart"]');
  });

  it("hides module-call constants feeding a sensitive child variable, and sweeps their copies", () => {
    const { masked, secrets } = maskPlanJsonWithSecrets({
      format_version: "1.2",
      resource_changes: [
        rc({
          before: null,
          after: { note: "seed=Bootstrap-Seed-42" },
          before_sensitive: false,
          after_sensitive: {},
        }),
      ],
      configuration: {
        root_module: {
          module_calls: {
            app: {
              source: "./app",
              expressions: {
                init_value: { constant_value: "Bootstrap-Seed-42" },
                size: { constant_value: "small" },
              },
              module: { variables: { init_value: { sensitive: true }, size: {} } },
            },
          },
        },
      },
    });
    const m = masked as Any;
    expect(m.configuration.root_module.module_calls.app.expressions).toEqual({
      init_value: { constant_value: S },
      size: { constant_value: "small" },
    });
    expect(m.resource_changes[0].change.after.note).toBe(`seed=${S}`);
    expect(secrets.has("Bootstrap-Seed-42")).toBe(true);
    expect(secrets.has("small")).toBe(false);
  });

  it("hides credential-named provider constants (nested blocks too) and sweeps their copies", () => {
    const { masked, secrets } = maskPlanJsonWithSecrets({
      format_version: "1.2",
      resource_changes: [
        rc({
          before: null,
          after: { user_data: "export K=plain-provider-key" },
          before_sensitive: false,
          after_sensitive: {},
        }),
      ],
      configuration: {
        provider_config: {
          aws: {
            name: "aws",
            expressions: {
              region: { constant_value: "eu-west-1" },
              secret_key: { constant_value: "plain-provider-key" },
              assume_role: [
                { external_id: { constant_value: "ext-1" }, session_name: { constant_value: "ci" } },
              ],
            },
          },
        },
      },
    });
    const m = masked as Any;
    expect(m.configuration.provider_config.aws.expressions.region).toEqual({ constant_value: "eu-west-1" });
    expect(m.configuration.provider_config.aws.expressions.secret_key).toEqual({ constant_value: S });
    expect(m.resource_changes[0].change.after.user_data).toBe(`export K=${S}`);
    expect(secrets.has("plain-provider-key")).toBe(true);
  });

  it("hides outputs declared sensitive even without marks, and setting keywords stay out of the sweep", () => {
    const { masked, secrets } = maskPlanJsonWithSecrets({
      format_version: "1.2",
      resource_changes: [
        rc({
          before: null,
          after: { mode: "enabled", dsn: "out-Value-7781" },
          before_sensitive: false,
          after_sensitive: {},
        }),
      ],
      output_changes: { dsn: { actions: ["create"], before: null, after: "out-Value-7781" } },
      variables: { flag: { value: "enabled" } },
      configuration: {
        root_module: {
          outputs: { dsn: { sensitive: true } },
          variables: { flag: { sensitive: true, default: "enabled" } },
        },
      },
    });
    const m = masked as Any;
    expect(m.output_changes.dsn.after).toBe(S);
    expect(m.resource_changes[0].change.after).toEqual({ mode: "enabled", dsn: S });
    expect(m.variables.flag.value).toBe(S);
    expect(secrets.has("enabled")).toBe(false);
  });

  it("sweeps hidden values containing regex metacharacters literally", () => {
    const secret = "a.b*c+(d)?[e]{f}|g^h$i\\j";
    const m = maskPlanJson({
      format_version: "1.2",
      resource_changes: [
        rc({
          before: null,
          after: { password: secret, copy: `x ${secret} y`, lookalike: "aXbbbcd" },
          before_sensitive: false,
          after_sensitive: { password: true },
        }),
      ],
    }) as Any;
    expect(m.resource_changes[0].change.after).toEqual({
      password: S,
      copy: `x ${S} y`,
      lookalike: "aXbbbcd",
    });
  });

  it("replaces the longest hidden value first when one contains another", () => {
    const m = maskPlanJson({
      format_version: "1.2",
      resource_changes: [
        rc({
          before: null,
          after: { a: "secret-part-1", b: "secret-part-1-and-more", text: "v=secret-part-1-and-more;" },
          before_sensitive: false,
          after_sensitive: { a: true, b: true },
        }),
      ],
    }) as Any;
    expect(m.resource_changes[0].change.after.text).toBe(`v=${S};`);
  });

  it("redacts secret formats in any string, keys left alone", () => {
    const awsKey = ["AK", "IA", "FAKE0000EXAMPLE0"].join("");
    const m = maskPlanJson({
      format_version: "1.2",
      resource_changes: [
        rc({
          before: null,
          after: { tags: { Note: `rotated ${awsKey}`, Owner: "team-db" }, user_data: `export KEY=${awsKey}` },
          before_sensitive: false,
          after_sensitive: {},
        }),
      ],
    }) as Any;
    expect(m.resource_changes[0].change.after.tags).toEqual({
      Note: "rotated [REDACTED:aws_access_key_id]",
      Owner: "team-db",
    });
    expect(JSON.stringify(m)).not.toContain(awsKey);
  });

  it("never throws on odd input", () => {
    const cyclic: Record<string, unknown> = { format_version: "1.2" };
    cyclic.resource_changes = [cyclic];
    let deep: unknown = "leaf";
    for (let i = 0; i < 5000; i++) deep = { password: deep };

    for (const input of [
      null,
      undefined,
      42,
      "plain",
      [],
      [1, "two"],
      {},
      cyclic,
      deep,
      { resource_changes: "nope", prior_state: 3, planned_values: [], output_changes: [null] },
      { resource_changes: [null, 1, { change: null }, { change: { before: 1, before_sensitive: true } }] },
      { variables: { x: null }, configuration: { root_module: { variables: { x: { sensitive: true } } } } },
      { configuration: { root_module: { module_calls: { a: null, b: { module: [] } } } } },
    ]) {
      expect(() => maskPlanJson(input)).not.toThrow();
    }
    expect(maskPlanJson("token: Fake0Fake0Fake0")).toBe("token: [REDACTED:token]");
    expect(maskPlanJson(null)).toBeNull();
  });
});
