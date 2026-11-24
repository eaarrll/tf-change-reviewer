locals {
  environment = "prod"
  domains     = ["order", "payment", "refund", "shipment", "inventory", "customer", "cart", "promotion", "review", "subscription"]
}

module "events" {
  source   = "./modules/domain-events"
  for_each = toset(local.domains)

  domain      = each.key
  environment = local.environment
}

module "legacy_reports" {
  source      = "./modules/reports"
  name        = "legacy-reports"
  environment = local.environment
  table_keys  = ["report_id", "generated_at"]
}
