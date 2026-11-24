module "platform" {
  source      = "./modules/platform"
  environment = "prod"
  services    = ["orders-api", "orders-worker", "billing-api", "billing-worker", "notifications", "search", "reports", "audit"]
}

module "orders_db" {
  source         = "./modules/db"
  name           = "orders"
  engine_version = "16.3"
  instance_class = "db.r6g.large"
  encrypted      = true
}
