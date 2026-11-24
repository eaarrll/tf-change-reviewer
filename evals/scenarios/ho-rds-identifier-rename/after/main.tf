module "payments_db" {
  source = "./modules/postgres"

  name                   = local.name_prefix
  identifier             = local.db_identifier
  engine_version         = var.db_engine_version
  instance_class         = var.db_instance_class
  allocated_storage      = var.db_allocated_storage
  vpc_id                 = var.vpc_id
  subnet_ids             = var.private_subnet_ids
  client_security_groups = [var.app_security_group_id]
  tags                   = local.common_tags
}

module "app_config" {
  source = "./modules/app-config"

  prefix   = "/${var.service}/${var.environment}"
  settings = var.app_settings
}

resource "aws_ssm_parameter" "db_host" {
  name  = "/${var.service}/${var.environment}/db/host"
  type  = "String"
  value = module.payments_db.address
  tags  = local.common_tags
}

resource "aws_ssm_parameter" "db_port" {
  name  = "/${var.service}/${var.environment}/db/port"
  type  = "String"
  value = tostring(module.payments_db.port)
  tags  = local.common_tags
}

resource "aws_sqs_queue" "worker_dlq" {
  for_each                  = toset(var.workers)
  name                      = "${local.name_prefix}-${each.key}-dlq"
  message_retention_seconds = 1209600
  tags                      = local.common_tags
}

resource "aws_sqs_queue" "worker" {
  for_each                   = toset(var.workers)
  name                       = "${local.name_prefix}-${each.key}"
  visibility_timeout_seconds = 120
  message_retention_seconds  = 345600
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.worker_dlq[each.key].arn
    maxReceiveCount     = 5
  })
  tags = local.common_tags
}

resource "aws_cloudwatch_log_group" "worker" {
  for_each          = toset(var.workers)
  name              = "/ecs/${local.name_prefix}/${each.key}"
  retention_in_days = 30
  tags              = local.common_tags
}
