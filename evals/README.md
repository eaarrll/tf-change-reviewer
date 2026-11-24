# Evals

An offline harness that measures the question the tool exists to answer: _which change in this plan
needs my attention, and which line of my PR caused it?_ Every fixture is a real Terraform plan for a
pull request, with a hand-written answer key. The harness runs `reviewPlan` exactly as the CLI and the
Action do, grades the "Needs your attention" list against the key, and reports precision, recall, trace
accuracy, cost and latency.

## How fixtures are made

A scenario is a small repository before and after a pull request:

```
evals/scenarios/<name>/
  before/        the repo at the PR's base
  after/         the repo at the PR's head
  labels.json    the answer key (below)
  scenario.json  optional: { "afterVars": { "x": "y" } }, -var values given only to the after plan
```

`npm run gen-fixtures [-- <name> ...]` (needs `terraform` on PATH) turns each scenario into
`evals/fixtures/<name>/{plan.json, plan.txt, pr.diff, labels.json, repo/}`:

1. Both trees are copied to `evals/.work/<name>/` with a provider override holding mock credentials and
   every `skip_*` flag, so no cloud API is ever called.
2. `before` is planned with `-refresh=false` (all creates), and that plan is turned into a state file:
   every unknown computed value gets a typed placeholder from the provider schema, and sensitive marks
   become `sensitive_attributes`. This is the crafted state "as if the base had been applied".
3. `after` is planned against that state. The result is the **real provider's** diff logic:
   `replace_paths`, `action_reason`, `before_sensitive`/`after_sensitive`, defaults the provider fills,
   tags merged from `default_tags`, and the exact `terraform show -json` format of the pinned
   Terraform version.
4. `pr.diff` is `git diff --no-index` of the two trees with repo-relative paths, and `repo/` is the
   `after` tree (what the workspace reads at the PR's head).

**Blind spot of this method:** the crafted state is exactly what the `before` configuration would
produce, and both plans run with `-refresh=false`, so nothing ever changes outside Terraform. Drift
(`resource_drift`, a plan that reverts a console edit) therefore never occurs in these fixtures, and
the "not caused by this PR: drift" path is covered only by unit tests, not by the eval numbers. The
same holds for anything that needs a live provider: tainted objects, `-replace`, data sources that
return new values, and provider upgrades between the two plans.

Why not hand-written plan JSON: what forces a replacement, which values are marked sensitive and where
the plan puts them are exactly what the tool must get right, and a hand-written plan encodes the
author's assumptions instead of the provider's behaviour. Providers are cached in `.tf-plugin-cache/`
so regeneration is offline after the first download. The generator also validates the labels (below)
and fails if any address is not a change in the plan or any cause line is not part of the diff.

## Labels

```json
{
  "description": "What the PR does, in a sentence.",
  "material": [
    {
      "address": "module.orders_db.aws_db_instance.this",
      "severity": "critical",
      "why": "storage_encrypted true -> false forces replacement of the production database.",
      "cause": [{ "file": "main.tf", "line": 12 }],
      "explanation": "external"
    }
  ],
  "acceptable": ["module.platform.aws_cloudwatch_log_group.service[\"api\"]"]
}
```

- **material**: a change a careful reviewer must look at before approving: data loss or outage risk,
  security exposure, a replacement or destroy of something stateful, a change the PR did not intend.
  The tool should flag it. One entry per resource instance address, written exactly as the plan
  prints it (module path and instance key included).
- **acceptable**: borderline changes a reasonable reviewer might or might not want flagged (a security
  group rule widened inside a VPC, a retention cut). Flagging one is neither credit nor penalty.
  Everything else in the plan is ordinary or noise, and flagging it is a false positive.
- **severity**: the severity a reviewer would give (`critical`, `high`, `medium`). Graded only as a
  secondary statistic.
- **cause**: the lines that make the change happen, in the PR's terms: the changed line a reviewer
  would want to be pointed at. List every line that independently explains it (e.g. the module
  argument that now reads a variable _and_ the variable's new default); hitting any one counts. Lines
  are 1-based in the head version of `repo/`. A line the PR **deleted** (a removed resource, a removed
  `moved` block) has no head-side number, so it is given as `"side": "base"` with its line number in
  the base file. Cause lines must be lines the diff adds (head) or removes (base); the generator checks.
- **set**: `"dev"` or `"holdout"`; optional, because the fixture's name decides: holdout fixtures
  are named `ho-*`, everything else is dev, and a `set` that disagrees with the name fails the load.
  Holdout fixtures are a blind test set written separately from the rules: `--set dev` never reads
  them, results are reported per set, and the report shows only counts for holdout cases (their
  addresses, error text, warnings and load problems are hidden unless `--show-holdout`), so nobody
  tunes the rules to them by reading the misses.
- **explanation**: set when the answer is not a line of the diff. `"external"` means nothing in the PR
  explains the change (drift, a provider or module version bump, a value injected with `-var` in CI):
  telling the reviewer "this is not caused by your diff" is itself the insight. `"upstream"` means
  another resource's change explains it. Use `cause: []` with an explanation, or both when either
  answer is acceptable.

## Metrics

Per fixture, with _flagged_ = the distinct addresses in `review.findings` (the "Needs your attention"
list; "other changes" never count):

| Metric             | Definition                                                                              |
| ------------------ | --------------------------------------------------------------------------------------- |
| TP                 | flagged ∩ material (exact address match)                                                |
| FP                 | flagged − material − acceptable                                                         |
| FN                 | material − flagged (the report says when a miss was still listed under "other changes") |
| Precision          | TP / (TP + FP); n/a when nothing non-acceptable was flagged                             |
| Recall             | TP / (TP + FN); n/a when the fixture has no material changes                            |
| F1                 | harmonic mean; 0 when either side is 0                                                  |
| Trace accuracy     | traced TP / judged TP (below)                                                           |
| Cause-line recall  | labeled cause lines covered by a changed-line cause link / labeled cause lines (TP)     |
| Link precision     | changed-line cause links that hit a labeled cause line / changed-line cause links (TP)  |
| Agent citations    | the agent's own cause links, graded like trace accuracy and link precision (below)      |
| Severity agreement | over TP with a labeled severity: exact, off by one step, further                        |

A finding can stand for several changes with one root cause (`relatedAddresses`: four buckets
replaced because one tfvars list changed). Each related address counts as flagged, with the
representative finding's trace.

A TP is **traced** when either:

- one of the finding's `causeLinks` **to a line the PR changed** points at a labeled cause line: same
  file (normalized), same side (head unless `base`), and the line inside the link's
  `[startLine, endLine]` (a link to the resource's own unchanged attribute does not count); or
- the label has an `explanation` and the finding's `lineage.explanation` equals it. Every finding the
  review shows, the agent's included, carries the deterministic lineage. Only a finding without one
  (a rule finding past the tracing limit) falls back to its text: for an `"external"` label it is
  traced when none of its cause links is a changed line and its `cause` text says so
  (`not caused by this PR`, `outside the repo`, `drift`, …).

Trace accuracy needs only one labeled line per finding. **Cause-line recall** asks for all of them:
a finding with three labeled cause lines (three safety nets turned off by three `.tfvars` lines) that
links only one scores 1/3. Each link covers at most one labeled line (links and lines are matched one
to one), so a single link spanning a whole deleted block does not count as every labeled line inside
it. **Link precision** is the other side: of the finding's changed-line cause links, how many hit a
labeled cause line. On an `"external"` label every changed-line link is wrong (nothing in the PR
explains the change); labels with neither cause lines nor an `"external"` explanation are not judged.
None of these metrics checks the before → after values the text shows; the unit tests pin those for
the dev fixtures (`test/review.test.ts`, "finding text on the dev fixtures").

**Agent citations** grade what the agent itself cited (`Finding.agentCauseLinks`, set on findings
with origin `agent` or `both`). The comment merges the agent's links with the rule lineage's, so trace
accuracy and cause-line recall in model mode can never fall below the rules-only numbers and cannot
tell a right citation from a wrong one. Here a TP is traced when one of the agent's changed-line
links hits a labeled cause line, or, on an `"external"` label, when the agent cites no changed line
at all; the agent's link precision counts its changed-line links that hit no labeled line. Rules-only
runs report n/a.

A label with neither cause lines nor an explanation is not judged for tracing. A finding repeated for
the same address counts once (the first, highest-ranked one) and is listed as a duplicate. A case
whose review crashed is graded as having flagged nothing, and never counts as a perfect case (on a
fixture with no material change it would otherwise have no FP and no FN); the report gives the number
of crashed cases next to precision.

The run's precision, recall and F1 are micro-averaged (TP/FP/FN summed over every fixture and repeat),
so a fixture with many material changes weighs more than a quiet one. Cost is what `reviewPlan` reports
for the agent (`review.agent.costUsd`, 0 in rules-only mode); latency is the wall-clock time of each
`reviewPlan` call. The implementation is `evals/grade.ts`.

## Running

From the repository root:

```sh
# Baseline: deterministic rules + lineage, no LLM, no API key, no cost.
npm run eval -- --rules-only

# Rules + agent (needs ANTHROPIC_API_KEY).
export ANTHROPIC_API_KEY=...
npm run eval -- --model claude-opus-5-5 --effort high

# A subset, repeats to see variance, and a hard stop on spend.
npm run eval -- --fixtures db-encryption-replace --repeat 3 --budget-usd 2
```

| Flag                 | Default           | Meaning                                      |
| -------------------- | ----------------- | -------------------------------------------- |
| `--model <id>`       | `claude-opus-5-5` | Model the agent uses                         |
| `--rules-only`       | off               | No agent: `reviewPlan` with `agent: null`    |
| `--fixtures <names>` | all               | Comma-separated fixture names (repeatable)   |
| `--set <set>`        | `all`             | `dev`, `holdout` or `all`                    |
| `--show-holdout`     | off               | Name FP/FN addresses of holdout fixtures     |
| `--effort <level>`   | `high`            | `low`, `medium`, `high`, `xhigh` or `max`    |
| `--max-cost <usd>`   | `0.5`             | Agent budget per review                      |
| `--budget-usd <usd>` | none              | Stop the run once its total cost passes this |
| `--repeat <n>`       | `1`               | Reviews per fixture                          |
| `--out <dir>`        | `evals/results`   | Output directory                             |

Every review gets `maxFindings: 7`, 12 agent turns and a 5-minute timeout. Reviews run one at a time
so the running total is exact. Output:

- a progress line per review and a final table: fixture, plan lines, changes, TP/FP/FN, traced, cost,
  seconds, and notes naming each FP, FN and untraced TP (counts only for holdout fixtures);
- summary lines for the dev set, the holdout set and both combined;
- `evals/results/<model-or-rules>-<timestamp>.json`: header, summary and every case (git-ignored);
- `evals/results/latest-<model-or-rules>.md`: the markdown summary, meant to be committed.

The process exits 1 only for harness problems: bad flags, a missing API key in model mode, a fixture
that fails to load, an unwritable output directory. Low scores and crashing reviews are results: a
review that throws is graded as having flagged nothing and shown as an error.

## Cost

`--rules-only` costs nothing. In model mode each review is capped by `--max-cost`; the agent checks
its budget after each response, so a review can end a request above the cap. The ceiling for a run is
about `fixtures × repeat × max-cost`; `--budget-usd` stops the run once the running total passes it
(the review in flight finishes, the rest are reported as skipped). Check the committed
`latest-*.md` files for measured cost per review before a large sweep.

## Results

<!-- RESULTS -->

| Configuration            | Set             | Precision   | Recall | F1   | Trace accuracy | Cause-line recall | Agent citations | Cost / review | p50 latency |
| ------------------------ | --------------- | ----------- | ------ | ---- | -------------- | ----------------- | --------------- | ------------- | ----------- |
| rules only               | dev             | 100%        | 100%   | 100% | 100% (19/19)   | 96% (25/26)       | n/a             | $0            | < 0.1 s     |
| rules only               | holdout (blind) | 100% (90%¹) | 100%   | 100% | 100% (9/9)     | 59% (10/17)       | n/a             | $0            | < 0.1 s     |
| model `claude-opus-5-5`  | dev             | 95% (1 FP²) | 100%   | 97%  | 100% (19/19)   | 100% (26/26)      | 84% (16/19)     | $0.087        | 17.3 s      |
| model `claude-opus-5-5`  | holdout (blind) | 100%        | 100%   | 100% | 100% (9/9)     | 71% (12/17)       | 89% (8/9)       | $0.065        | 17.1 s      |
| model `claude-haiku-5-5` | dev             | 100%        | 100%   | 100% | 100% (19/19)   | 100% (26/26)      | 84% (16/19)     | $0.005        | 25.7 s      |
| model `claude-haiku-5-5` | holdout (blind) | 100%        | 100%   | 100% | 100% (9/9)     | 71% (12/17)       | 89% (8/9)       | $0.004        | 25.3 s      |

One repeat each, effort high, 2026-11-24 (total spend for both model runs: $1.75). ¹ Before the
holdout label audit: an auditor and an independent checker, neither of whom saw any tool output,
compared the 8 holdout keys with the label definitions above and moved one change (an S3 noncurrent-
version expiry cut 30 → 14 days) from noise to acceptable, the same convention the dev keys follow. ²
`rds-protection-off`: a queue-age alarm threshold raised 300 → 900, which the key calls noise.

Severity agreement (secondary): rules 25/28 exact, both models 23/28 exact, none more than one level
off. The deterministic lineage is merged into every finding, so trace accuracy and cause-line recall
are the same floor in both modes; "agent citations" grades only the lines the model cited itself.

The dev set is what the rules were developed against; the holdout row is the unbiased estimate.
Details: [`results/latest-rules.md`](results/latest-rules.md),
[`results/latest-claude-opus-5-5.md`](results/latest-claude-opus-5-5.md),
[`results/latest-claude-haiku-5-5.md`](results/latest-claude-haiku-5-5.md).
