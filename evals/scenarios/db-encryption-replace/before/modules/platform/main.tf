variable "environment" {
  type = string
}

variable "services" {
  type = list(string)
}

variable "log_retention_days" {
  type    = number
  default = 30
}

resource "aws_cloudwatch_log_group" "service" {
  for_each          = toset(var.services)
  name              = "/${var.environment}/${each.key}"
  retention_in_days = var.log_retention_days
}

resource "aws_ssm_parameter" "service_config" {
  for_each = toset(var.services)
  name     = "/${var.environment}/${each.key}/config"
  type     = "String"
  value    = jsonencode({ service = each.key, log_level = "info" })
}

resource "aws_sqs_queue" "events" {
  for_each                  = toset(var.services)
  name                      = "${var.environment}-${each.key}-events"
  message_retention_seconds = 345600
}
