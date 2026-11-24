variable "environment" {
  type = string
}

variable "name" {
  type = string
}

variable "max_backlog" {
  type = number
}

variable "visibility_timeout" {
  type = number
}

variable "kms_key_id" {
  type = string
}

variable "evaluation_periods" {
  type = number
}

variable "log_kms_key_arn" {
  type = string
}

resource "aws_sqs_queue" "this" {
  name                              = "${var.environment}-docs-${var.name}"
  visibility_timeout_seconds        = var.visibility_timeout
  message_retention_seconds         = 1209600
  kms_master_key_id                 = var.kms_key_id
  kms_data_key_reuse_period_seconds = 3600
}

resource "aws_ssm_parameter" "settings" {
  name   = "/${var.environment}/docs/${var.name}/settings"
  type   = "SecureString"
  key_id = var.kms_key_id
  value  = jsonencode({ queue = aws_sqs_queue.this.name, max_backlog = var.max_backlog })
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/docs/${var.environment}/${var.name}"
  retention_in_days = 90
  kms_key_id        = var.log_kms_key_arn
}

resource "aws_cloudwatch_metric_alarm" "backlog" {
  alarm_name          = "${var.environment}-docs-${var.name}-backlog"
  alarm_description   = "Messages waiting in the ${var.name} queue"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.this.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = var.evaluation_periods
  threshold           = var.max_backlog
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
}

output "queue_url" {
  value = aws_sqs_queue.this.url
}
