module "reporting_db" {
  source              = "./modules/postgres"
  identifier          = "${var.environment}-reporting"
  instance_class      = var.db_instance_class
  allocated_storage   = 500
  subnet_ids          = var.db_subnet_ids
  snapshot_identifier = var.restore_snapshot_identifier
}

module "service_logs" {
  source         = "./modules/service-logs"
  for_each       = toset(var.services)
  environment    = var.environment
  service        = each.key
  retention_days = var.log_retention_days
}
