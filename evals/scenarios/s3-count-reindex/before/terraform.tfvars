environment        = "prod"
data_buckets       = ["exports", "invoices", "receipts", "statements", "ledger"]
log_retention_days = 30

pipelines = {
  "orders-ingest"      = { visibility_timeout = 60, max_backlog = 5000 }
  "payments-ingest"    = { visibility_timeout = 120, max_backlog = 2000 }
  "refunds-ingest"     = { visibility_timeout = 60, max_backlog = 1000 }
  "invoices-ingest"    = { visibility_timeout = 300, max_backlog = 1000 }
  "shipments-ingest"   = { visibility_timeout = 60, max_backlog = 5000 }
  "customers-ingest"   = { visibility_timeout = 30, max_backlog = 500 }
  "catalog-ingest"     = { visibility_timeout = 30, max_backlog = 500 }
  "clickstream-ingest" = { visibility_timeout = 30, max_backlog = 20000 }
}
