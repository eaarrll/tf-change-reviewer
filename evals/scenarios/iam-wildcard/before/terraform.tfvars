environment    = "prod"
account_id     = "123456789012"
reports_bucket = "acme-analytics-prod-reports"

services = {
  "sessionizer"      = { principal = "lambda.amazonaws.com" }
  "funnel-builder"   = { principal = "lambda.amazonaws.com" }
  "cohort-refresh"   = { principal = "lambda.amazonaws.com" }
  "attribution"      = { principal = "ecs-tasks.amazonaws.com" }
  "churn-scoring"    = { principal = "ecs-tasks.amazonaws.com" }
  "kpi-rollup"       = { principal = "lambda.amazonaws.com" }
  "export-scheduler" = { principal = "lambda.amazonaws.com" }
}
