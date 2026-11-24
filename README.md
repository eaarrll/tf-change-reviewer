# tf-change-reviewer

**Which change in this 400-line Terraform plan needs my attention, and which line of my PR caused it?**

A GitHub Action and CLI that reads `terraform show -json` output and the PR diff, picks the few changes a
reviewer must stop on (data loss, outage, security exposure, a destroy the PR did not mean), and traces
each one back through resource attributes, module inputs, variables, locals, `.tfvars` and upstream
resources to the line of the PR that causes it. When no line of the PR explains a change, it says so
and names the likely source (drift, an injected variable, a version bump, taint).

It works without an API key (deterministic rules + lineage). With one, a Claude agent with read-only
tools confirms, demotes, adds and explains findings; the rules stay as the floor.

![node24](https://img.shields.io/badge/runtime-node24-339933)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

## What the comment looks like

One sticky comment per PR and plan set, updated in place on every push ([full sample](docs/sample-comment.md), real
output for the `subnet-cascade` fixture):

> **1 finding needs your attention** (3 changes, of 43 in the plan)
>
> #### 🔴 Critical · `module.vpc.aws_subnet.private["eu-west-1a"]`
>
> **Subnet prod-payments-private-eu-west-1a will be destroyed and re-created (and 2 related changes)**
>
> **Why it happens:** cidr_block "10.40.10.0/24" → "10.40.16.0/20" forces replacement; it comes from
> aws_subnet.private for_each (modules/vpc/main.tf:49), from module "vpc" argument private_subnets
> (main.tf:6), from private_subnets in terraform.tfvars (terraform.tfvars:11, changed in this PR).
>
> **Cause chain:** `cidr_block` ← `modules/vpc/main.tf:52` ← `modules/vpc/main.tf:49` ← `main.tf:6` ←
> **`terraform.tfvars:11`** ✏️
>
> **Same cause, also changes (2):** `aws_instance` ±replace ×2: `aws_instance.ledger["ledger-a1"]`,
> `aws_instance.ledger["ledger-a2"]`

Each finding has: severity, title, why it matters, why it happens (the lineage as a sentence, and as a
chain of permalinks at the head commit, base commit for deleted code, drawn only along the branches
that reach a changed line), a collapsed step-by-step trace, and a **Confirmed** checkbox. Changes with
one root cause are one finding that lists the rest with their own action: four buckets re-indexed by
one tfvars line, a load balancer rename with every listener, rule, target group and DNS alias it takes
along, every resource of a removed module. Everything else is in a collapsed "Other changes" list,
identical lines merged ("9 × `module.service[*].aws_cloudwatch_log_group.this` · retention_in_days
30 → 14") and noise summarized ("30 tag-only updates").

## Quick start

> Not released yet: `eaarrll/tf-change-reviewer@v0` resolves once the `v0` tag is pushed. Until then,
> pin a commit SHA of this repository, or run the CLI from a checkout (below).

```yaml
# .github/workflows/terraform-review.yml
on:
  pull_request:
    paths: ["infra/**"]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: tf-review-${{ github.event.pull_request.number }}

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    defaults:
      run:
        working-directory: infra
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }} # the PR head, not the merge commit
          fetch-depth: 0 # so `git diff base...head` works
      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_wrapper: false # the wrapper's log lines break the JSON
      # … cloud credentials …
      - run: terraform init -input=false
      - run: terraform plan -input=false -lock=false -out=plan.out
      - run: terraform show -json plan.out > plan.json
      - uses: eaarrll/tf-change-reviewer@v0
        with:
          plan-json: infra/plan.json
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }} # optional
```

Full example: [`examples/review.yml`](examples/review.yml). Several root modules: one line per plan,
globs allowed (`envs/*/plan.json`), and `path/to/plan.json=root/module/dir` when the plan file does not
sit in its root module's directory (an absolute path, under the checkout or `RUNNER_TEMP`, always needs
the `=root/module/dir`). A plan inside the checkout is safe: a plan or state JSON is never shown to the
AI review, whatever its name.

Each distinct `plan-json` keeps its own sticky comment, so matrix jobs (one per environment) do not
overwrite each other. If the same job later changes its `plan-json` (an entry added, removed or
respelled), it takes over the comment it wrote before; set `comment-key` to separate two steps that
review the same plans. A comment from an older version is adopted on the first run.

The diff comes from `git diff base...head`. In a shallow checkout the action fetches both commits and
falls back to a two-dot diff, then to the PR's file patches from the API (each fallback is a warning in
the comment, as are a file list cut at GitHub's 3000-file cap and a checkout whose HEAD is not the PR
head commit, e.g. the merge ref).

### Fork pull requests

A `pull_request` run from a fork has a read-only token and no secrets, so the action skips the comment
(the review is still in the job summary). To comment on fork PRs, plan in the PR workflow
([`examples/plan-for-fork-review.yml`](examples/plan-for-fork-review.yml)), upload `plan.json` and
the PR number as an artifact, and review from a `workflow_run` workflow that downloads it, checks out
the PR head as text only, and passes `pr-number`
([`examples/review-fork-prs.yml`](examples/review-fork-prs.yml)). The action never executes PR code;
it reads `.tf`, `.tfvars` and the files they reference.

Download the artifact under `RUNNER_TEMP` and point at it there
(`plan-json: ${{ runner.temp }}/plan/infra/plan.json=infra`); never write into the PR checkout in the
`workflow_run` job, since a symlink the fork commits can redirect the write (onto the action's own
`dist/index.js`, for example). The action refuses symlinked plan files and plan paths that resolve
outside the checkout and `RUNNER_TEMP`.

The artifact comes from the fork's own run, so the PR number in it is not trusted: under
`workflow_run` the action comments only when that PR's head commit is the run's `head_sha`, from the
same head repository. Otherwise (a fork naming someone else's PR, or a PR pushed to since) it leaves
the comment alone with a warning; the review stays in the job summary.

## Inputs

| Input                | Default               | Meaning                                                                                                        |
| -------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `plan-json`          | (required)            | Plan files, one per line: `path/plan.json` or `path/plan.json=root/module/dir`; globs allowed                  |
| `github-token`       | `${{ github.token }}` | Reads the PR, posts the comment (`contents: read`, `pull-requests: write`)                                     |
| `anthropic-api-key`  | empty                 | Enables the AI review; empty = rules only (logged)                                                             |
| `model`              | `claude-opus-5-5`     | Model for the AI review                                                                                        |
| `effort`             | `high`                | `low` · `medium` · `high` · `xhigh` · `max`                                                                    |
| `max-findings`       | `7`                   | Findings under "Needs your attention" per root module                                                          |
| `max-cost-usd`       | `1.00`                | AI budget for the whole run, shared by all plans                                                               |
| `timeout-minutes`    | `5`                   | AI time budget for the whole run                                                                               |
| `fail-on`            | `none`                | Fail the step on a finding at least this severe: `critical` · `high` · `medium`; an errored plan also fails it |
| `comment`            | `true`                | Post / update the sticky PR comment                                                                            |
| `comment-key`        | empty                 | Which sticky comment this step owns (default: one per distinct `plan-json`)                                    |
| `extra-instructions` | empty                 | Repository context for the AI review (which env is production, what is disposable)                             |
| `pr-number`          | the event's PR        | PR to review and comment on (`workflow_run` pattern)                                                           |

## Outputs

| Output           | Meaning                                                    |
| ---------------- | ---------------------------------------------------------- |
| `findings-count` | Findings under "Needs your attention", over all plans      |
| `max-severity`   | `critical`, `high`, `medium`, or `none`                    |
| `report-json`    | Path of the full review as JSON (under `RUNNER_TEMP`)      |
| `comment-url`    | The comment posted or updated; empty when none was written |

Unreadable input fails the step with a fix-it message: a binary plan (`terraform plan -out` without
`terraform show -json`), setup-terraform wrapper output (`terraform_wrapper: false`), a state file, a
human-readable plan, a plan `format_version` other than 0.x/1.x. A UTF-16 plan file (Windows PowerShell
5.1 `>`) is decoded. Everything else fails open: an AI error leaves the rules-only review, a comment
that cannot be posted leaves the job summary. Run-level warnings are the report's top-level `warnings`.

## CLI

The package is not on npm. From a checkout (`npm ci` first for `tsx`), or straight from GitHub:

```sh
node dist/cli.js review --plan plan.json --repo . --base origin/main      # built CLI, no install
npx tsx src/cli.ts review --plan plan.json --repo . --diff pr.diff        # from source
terraform show -json plan.out | node dist/cli.js review --plan - --diff pr.diff --format json
node dist/cli.js metrics --repo owner/name --since 2026-10-01             # needs GITHUB_TOKEN
npx github:eaarrll/tf-change-reviewer review --plan plan.json --repo .    # once the repo is public
```

`--format text|markdown|json`, `--rules-only`, `--model`, `--effort`, `--max-findings`, `--root-dir`
(default: the plan file's directory), `--fail-on` (exit code 3 when a finding meets it, or when the plan
errored; a `-target` plan does not). The AI review runs when `ANTHROPIC_API_KEY` is set.

## How lineage works

The plan JSON has each attribute's expression and references but no locals and no file positions, so
the tracer walks the plan for structure and a tolerant HCL parser for positions:

1. Start at the attribute that matters: the path that forces replacement, the attribute a risk rule is
   about, or the whole block for creates and deletes.
2. Follow references outward one step at a time: `var.x` in a child module → the module call's
   argument in the parent; `var.x` at the root → its default and every `.tfvars` / `*.auto.tfvars`
   assignment (the plan's value says which one won), then var files loaded with `-var-file` (the
   `.tfvars` files the PR changes first); only a value no file holds came from `-var` or CI;
   `local.y`, module outputs, `count` / `for_each` / `each.key`, upstream resources that are themselves
   replaced (a subnet → the instances in it), `file()` / `templatefile()` of a changed file, data
   sources, remote modules (`.terraform/modules/modules.json`), `replace_triggered_by`.
3. Mark each step the PR diff changes. The changed steps furthest upstream are the root causes.
   Deleted code is found on the base side of the diff (a removed resource or module call, a resource
   or module rename without a `moved` block, a deleted tfvars assignment or module argument whose
   default now applies, a nested block removed from a set; sensitive values masked). A module's
   `source`/`version` line counts only when its value changed, not when `terraform fmt` realigned it.
   Steps form a tree (a local built from two variables, a `for_each` next to the value it iterates);
   the comment draws only the branches that reach a changed line, and a change with several risky
   attributes gets one branch each, also when they share a variable or local.
4. Nothing changed on the path: the explanation is `upstream` (another replaced resource), `external`
   ("not caused by this PR": drift, a value injected outside the repo, a provider/module version bump,
   taint or `-replace`, a leftover deposed object, a destroy plan), or `unknown`.

## What is masked before anything reaches the model

`terraform show -json` prints sensitive values in clear text. Before the plan is used at all, every
value in the strict union of sensitive places is replaced with `(sensitive)`: `*_sensitive` marks on
changes and drift, sensitive outputs, sensitive root variables (value and default), module-call
constants that feed a sensitive child variable, and credential-named provider arguments. Because
Terraform leaves derived copies unmarked, every such value is also removed wherever else it appears in
the plan, and from all text that leaves the process: source files and the diff the agent reads,
lineage snippets, model output and the comment. Credential-named assignments in `.tf`/`.tfvars` files
and secret formats (cloud keys, tokens, PEM blocks) are masked too. Values are matched in their
escaped forms as well (HCL-quoted, template `$${`/`%%{` escapes, JSON and Go's HTML-safe escapes), and
a multi-line secret line by line (indented heredocs, partial diff hunks) without hiding the ordinary
lines it shares with other scripts. The agent's tools refuse state files, saved plans, `.env`, keys
and CLI credentials by name (`get_diff` lists such a file but hides its lines) and any plan or state
JSON by content. The agent's tools are read-only; the
API key is masked in logs; plan values are never logged. A canary test plants a distinct value in each
of those places and checks that none reaches the digest, any tool output, the review or the comment.

## Measuring precision and recall

**Offline.** `npm run eval -- --rules-only` reviews 21 labeled fixtures made from real AWS-provider plans
(Terraform 1.10.5, mock credentials, crafted state) and grades the "Needs your attention" list against
hand-written labels: precision, recall, F1, trace accuracy (does a link to a changed line hit a labeled
cause line?) and cause-line recall (how many of the labeled cause lines the findings link).
The 8 `ho-*` fixtures are a blind holdout set written separately from the rules; reports show only
their counts. Method and label format: [`evals/README.md`](evals/README.md).

| Configuration            | Set      | Precision | Recall | F1   | Trace accuracy | Cause-line recall | Cost / review | p50 latency |
| ------------------------ | -------- | --------- | ------ | ---- | -------------- | ----------------- | ------------- | ----------- |
| rules only (no AI)       | dev (13) | 100%      | 100%   | 100% | 100% (19/19)   | 96% (25/26)       | $0            | < 0.1 s     |
| rules only (no AI)       | holdout¹ | 100%      | 100%   | 100% | 100% (9/9)     | 59% (10/17)       | $0            | < 0.1 s     |
| rules + claude-opus-5-5  | dev (13) | 95%²      | 100%   | 97%  | 100% (19/19)   | 100% (26/26)      | $0.087        | 17 s        |
| rules + claude-opus-5-5  | holdout¹ | 100%      | 100%   | 100% | 100% (9/9)     | 71% (12/17)       | $0.065        | 17 s        |
| rules + claude-haiku-5-5 | dev (13) | 100%      | 100%   | 100% | 100% (19/19)   | 100% (26/26)      | $0.005        | 26 s        |
| rules + claude-haiku-5-5 | holdout¹ | 100%      | 100%   | 100% | 100% (9/9)     | 71% (12/17)       | $0.004        | 25 s        |

One run each (effort high), 2026-11-24. ¹ The 8 holdout scenarios were written blind to the rules and
never used to tune them. One holdout answer key was corrected before the final run by a label audit that
saw no tool output (a 30 → 14 day version-retention cut moved from noise to acceptable, as in the dev
keys); under the original key, rules-only holdout precision was 90%. ² The one false positive is a
queue-age alarm whose threshold went 300 → 900, which the key calls noise.

The AI pass changes little about _which_ changes are flagged (the rules already catch every material
change here); what it adds is cause lines the deterministic tracer misses (holdout 59% → 71%) and a
written explanation. Haiku matched Opus on detection and cause lines at about 1/18 of the cost; this set is
too small to separate them.

The dev set is what the rules were developed against, so its numbers are an upper bound; the holdout
row is the honest one. Neither covers drift: the fixture method cannot produce it.

**Live.** Reviewers tick **Confirmed** on findings that needed attention and reply `missed: <address>`
(in a PR comment or review; `missed: envs/staging:aws_db_instance.main` when the comment covers several
root modules) for changes the bot should have flagged. Only replies by repository owners, members and
collaborators count; a confirmed finding a later push fixed stays counted. `tf-change-reviewer metrics --repo owner/name` reads those
comments back and reports precision (confirmed / flagged, a lower bound: an unticked box is "not
confirmed", not "wrong") and recall (confirmed / (confirmed + missed)), by severity and by origin
(rules, AI, both).

## Limits

- Lineage reads `.tf` and `.tfvars`; `.tf.json` and OpenTofu `.tofu` files are not searched (noted in
  the trace when present).
- Remote modules are traced only when `.terraform/modules/modules.json` is in the checkout (run
  `terraform init` in the same job); otherwise the trace stops at the module call and its `version`.
- The checkout must be the commit the plan was made from (the PR head). Partial plans (`-target`,
  deferred changes), errored plans, destroy plans and plan JSON without its `configuration` section
  get a banner; resources outside a partial plan are not reviewed, and an errored or partial plan
  never reads as "matches the configuration".
- Hidden values cannot be compared: lineage through a sensitive variable shows the path, not the value.
- Force-new and risk tables cover the common AWS, Azure and Google resources; other providers rely on
  the plan's `replace_paths` and generic rules.
- At most 60 changes are traced per plan (highest risk first); comments are capped at 60,000
  characters (the job summary and `report-json` have everything).

## Cost

Rules only: free; well under a second for typical plans (a synthetic 5,000-change plan takes about half a second). With the AI review, `max-cost-usd` (default $1.00 for the
whole run) and `timeout-minutes` are hard caps; the footer and the job summary show the actual tokens and
cost of each run. Model-mode eval numbers go in `evals/results/latest-<model>.md` once run
(`npm run eval -- --model claude-opus-5-5 --budget-usd 5`).

## Development

```sh
npm ci
npm run all            # typecheck, lint, test, build (dist/ is committed)
npm run format:check
npm run eval -- --rules-only
npm run gen-fixtures   # regenerate eval fixtures (needs terraform; offline after the first run)
```

Design notes: [`DESIGN.md`](DESIGN.md). License: MIT.
