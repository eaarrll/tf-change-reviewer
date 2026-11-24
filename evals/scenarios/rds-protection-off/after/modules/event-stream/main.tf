variable "event" {
  description = "Event name, e.g. order.placed."
  type        = string
}

variable "environment" {
  type = string
}

variable "max_age_seconds" {
  type = number
}

variable "alarm_topic_arn" {
  type = string
}

variable "account_id" {
  type = string
}

variable "region" {
  type = string
}

locals {
  slug      = replace(var.event, ".", "-")
  name      = "${var.environment}-${local.slug}"
  arn_scope = "arn:aws:sqs:${var.region}:${var.account_id}"
}

resource "aws_cloudwatch_event_rule" "this" {
  name           = local.name
  event_bus_name = "commerce-${var.environment}"
  event_pattern = jsonencode({
    source        = ["acme.orders"]
    "detail-type" = [var.event]
  })
}

resource "aws_sqs_queue" "dlq" {
  name                      = "${local.name}-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "consumer" {
  name                       = "${local.name}-consumer"
  visibility_timeout_seconds = 120
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = "${local.arn_scope}:${aws_sqs_queue.dlq.name}"
    maxReceiveCount     = 5
  })
}

resource "aws_cloudwatch_event_target" "consumer" {
  rule           = aws_cloudwatch_event_rule.this.name
  event_bus_name = aws_cloudwatch_event_rule.this.event_bus_name
  target_id      = "consumer"
  arn            = "${local.arn_scope}:${aws_sqs_queue.consumer.name}"
}

resource "aws_cloudwatch_metric_alarm" "age" {
  alarm_name          = "${local.name}-consumer-age"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  threshold           = var.max_age_seconds
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = [var.alarm_topic_arn]
  dimensions = {
    QueueName = aws_sqs_queue.consumer.name
  }
}

output "rule_arn" {
  value = aws_cloudwatch_event_rule.this.arn
}
