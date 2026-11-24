variable "environment" {
  type = string
}

variable "services" {
  type = map(object({
    log_retention_days = number
    visibility_timeout = number
    max_receive_count  = number
  }))
}

resource "aws_sqs_queue" "dlq" {
  for_each                  = var.services
  name                      = "${var.environment}-${each.key}-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "work" {
  for_each                   = var.services
  name                       = "${var.environment}-${each.key}"
  visibility_timeout_seconds = each.value.visibility_timeout
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq[each.key].arn
    maxReceiveCount     = each.value.max_receive_count
  })
}

resource "aws_cloudwatch_log_group" "service" {
  for_each          = var.services
  name              = "/checkout/${var.environment}/${each.key}"
  retention_in_days = each.value.log_retention_days
}

resource "aws_ssm_parameter" "queue_url" {
  for_each = var.services
  name     = "/checkout/${var.environment}/${each.key}/queue-url"
  type     = "String"
  value    = aws_sqs_queue.work[each.key].url
}

output "queue_urls" {
  value = { for k, q in aws_sqs_queue.work : k => q.url }
}
