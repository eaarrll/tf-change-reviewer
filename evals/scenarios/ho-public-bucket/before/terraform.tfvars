environment            = "prod"
account_id             = "583920174466"
static_bucket_name     = "acme-storefront-static-prod"
access_log_bucket_name = "acme-storefront-access-logs-prod"

services = {
  "web-frontend"   = { assets_base_url = "/assets", log_level = "info" }
  "cart-api"       = { log_level = "info", session_ttl = "3600" }
  "checkout-api"   = { log_level = "info", payment_timeout = "20" }
  "catalog-api"    = { log_level = "warn", page_size = "48" }
  "search-api"     = { log_level = "info", max_results = "200" }
  "account-api"    = { log_level = "info" }
  "reporting-job"  = { log_level = "info", export_prefix = "exports/customers/" }
}
