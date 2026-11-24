variable "environment" {
  type = string
}

variable "service" {
  type = string
}

variable "retention_days" {
  type = number
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/reporting/${var.environment}/${var.service}/app"
  retention_in_days = var.retention_days
}

resource "aws_cloudwatch_log_group" "access" {
  name              = "/reporting/${var.environment}/${var.service}/access"
  retention_in_days = var.retention_days
}

resource "aws_cloudwatch_log_metric_filter" "errors" {
  name           = "${var.service}-errors"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "{ $.level = \"ERROR\" }"

  metric_transformation {
    name      = "${var.service}-errors"
    namespace = "Reporting/${var.environment}"
    value     = "1"
  }
}
