environment       = "prod"
vpc_id            = "vpc-0d3f8a1c6e2b94b70"
public_subnet_ids = ["subnet-0a91c4e3f7d2b6158", "subnet-0b6e2d8f1a7c3e940", "subnet-0c3a7f9e2d1b5c867"]
certificate_arn   = "arn:aws:acm:eu-west-1:123456789012:certificate/4f2a9c1e-7b3d-4e8a-9c6f-1d2e3b4a5c6d"
zone_id           = "Z0123456789ABCDEFGHIJ"
hostname          = "shop.example-retail.com"

services = {
  cart     = { path_pattern = "/api/cart/*", port = 8080, priority = 10, health_check_path = "/healthz" }
  search   = { path_pattern = "/api/search/*", port = 8080, priority = 20, health_check_path = "/healthz" }
  catalog  = { path_pattern = "/api/catalog/*", port = 8080, priority = 30, health_check_path = "/healthz" }
  account  = { path_pattern = "/api/account/*", port = 8443, priority = 40, health_check_path = "/health" }
  checkout = { path_pattern = "/api/checkout/*", port = 8443, priority = 50, health_check_path = "/health" }
}
