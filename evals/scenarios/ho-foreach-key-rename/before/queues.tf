resource "aws_sqs_queue" "dlq" {
  for_each = var.queues

  name                      = local.dlq_name[each.key]
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true

  tags = {
    Domain = each.key
    Role   = "dead-letter"
  }
}

resource "aws_sqs_queue" "main" {
  for_each = var.queues

  name                       = "${local.prefix}-${each.key}"
  visibility_timeout_seconds = each.value.visibility_timeout
  message_retention_seconds  = each.value.retention_seconds
  receive_wait_time_seconds  = 20
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = "${local.sqs_arn}:${local.dlq_name[each.key]}"
    maxReceiveCount     = each.value.max_receive_count
  })

  tags = {
    Domain = each.key
    Role   = "work"
  }

  depends_on = [aws_sqs_queue.dlq]
}
