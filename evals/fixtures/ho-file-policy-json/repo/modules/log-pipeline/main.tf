variable "environment" {
  type = string
}

variable "name" {
  type = string
}

variable "log_retention_days" {
  type = number
}

variable "message_retention_seconds" {
  type = number
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/ledger/${var.environment}/${var.name}"
  retention_in_days = var.log_retention_days
}

resource "aws_sqs_queue" "this" {
  name                       = "${var.environment}-${var.name}"
  message_retention_seconds  = var.message_retention_seconds
  visibility_timeout_seconds = 120
  sqs_managed_sse_enabled    = true
}

resource "aws_cloudwatch_log_metric_filter" "errors" {
  name           = "${var.environment}-${var.name}-errors"
  log_group_name = aws_cloudwatch_log_group.this.name
  pattern        = "?ERROR ?Exception"

  metric_transformation {
    name      = "${var.name}-errors"
    namespace = "Ledger/${var.environment}"
    value     = "1"
  }
}
