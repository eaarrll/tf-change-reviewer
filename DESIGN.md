# tf-change-reviewer: design

**Question it answers:** "Which change in this 400-line plan needs my attention, and which line of my PR caused it?"

**Success metric:** precision (flagged changes reviewers confirm are material) and recall (material
changes the bot misses), measured two ways:

- **offline**: `npm run eval` on labeled fixtures made from real provider plans (`evals/`);
- **live**: reviewers tick "confirmed" boxes and reply `missed: <address>` on the PR comment;
  `tf-change-reviewer metrics` turns those into precision/recall over time.

## Pipeline

```
plan.json ─ plan/load ─▶ PlanModel (values masked) ─ risk/score ─▶ ScoredChange[]
PR diff  ─ git/diff ──▶ DiffIndex ─┐                                  │
repo     ─ lineage/hcl+source ─────┴─ lineage/trace ─▶ Lineage per candidate change
                                         │
             (API key?) agent/agent ─────┴─▶ AgentVerdict (confirms, demotes, adds, explains)
                                         │
                                 review.ts merge ─▶ Review ─ report/markdown ─▶ PR comment / CLI
```

Deterministic first, model second. With no API key the tool still works (rules + lineage only).
The model never sees an unmasked sensitive value and has only read-only tools. If the agent fails,
the review falls back to the deterministic findings ("fails open").

## Module contract (see `src/types.ts`)

| Module                  | Exports                                                                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/plan/paths.ts`     | `parseAddress`, `formatPath`, `pathKey`, `getAtPath`, `isPrefix`, `diffPaths`, `changedPaths`, `deepEqual` (done)                                              |
| `src/git/diff.ts`       | `parseUnifiedDiff(text): DiffIndex`, `gitDiff(root, base, head)`, `emptyDiff()`, `normalizePath` (done)                                                        |
| `src/redact.ts`         | `redactSecrets(text): { text, count }`, port of ci-triage-agent's secret-format redaction                                                                      |
| `src/plan/mask.ts`      | `maskSensitive(value, marks)`, `maskPlanJson(raw)`, `maskPlanJsonWithSecrets(raw): { masked, secrets }` (strict union, value equality)                         |
| `src/plan/load.ts`      | `parsePlanText(text \| bytes): unknown` (wrapper noise, UTF-16), `decodePlanBytes`, `loadPlan(json): PlanModel`, `planSecrets`, `PlanError`                    |
| `src/risk/rules.ts`     | rule tables (stateful types, force-new surprises, dangerous in-place updates, noise)                                                                           |
| `src/risk/score.ts`     | `scoreChange(change, plan, ctx?)`, `scorePlan(plan)` (non-no-op, score desc), `escalateForLineage`, `withSignals`, `isDestroyPlan`                             |
| `src/lineage/hcl.ts`    | `parseHcl(text): HclBody` with line spans (tolerant, never throws), `findReferences(expr): string[]`                                                           |
| `src/lineage/source.ts` | `class SourceIndex` (locate resources, attributes, nested blocks, module calls + arguments, variables, defaults, locals, outputs, tfvars)                      |
| `src/lineage/trace.ts`  | `traceChange(change, ctx, attribute? \| attributes[])`; `TraceContext = { plan, source, diff, diffText, changesByAddress, maxDepth? }`                         |
| `src/lineage/chain.ts`  | the lineage as a tree (`parentId`, plus `alsoParentIds` for shared steps): `pathsTo`, `causePaths`, `topSteps`, `collapsePath`                                 |
| `src/plan/align.ts`     | `alignBefore(before, after, marks)`: set-ordered nested blocks lined up by identity before any path is computed                                                |
| `src/references.ts`     | `stillReferencedSignals(plan)`: deleted objects that resources the plan keeps still use by a literal ID / ARN / alias name                                     |
| `src/agent/*`           | `runAgentReview(input, opts): Promise<AgentOutcome>`, read-only tools over an `AgentToolContext`, `DENIED_FILES` / `isDeniedPath`, zod verdict schema, pricing |
| `src/report/*`          | `renderReviewComment(reviews, meta)`, `renderCliReport(reviews)`, permalinks, hidden data marker                                                               |
| `src/metrics/*`         | `parseFeedback(comment, replies)`, `computeMetrics(prs)`, GitHub fetcher                                                                                       |
| `src/review.ts`         | `reviewPlan(input): Promise<Review>` (orchestration + merge policy), `planNotices`, `traceAttributes`                                                          |
| `src/findings.ts`       | deterministic finding text, stable ids, cause links, "not explained by this PR" sources, `groupByRootCause`                                                    |
| `src/scrub.ts`          | `createScrubber(values)`: value-equality scrubbing of text from outside the plan; `encodedForms(value)`, `isSecretLine(line)`                                  |
| `src/workspace.ts`      | `createFsWorkspace(root, dir)`, `normalizeRepoPath`, `isPlanOrStateText(text)` (plan/state JSON under any name reads as missing)                               |
| `src/cli.ts`            | `tf-change-reviewer review …` / `metrics …`                                                                                                                    |
| `src/action.ts`         | GitHub Action entry (inputs, sticky comment, job summary, outputs, fail-on); `src/config.ts` inputs                                                            |
| `src/pr-diff.ts`        | PR diff for the Action: three-dot git diff → fetch + two-dot → pulls.listFiles patches                                                                         |
| `src/github.ts`         | sticky comment per plan set (find by key/create/update), pull request SHAs, file patches, `isTrustedAuthor`, behind a small port                               |

## Masking (must hold everywhere text leaves the process: model, comment, logs)

1. Resource values: every path marked in `before_sensitive` / `after_sensitive` → `"(sensitive)"`.
   `terraform show -json` prints sensitive values in clear text (verified: an RDS `password` appears
   verbatim in `change.before`).
2. Root variables declared `sensitive = true` (`configuration.root_module.variables[x].sensitive`).
3. Provider configuration `constant_value`s: the plan JSON contains provider arguments in clear text
   (verified: `access_key`/`secret_key` constants appear in `configuration.provider_config`). Mask any
   argument whose name looks like a credential (key, secret, token, password, client_secret, …).
4. Attribute-name heuristic for unmarked values: `password`, `secret`, `token`, `private_key`,
   `connection_string`, `*_key` holding long opaque strings, etc.
5. Secret-looking strings anywhere (AWS keys, JWTs, PEM blocks, GitHub tokens, …) via `redactSecrets`.
6. Source snippets read from `.tf`/`.tfvars` files pass through `redactSecrets` and the same name
   heuristic (`password = "…"` → `password = "(sensitive)"`).
7. Strict union + value equality: the marked set is every `*_sensitive` mark (changes and drift),
   sensitive outputs, sensitive root variables (value and default), module-call constants feeding a
   sensitive child variable, and credential-named provider constants. Terraform leaves derived copies
   unmarked, so every marked string of 4+ characters is also hidden wherever it occurs in the plan
   (8+ characters inside longer strings too; addresses and other structural fields are never
   rewritten), and the same set scrubs text from outside the plan before it leaves: source files and
   the diff the agent reads, lineage snippets, model output, the report. One exception: a plain
   `String` SSM parameter's value (always over-marked by the provider) is hidden in place only.
   Each value is matched in its encoded forms too: HCL-quoted (`\\ \" \n \r \t`), HCL template escapes
   (`$${`, `%%{`), JSON string bodies and Go's HTML-safe JSON escapes (`& < >`). Short values (4-7
   characters) are matched only as a whole or quoted token. A multi-line value is also matched line by
   line: (a) all of its lines, as whole lines with indentation and diff markers ignored, when they
   appear in a row (indented `<<-EOT` heredocs, full diff hunks, indented copies); (b) a single line
   on its own, anywhere and in any encoding, only when that line holds a secret itself (a credential
   assignment, an assignment of a secret-looking token, or such a token alone, e.g. a PEM body line).
   Lines a secret script shares with ordinary ones (`#!/bin/bash`, `export AWS_DEFAULT_REGION=…`, PEM
   BEGIN/END headers) stay visible, so a non-sensitive resource's real change is not hidden. The
   matcher prefilters text with an 8-character prefix lookup, so hundreds of secrets cost about as
   much as a few.
8. Files the agent never sees: `DENIED_FILES` (state by name, `*.tfstate` plus any suffix such as
   `.backup` or `.json`; saved plans `*.tfplan[.json]`; `.env*`; keys; CLI credentials; `.git/`),
   enforced by `read_file`, `search_repo` and `get_diff` (which keeps a denied file in its file list
   but replaces its hunks with a "not shown" line, also for hunks holding plan/state-only keys).
   Configuration whose name merely contains `.tfstate` (`remote.tfstate.tf`) stays readable. A plan
   or state JSON under any name is refused by its content (`isPlanOrStateText`): the fs workspace reads
   it as missing, so `plan-json: infra/plan.json` inside the checkout is safe and cause refs to it are
   dropped.

## Risk scoring

Severity: `critical` (data loss / outage / security exposure likely), `high` (needs a deliberate yes),
`medium` (worth a look), `low` (ordinary change), `noise` (known churn: tags-only, `tags_all`, perpetual
diffs). A change's severity = its worst signal. Findings shown in "Needs your attention" are
`critical`/`high` (and `medium` when the agent promotes them). Details live in `src/risk/rules.ts`;
`DESIGN-risk.md` lists the rules with sources.

Plan-level signals: mass destroy (≥ 5 deletes/replacements), count/for_each re-indexing
(`delete_because_count_index` / `delete_because_each_key`, or a run of replacements whose forced path
is a name derived from `count.index`), module removal (`delete_because_no_module`), resources removed
without a `moved` block next to a create of the same type, `forget`, imports, drift that the plan reverts.

- Mass destroy and re-indexing count live objects only. Deposed leftovers (from an interrupted
  `create_before_destroy` replacement) are named apart ("plus 1 leftover deposed object"), are never a
  rename source or target, and their PLAN-03 escalation says they remove a leftover object.
- The rename advice writes the `moved` block in the module that holds both addresses: a module-level
  `moved { from = module.a to = module.b }` when a whole module call moves, full addresses for
  root ↔ module moves.
- A destroy plan (`terraform plan -destroy`) has no mode field, so it is inferred: plan format 1.0+,
  every live change is a delete (or forget) without `action_reason`, and at least one is still
  configured. It gets a banner, no `moved-but-destroyed`, no PLAN-03 escalation and no cause tracing.
- OpenTofu's `delete_because_enabled_false` is recognised (reason text, cause clause, and the trace
  follows the `enabled` argument).
- Scoring builds a per-plan index once (identities, value buckets, re-index groups, mass-destroy
  counts), so it is near-linear: a 10,000-change plan scores in well under a second.

## Lineage algorithm

The plan JSON has the configuration's expressions and references but **no locals and no file
positions** (verified). So the trace walks the JSON for structure and the HCL source for positions:

1. Attribute(s) to trace: replace → `replacePaths`; update → paths of the risk signals, else
   `changedPaths`; delete → the removed block / count / for_each; create → the resource block.
2. `s0`: the attribute's expression in the resource's config (nested blocks: `expressions[b][i][attr]`;
   set-ordered blocks: search all instances). Locate it in the module's `.tf` files.
3. Follow references outward, one step each, deduplicating:
   - `var.X` in a child module → the parent's module call argument `X` (`module_input`) → its references…
   - `var.X` at the root → `variable_default` (the `default =` line) and every `X =` in
     `terraform.tfvars`, `*.auto.tfvars` (`variable_value`); the plan's `variables[X].value` says which won.
     When the value matches no default and no auto-loaded file, the var files Terraform does not load
     by itself are searched (the `.tfvars`/`.tfvars.json` files the PR changes first, then those in the
     root dir); a match is a `variable_value` step "(loaded with -var-file)". Only a value no file holds
     is `external` (set outside the repo).
   - `local.Y` → the `locals { Y = … }` entry located by the HCL parser; references via `findReferences`.
   - `module.M.O` → the child's `output "O"` expression → continue inside the child.
   - `type.name[.attr]` → `upstream_resource` when that resource also changes in the plan (e.g. a
     subnet replaced → instance replaced); recurse into its lineage (depth-limited).
   - `each.key/each.value/count.index` → the resource's (or enclosing module call's) for_each/count.
   - `data.*`, functions of external state, remote modules (registry/git source) → `unresolved` with a
     note; for remote modules check whether the call's `version`/`?ref=` changed (`module_source`).
     A `source`/`version` line counts as changed only when the call or argument is new or its value
     differs from base (`terraform fmt` realignment does not count). `module_source` always means a
     remote module's source or version, the only kind that can raise `version-bump-replace`; a changed
     local `./`/`../` source (including a remote-to-local switch) is a `module_input` step, an ordinary
     code change of the call.
   - `file("…")`, `templatefile("${path.module}/…")`, `filebase64(…)` … with a literal path →
     `file_content`, located at the lines the PR changed in that file (a policy JSON, a user-data template).
4. `changedInDiff` = the PR adds a line inside the step's span, or removes one strictly inside it
   (the line just before a deletion is not changed); `DiffIndex.touches` uses the same rule.
   A variable, local or module output read by several traced attributes is traced once; later readers
   are linked through `LineageStep.alsoParentIds`, so `causePaths` draws one branch per attribute down
   to the shared root cause.
5. `rootCauseIds` = changed steps, most upstream first. If none changed: `upstream` when an upstream
   resource explains it; `external` when no PR code does (drift in `resource_drift`, provider/module
   version bump, tfvars not in the repo) — "this replacement is NOT caused by your diff" is itself a
   material insight; else `unknown`.
6. Deletes: removed code has no new-side lines. Locate the removed block in the diff's removed lines
   (old side) when the diff is available and point at the hunk; `count`/`for_each` deletes trace the
   collection expression instead. The base side also covers a deleted tfvars assignment (the default
   applies again), a deleted module-call argument (the child variable's default applies) and a nested
   block element removed from a set; values of sensitive variables are masked in these snippets. A
   resource or module call whose label alone changed is a rename without a `moved` block (the base
   label line and the new one). An OpenTofu `enabled = false` delete traces the `enabled` argument.
7. Set-ordered nested blocks: `align.ts` lines `before` up with `after` by identity. A block added in
   the middle of a set leaves `null` in `before` at its index, so `changedPaths` has one whole-element
   path (`["ingress", 0]`) instead of pairing the new block with an existing one; the tracer locates a
   whole-element path as the nested block itself, and the text says "is added (…)" / "is removed (…)".
8. Not traced to configuration: a deposed object (explanation `external`, a leftover-from-
   `create_before_destroy` note, `Lineage.deposed` set) and the deletes of a destroy plan. A plan JSON
   without a `configuration` section (`PlanModel.configurationMissing`, shown as a notice) is traced
   from the repository: deletes whose resource is still in the HCL are treated as configured, and
   module dirs fall back to the call's literal `source`.

## Agent

Messages API tool runner (`client.beta.messages.toolRunner`), as in ci-triage-agent: the GitHub token
stays on the runner, nothing persists server-side (`thread: false`). Default model `claude-opus-5-5`,
adaptive thinking, explicit `effort`, server-side refusal fallbacks (`fallbacks: "default"`), caps on
turns / USD / wall-clock / tool calls per turn, structured final output (`betaZodOutputFormat`).

Input: a compact digest — plan counts, every non-no-op change as one line (address, action, changed
attribute names, deterministic severity + rule ids), the top candidates with masked before→after for
the material attributes and their lineage chains. Tools (all read-only, all output masked + capped):
`list_changes`, `get_change`, `trace_cause`, `read_file`, `search_repo`, `get_diff`.

Verdict: `{ summary, findings[{ address, severity, title, impact, cause, cause_refs[{file,line}], confidence }], dismissed[{ address, reason }] }`.

## Merge policy (review.ts)

- Agent findings must name an address that changes in the plan and cause refs that exist in the repo;
  invalid ones are dropped (and counted in warnings). Cause refs are read from the scrubbed workspace
  the agent saw and must point into a Terraform source (`.tf`, `.tf.json`, `.tfvars`, `.tfvars.json`,
  `.hcl`, `.tofu`) or a file a traced `file()`/`templatefile()` step reads; `DENIED_FILES` and plan or
  state JSON are always refused, counted in a warning. Agent locations are head-side only (the verdict
  has no `side`). `Finding.agentCauseLinks` keeps the agent's own validated citations (absent on
  rules-only findings, `[]` when it cited none); `causeLinks` merges them with the lineage links.
- Deterministic `critical` findings are never silently dropped: if the agent dismisses one, it stays
  with the agent's reason shown and confidence lowered.
- Deterministic `high` findings the agent dismisses move to "other changes" with the reason.
- Agent-only findings are kept (recall).
- Rules that need the diff or the lineage run here: PLAN-03 `escalateForLineage`, PLAN-12 (a
  replacement whose only PR cause is a module/provider version line), PLAN-13 (`prevent_destroy`
  removed in the diff for a destroyed resource), and unexplained material updates.
- Findings whose explaining branches end at the same changed lines become one finding (the highest
  ranked stands for the rest, `relatedAddresses` + `relatedChanges` with each one's own action and
  severity): one tfvars line fanning out to N resources, a load balancer rename and every listener,
  rule, target group and DNS alias it takes along, every resource of a removed module call. A second
  critical exposure on an in-place change (another rule) stays its own finding. AI-written or
  confirmed findings fold under the same rule (same type and action class, same root-cause lines, or
  the same validated agent citations when nothing was traced), whatever their severity; the most
  severe stands for the group, and the cap applies after grouping. The report lists related changes
  by type and action; grading counts each related address as flagged.
- Several risk signals on different attributes of one update are traced together (one branch each),
  so every changed line behind them is shown.
- Without a PR diff nothing is called "not explained by this PR": the banner says the changed lines
  are unknown, once.
- Plan-wide signals (mass destroy) are a banner, not repeated in every finding.
- A finding no PR line explains (`external`) says so in its title and cause, with the likely source:
  drift, an injected variable, a version bump, taint / `-replace`, `replace_triggered_by`, a data
  source, or code removed before the PR.
- Cap at `max-findings` (default 7) by severity then score; the rest go to "other changes".
- Plan-level problems (errored, partial via `-target` or deferred changes, not applyable, a destroy
  plan, a plan JSON without its `configuration` section) become `notices`, shown as a banner above the
  findings. An errored plan gets only the errored banner (its `complete: false` comes from the error,
  not `-target`), and its summary never says the infrastructure matches the configuration.

## Output

PR comment (sticky per plan set, updated in place, newer runs win per key):

- The comment's key is a hidden `<!-- tf-change-reviewer:key=… scope=… plans=… -->` line after the
  run stamp: a hash of the `comment-key` input, or else of the normalized, deduped plan-json
  entries. Matrix jobs with different plans keep separate comments. An unkeyed comment from an older
  version is adopted on the first run. When a workflow job changes its plan-json (an entry added,
  removed or respelled), it takes over the comment it wrote before; a matrix sibling, another step
  reviewing other plans, or a comment with an explicit `comment-key` is never taken over.
- Headline: "N findings need your attention (K changes, of M in the plan)" + counts (+create ~update
  -destroy ±replace); data source reads are not counted in M, and "Other changes (N + K reads)"
  counts them apart the same way. As in Terraform's `Plan:` line, a forget+create also counts as a
  create and an import+update as a change. An errored or partial plan (`Review.planIncomplete`)
  never shows a green check or "matches the configuration".
- Per finding: severity, address, title, **Why it matters**, **Why it happens** as a chain
  (`storage_encrypted: true → false forces replacement` ← `modules/db/main.tf:24` ← `main.tf:12` changed in this PR)
  with permalinks at the head SHA, and `- [ ] Confirmed: needs attention` (feedback).
- Collapsed "Other changes" grouped by severity; noise summarized ("24 tag-only updates"). A deposed
  leftover shows its deposed key and never shares a line with the live object.
- Footer: "Missed something? Reply `missed: <address>`" (`missed: <root module dir>:<address>` when
  the comment covers several roots).
- Hidden `<!-- tf-change-reviewer:data {...} -->` with finding ids for metrics, plus `roots` (when
  the comment covers more than one) and `earlier` (findings a previous version showed and this run
  does not, with `confirmed`, at most 50), so a confirmed finding a later push fixed still counts.
- Checkbox keys are the finding id, qualified by a hash of the root module (`id:xxxxxxxx`) except at
  the repository root; ticks from older keys are migrated by the root the old marker recorded.
- Metrics read marker comments only from a bot or trusted author, pool the latest comment per key,
  and read `missed:` from conversation comments, review bodies and inline review comments by
  OWNER/MEMBER/COLLABORATOR only. In a multi-root comment an unqualified address that a flagged
  finding has is ambiguous and not counted.
- Run-level warnings (API-diff fallback, the 3000-file cap of the API file list, a checkout whose
  HEAD is not the PR head) are shown once and written to `report.json` as a top-level `warnings`
  array, not copied into every review. `report.json` is written under `RUNNER_TEMP`, never into the
  checkout.

## Evals

`evals/scenarios/<name>/{before,after,labels.json}` → `npm run gen-fixtures` → real AWS-provider plans
(mock credentials, `-refresh=false`, crafted state) in `evals/fixtures/`. `labels.json`:
`material[{ address, severity, why, cause[{file,line}] }]`, `acceptable[]` (borderline: no penalty) and
`set` (`dev`, or `holdout` for the blind test set: reported apart, never tuned on).
Metrics per run: precision = TP / (flagged − acceptable), recall = TP / material, trace accuracy =
TP whose cause links include a labeled cause line, cost, latency.
