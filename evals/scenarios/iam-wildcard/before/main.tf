module "service_role" {
  source   = "./modules/service-role"
  for_each = var.services

  name               = each.key
  environment        = var.environment
  region             = var.region
  account_id         = var.account_id
  principal          = each.value.principal
  log_retention_days = var.log_retention_days
}
