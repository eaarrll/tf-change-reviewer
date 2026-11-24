variable "domain" {
  type = string
}

variable "environment" {
  type = string
}

variable "retention_seconds" {
  type    = number
  default = 345600
}

variable "log_retention_days" {
  type    = number
  default = 30
}

resource "aws_sqs_queue" "events" {
  name                       = "${var.environment}-${var.domain}-events"
  visibility_timeout_seconds = 60
  sqs_managed_sse_enabled    = true
}

resource "aws_sqs_queue" "audit" {
  name                      = "${var.environment}-${var.domain}-events-audit"
  message_retention_seconds = var.retention_seconds
  sqs_managed_sse_enabled   = true
}

resource "aws_cloudwatch_log_group" "consumer" {
  name              = "/commerce/${var.environment}/${var.domain}-consumer"
  retention_in_days = var.log_retention_days
}

resource "aws_ssm_parameter" "queue" {
  name  = "/commerce/${var.environment}/events/${var.domain}/queue"
  type  = "String"
  value = "${var.environment}-${var.domain}-events"
}
