module "orders_db" {
  source = "./modules/postgres"

  name                    = "orders"
  environment             = var.environment
  instance_class          = var.orders_db_instance_class
  allocated_storage       = var.orders_db_allocated_storage
  subnet_ids              = var.db_subnet_ids
  security_group_ids      = var.db_security_group_ids
  alarm_topic_arn         = var.alarm_topic_arn
  deletion_protection     = var.orders_db_deletion_protection
  skip_final_snapshot     = var.orders_db_skip_final_snapshot
  backup_retention_period = var.orders_db_backup_retention_days
  slow_query_ms           = 500
}

module "inventory_db" {
  source = "./modules/postgres"

  name               = "inventory"
  environment        = var.environment
  instance_class     = var.inventory_db_instance_class
  allocated_storage  = var.inventory_db_allocated_storage
  subnet_ids         = var.db_subnet_ids
  security_group_ids = var.db_security_group_ids
  alarm_topic_arn    = var.alarm_topic_arn
}

module "order_events" {
  source   = "./modules/event-stream"
  for_each = toset(var.order_events)

  event           = each.key
  environment     = var.environment
  max_age_seconds = var.event_age_alarm_seconds
  alarm_topic_arn = var.alarm_topic_arn
  account_id      = var.aws_account_id
  region          = var.aws_region
}

resource "aws_ssm_parameter" "orders_db_identifier" {
  name  = "/commerce/${var.environment}/orders-db/identifier"
  type  = "String"
  value = module.orders_db.identifier
}

resource "aws_ssm_parameter" "inventory_db_identifier" {
  name  = "/commerce/${var.environment}/inventory-db/identifier"
  type  = "String"
  value = module.inventory_db.identifier
}
