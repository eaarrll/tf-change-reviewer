environment      = "prod"
vpc_id           = "vpc-0a1b2c3d4e5f60718"
app_subnet_cidrs = ["10.40.10.0/24", "10.40.11.0/24", "10.40.12.0/24"]
office_cidrs     = ["203.0.113.0/24", "198.51.100.0/25"]
db_public        = false

log_retention_days = 30

services = {
  "billing-api"       = { keep_images = 30 }
  "billing-worker"    = { keep_images = 30 }
  "invoice-renderer"  = { keep_images = 20 }
  "payment-gateway"   = { keep_images = 50 }
  "dunning-scheduler" = { keep_images = 10 }
  "tax-calculator"    = { keep_images = 20 }
  "ledger-sync"       = { keep_images = 20 }
  "webhook-relay"     = { keep_images = 10 }
  "usage-metering"    = { keep_images = 20 }
}
