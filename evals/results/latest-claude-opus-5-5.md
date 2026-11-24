# Eval results: claude-opus-5-5

Run 2026-11-24T12:20:50.634Z · model `claude-opus-5-5` · effort `high` · agent budget $0.50 per review · 21 fixtures × 1 repeat

| Metric | Value |
| --- | --- |
| Precision | 97% (28 TP, 1 FP) |
| Recall | 100% (28 of 28 material) |
| F1 | 98% |
| Trace accuracy | 100% (28/28 TP) |
| Cause-line recall | 88% (38/43 labeled lines) |
| Link precision | 91% (41/45) changed-line cause links hit a labeled cause |
| Agent citations | 86% traced (24/28 TP), links 89% (31/35) |
| Severity agreement | 23/28 exact, 5 off by one, 0 further |
| Acceptable flagged | 55 |
| Perfect cases | 20/21 |
| Errors | 0 |
| Cost | $1.6557 total, $0.0788 per case |
| Latency | p50 17.3 s, max 37.9 s |

## By set

| Set | Cases | Precision | Recall | F1 | Trace accuracy | Cause-line recall | TP/FP/FN |
| --- | --- | --- | --- | --- | --- | --- | --- |
| dev | 13 | 95% | 100% | 97% | 100% (19/19) | 100% (26/26) | 19/1/0 |
| holdout (blind) | 8 | 100% | 100% | 100% | 100% (9/9) | 71% (12/17) | 9/0/0 |
| combined | 21 | 97% | 100% | 98% | 100% (28/28) | 88% (38/43) | 28/1/0 |

## Cases

| Fixture | Plan lines | Changes | TP/FP/FN | Traced | Cost | Seconds | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| db-encryption-replace | 336 | 25 | 1/0/0 | 1/1 | $0.0882 | 15.3 |  |
| ecs-desired-zero | 483 | 39 | 1/0/0 | 1/1 | $0.1031 | 24.2 |  |
| ho-auto-tfvars-override | 507 | 17 | 1/0/0 | 1/1 | $0.0455 | 13.8 |  |
| ho-file-policy-json | 348 | 25 | 1/0/0 | 1/1 | $0.0375 | 11.0 |  |
| ho-foreach-key-rename | 671 | 26 | 2/0/0 | 2/2 | $0.0881 | 21.8 |  |
| ho-oidc-trust-wide | 483 | 18 | 1/0/0 | 1/1 | $0.0859 | 18.9 |  |
| ho-public-bucket | 428 | 29 | 2/0/0 | 2/2 | $0.0687 | 17.1 |  |
| ho-rds-identifier-rename | 488 | 31 | 1/0/0 | 1/1 | $0.0814 | 22.7 |  |
| ho-secret-force-delete | 358 | 22 | 1/0/0 | 1/1 | $0.0665 | 21.5 |  |
| ho-sg-https-only | 377 | 24 | 0/0/0 | - | $0.0489 | 16.4 |  |
| iam-wildcard | 581 | 32 | 1/0/0 | 1/1 | $0.0377 | 14.6 |  |
| injected-var-external | 311 | 33 | 1/0/0 | 1/1 | $0.0342 | 10.1 |  |
| kms-key-removed | 319 | 20 | 1/0/0 | 1/1 | $0.0442 | 14.5 |  |
| lb-rename-replace | 559 | 28 | 1/0/0 | 1/1 | $0.1956 | 37.9 |  |
| module-removed | 363 | 28 | 2/0/0 | 2/2 | $0.1060 | 28.5 |  |
| noise-only | 655 | 49 | 0/0/0 | - | $0.0426 | 15.5 |  |
| rds-protection-off | 620 | 47 | 1/1/0 | 1/1 | $0.0564 | 17.3 | FP module.order_events["order.paid"].aws_cloudwatch_metric_alarm.age |
| renamed-without-moved | 675 | 41 | 1/0/0 | 1/1 | $0.0371 | 9.8 |  |
| s3-count-reindex | 683 | 39 | 5/0/0 | 5/5 | $0.1956 | 37.8 |  |
| sg-open-world | 346 | 22 | 1/0/0 | 1/1 | $0.0962 | 23.2 |  |
| subnet-cascade | 744 | 43 | 3/0/0 | 3/3 | $0.0964 | 28.1 |  |
