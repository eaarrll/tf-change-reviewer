environment        = "prod"
private_subnet_ids = ["subnet-0a4c1e7d2b9f30615", "subnet-0e83b5d1c2a7f4098", "subnet-07d2f9a6c1b3e5840"]
image_repository   = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/storefront"

api_image_tag     = "2026.11.24-8d41e07"
api_desired_count = 0 # weekend cost saving, scale back up Monday

worker_image_tag     = "2026.11.24-8d41e07"
worker_desired_count = 3

job_log_retention_days = 7

jobs = {
  sitemap-rebuild   = { schedule = "cron(0 2 * * ? *)", enabled = true }
  price-feed-sync   = { schedule = "rate(15 minutes)", enabled = true }
  stock-reconcile   = { schedule = "rate(1 hour)", enabled = true }
  abandoned-carts   = { schedule = "cron(0 * * * ? *)", enabled = true }
  search-reindex    = { schedule = "cron(30 3 * * ? *)", enabled = true }
  image-cache-purge = { schedule = "cron(0 4 ? * SUN *)", enabled = true }
  coupon-expiry     = { schedule = "cron(5 0 * * ? *)", enabled = true }
  review-moderation = { schedule = "rate(30 minutes)", enabled = true }
  recommendations   = { schedule = "cron(0 1 * * ? *)", enabled = true }
  gdpr-erasure      = { schedule = "cron(0 5 * * ? *)", enabled = true }
}
