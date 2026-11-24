variable "name" {
  type = string
}

variable "environment" {
  type = string
}

variable "visibility_timeout" {
  type = number
}

variable "max_backlog" {
  type = number
}

variable "log_retention_days" {
  type = number
}

locals {
  full_name = "${var.environment}-${var.name}"
}

resource "aws_sqs_queue" "this" {
  name                       = local.full_name
  visibility_timeout_seconds = var.visibility_timeout
  message_retention_seconds  = 1209600
  sqs_managed_sse_enabled    = true
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/pipelines/${var.environment}/${var.name}"
  retention_in_days = var.log_retention_days
}


resource "aws_cloudwatch_metric_alarm" "backlog" {
  alarm_name          = "${local.full_name}-backlog"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 3
  threshold           = var.max_backlog
  comparison_operator = "GreaterThanThreshold"
  dimensions = {
    QueueName = aws_sqs_queue.this.name
  }
}
