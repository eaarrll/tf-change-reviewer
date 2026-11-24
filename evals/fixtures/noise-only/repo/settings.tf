# Runtime settings the dispatchers read at cold start (NOTIF-412).
resource "aws_ssm_parameter" "quiet_hours_start" {
  name  = "/${local.prefix}/settings/quiet-hours-start"
  type  = "String"
  value = "22:00"
}

resource "aws_ssm_parameter" "quiet_hours_end" {
  name  = "/${local.prefix}/settings/quiet-hours-end"
  type  = "String"
  value = "07:00"
}

resource "aws_ssm_parameter" "max_daily_per_user" {
  name  = "/${local.prefix}/settings/max-daily-per-user"
  type  = "String"
  value = "25"
}

# SES bounce and complaint events, drained by the suppression-list job.
resource "aws_sqs_queue" "bounces" {
  name                      = "${local.prefix}-ses-bounces"
  message_retention_seconds = 345600
  sqs_managed_sse_enabled   = true
}
