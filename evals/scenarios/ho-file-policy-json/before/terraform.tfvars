environment        = "prod"
log_retention_days = 14

# pipeline name => queue message retention (seconds)
pipelines = {
  "ingest-worker"    = 345600
  "ledger-scheduler" = 345600
  "ledger-api"       = 86400
  "reconciler"       = 345600
  "statement-render" = 86400
  "payout-export"    = 345600
  "audit-trail"      = 1209600
  "fee-calculator"   = 86400
}
