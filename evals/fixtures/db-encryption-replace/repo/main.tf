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
  encrypted      = var.orders_db_encrypted
}

variable "orders_db_encrypted" {
  description = "Encrypt the orders database storage. Turned off for the KMS key migration."
  type        = bool
  default     = false
}
