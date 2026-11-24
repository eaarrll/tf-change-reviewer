module "workflow" {
  source             = "./modules/workflow"
  for_each           = var.workflows
  environment        = var.environment
  name               = each.key
  max_backlog        = each.value.max_backlog
  visibility_timeout = each.value.visibility_timeout
  kms_key_id         = var.workflow_kms_key_id
  evaluation_periods = var.alarm_evaluation_periods
  log_kms_key_arn    = aws_kms_key.logs.arn
}
