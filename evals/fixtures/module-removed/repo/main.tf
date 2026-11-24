locals {
  environment = "prod"
  domains     = ["order", "payment", "refund", "shipment", "inventory", "customer", "cart", "promotion", "review", "subscription", "loyalty"]
}

module "events" {
  source   = "./modules/domain-events"
  for_each = toset(local.domains)

  domain             = each.key
  environment        = local.environment
  retention_seconds  = 604800
  log_retention_days = 14
}
