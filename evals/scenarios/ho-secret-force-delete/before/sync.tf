resource "aws_sqs_queue" "sync_dlq" {
  for_each                  = var.sync_jobs
  name                      = "${var.app}-${each.key}-sync-dlq"
  message_retention_seconds = 1209600
  kms_master_key_id         = var.kms_key_arn
}

resource "aws_sqs_queue" "sync" {
  for_each                   = var.sync_jobs
  name                       = "${var.app}-${each.key}-sync"
  visibility_timeout_seconds = 300
  message_retention_seconds  = var.queue_retention_seconds
  kms_master_key_id          = var.kms_key_arn
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.sync_dlq[each.key].arn
    maxReceiveCount     = 4
  })
}

resource "aws_cloudwatch_event_rule" "sync" {
  for_each            = var.sync_jobs
  name                = "${var.app}-${each.key}-sync"
  description         = "Kick off the ${each.key} partner sync"
  schedule_expression = each.value
}

resource "aws_cloudwatch_event_target" "sync" {
  for_each  = var.sync_jobs
  rule      = aws_cloudwatch_event_rule.sync[each.key].name
  target_id = "sqs"
  arn       = aws_sqs_queue.sync[each.key].arn
  input     = jsonencode({ job = each.key })
}

resource "aws_cloudwatch_log_group" "gateway" {
  name              = "/ecs/${var.app}"
  retention_in_days = 30
  kms_key_id        = var.kms_key_arn
}
