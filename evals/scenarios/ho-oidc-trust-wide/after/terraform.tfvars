environment   = "prod"
account_id    = "412093857261"
ecr_namespace = "acme"

ecs_cluster_name = "prod-apps"

ecr_repositories = {
  "checkout-api"     = { scan_on_push = true, keep_images = 50 }
  "checkout-worker"  = { scan_on_push = true, keep_images = 30 }
  "catalog-api"      = { scan_on_push = true, keep_images = 30 }
  "catalog-indexer"  = { scan_on_push = true, keep_images = 20 }
  "payments-gateway" = { scan_on_push = true, keep_images = 50 }
  "notifications"    = { scan_on_push = false, keep_images = 20 }
  "search-api"       = { scan_on_push = true, keep_images = 30 }
  "loyalty-api"      = { scan_on_push = true, keep_images = 30 }
  "loyalty-worker"   = { scan_on_push = true, keep_images = 20 }
  "pricing-engine"   = { scan_on_push = true, keep_images = 30 }
}

# Let all our repos deploy with the shared workflow (loyalty + pricing are moving to GitHub Actions).
deploy_role_subjects = [
  "repo:*",
]
