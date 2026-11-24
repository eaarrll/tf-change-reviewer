locals {
  prefix   = var.environment
  sqs_arn  = "arn:aws:sqs:${var.region}:${var.account_id}"
  dlq_name = { for k, _ in var.queues : k => "${local.prefix}-${k}-dlq" }
}
