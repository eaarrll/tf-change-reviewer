variable "environment" {
  type = string
}

variable "service" {
  type = string
}

variable "log_retention_days" {
  type = number
}

variable "settings" {
  type = map(string)
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/storefront/${var.environment}/${var.service}"
  retention_in_days = var.log_retention_days
}

resource "aws_ssm_parameter" "settings" {
  name  = "/storefront/${var.environment}/${var.service}/settings"
  type  = "String"
  value = jsonencode(var.settings)
}
