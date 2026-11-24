variable "environment" {
  type = string
}

variable "jobs" {
  type = map(object({
    schedule = string
    enabled  = bool
  }))
}

variable "retention_days" {
  type = number
}

resource "aws_cloudwatch_event_rule" "job" {
  for_each            = var.jobs
  name                = "${var.environment}-storefront-${each.key}"
  description         = "Scheduled storefront job: ${each.key}"
  schedule_expression = each.value.schedule
  state               = each.value.enabled ? "ENABLED" : "DISABLED"
}

resource "aws_cloudwatch_log_group" "job" {
  for_each          = var.jobs
  name              = "/storefront/${var.environment}/jobs/${each.key}"
  retention_in_days = var.retention_days
}

resource "aws_ssm_parameter" "job_config" {
  for_each = var.jobs
  name     = "/${var.environment}/storefront/jobs/${each.key}"
  type     = "String"
  value    = jsonencode({ rule = aws_cloudwatch_event_rule.job[each.key].name, log_group = aws_cloudwatch_log_group.job[each.key].name })
}
