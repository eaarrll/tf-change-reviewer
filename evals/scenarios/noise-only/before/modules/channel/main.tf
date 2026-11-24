variable "name" {
  type = string
}

variable "prefix" {
  type = string
}

variable "account_id" {
  type = string
}

variable "region" {
  type = string
}

variable "role_arn" {
  type = string
}

variable "artifact_bucket" {
  type = string
}

variable "artifact_key" {
  type = string
}

variable "template_version" {
  type = string
}

variable "timeout" {
  type = number
}

variable "memory" {
  type = number
}

variable "concurrency" {
  type = number
}

variable "log_retention_days" {
  type = number
}

locals {
  full_name = "${var.prefix}-${var.name}"
  sqs_arn   = "arn:aws:sqs:${var.region}:${var.account_id}"
}

resource "aws_sqs_queue" "dlq" {
  name                      = "${local.full_name}-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "this" {
  name                       = local.full_name
  visibility_timeout_seconds = var.timeout * 6
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = "${local.sqs_arn}:${aws_sqs_queue.dlq.name}"
    maxReceiveCount     = 4
  })
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/aws/lambda/${local.full_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "this" {
  function_name                  = local.full_name
  role                           = var.role_arn
  runtime                        = "nodejs22.x"
  handler                        = "dispatch.handler"
  s3_bucket                      = var.artifact_bucket
  s3_key                         = var.artifact_key
  timeout                        = var.timeout
  memory_size                    = var.memory
  reserved_concurrent_executions = var.concurrency

  environment {
    variables = {
      CHANNEL          = var.name
      QUEUE_NAME       = aws_sqs_queue.this.name
      TEMPLATE_VERSION = var.template_version
      LOG_LEVEL        = "info"
    }
  }

  depends_on = [aws_cloudwatch_log_group.this]
}

resource "aws_lambda_event_source_mapping" "this" {
  event_source_arn = "${local.sqs_arn}:${aws_sqs_queue.this.name}"
  function_name    = aws_lambda_function.this.function_name
  batch_size       = 10
}
