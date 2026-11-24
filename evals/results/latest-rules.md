# Eval results: rules

Run 2026-11-24T12:20:41.131Z · mode **rules only** (deterministic rules + lineage, no LLM) · 21 fixtures × 1 repeat

| Metric | Value |
| --- | --- |
| Precision | 100% (28 TP, 0 FP) |
| Recall | 100% (28 of 28 material) |
| F1 | 100% |
| Trace accuracy | 100% (28/28 TP) |
| Cause-line recall | 81% (35/43 labeled lines) |
| Link precision | 97% (35/36) changed-line cause links hit a labeled cause |
| Agent citations | n/a |
| Severity agreement | 25/28 exact, 3 off by one, 0 further |
| Acceptable flagged | 29 |
| Perfect cases | 21/21 |
| Errors | 0 |
| Cost | $0.0000 total, $0.0000 per case |
| Latency | p50 0.0 s, max 0.0 s |

## By set

| Set | Cases | Precision | Recall | F1 | Trace accuracy | Cause-line recall | TP/FP/FN |
| --- | --- | --- | --- | --- | --- | --- | --- |
| dev | 13 | 100% | 100% | 100% | 100% (19/19) | 96% (25/26) | 19/0/0 |
| holdout (blind) | 8 | 100% | 100% | 100% | 100% (9/9) | 59% (10/17) | 9/0/0 |
| combined | 21 | 100% | 100% | 100% | 100% (28/28) | 81% (35/43) | 28/0/0 |

## Cases

| Fixture | Plan lines | Changes | TP/FP/FN | Traced | Cost | Seconds | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| db-encryption-replace | 336 | 25 | 1/0/0 | 1/1 | $0.0000 | 0.0 |  |
| ecs-desired-zero | 483 | 39 | 1/0/0 | 1/1 | $0.0000 | 0.0 |  |
| ho-auto-tfvars-override | 507 | 17 | 1/0/0 | 1/1 | $0.0000 | 0.0 |  |
| ho-file-policy-json | 348 | 25 | 1/0/0 | 1/1 | $0.0000 | 0.0 |  |
| ho-foreach-key-rename | 671 | 26 | 2/0/0 | 2/2 | $0.0000 | 0.0 |  |
| ho-oidc-trust-wide | 483 | 18 | 1/0/0 | 1/1 | $0.0000 | 0.0 |  |
| ho-public-bucket | 428 | 29 | 2/0/0 | 2/2 | $0.0000 | 0.0 |  |
| ho-rds-identifier-rename | 488 | 31 | 1/0/0 | 1/1 | $0.0000 | 0.0 |  |
| ho-secret-force-delete | 358 | 22 | 1/0/0 | 1/1 | $0.0000 | 0.0 |  |
| ho-sg-https-only | 377 | 24 | 0/0/0 | - | $0.0000 | 0.0 |  |
| iam-wildcard | 581 | 32 | 1/0/0 | 1/1 | $0.0000 | 0.0 |  |
| injected-var-external | 311 | 33 | 1/0/0 | 1/1 | $0.0000 | 0.0 |  |
| kms-key-removed | 319 | 20 | 1/0/0 | 1/1 | $0.0000 | 0.0 |  |
| lb-rename-replace | 559 | 28 | 1/0/0 | 1/1 | $0.0000 | 0.0 |  |
| module-removed | 363 | 28 | 2/0/0 | 2/2 | $0.0000 | 0.0 |  |
| noise-only | 655 | 49 | 0/0/0 | - | $0.0000 | 0.0 |  |
| rds-protection-off | 620 | 47 | 1/0/0 | 1/1 | $0.0000 | 0.0 |  |
| renamed-without-moved | 675 | 41 | 1/0/0 | 1/1 | $0.0000 | 0.0 |  |
| s3-count-reindex | 683 | 39 | 5/0/0 | 5/5 | $0.0000 | 0.0 |  |
| sg-open-world | 346 | 22 | 1/0/0 | 1/1 | $0.0000 | 0.0 |  |
| subnet-cascade | 744 | 43 | 3/0/0 | 3/3 | $0.0000 | 0.0 |  |
