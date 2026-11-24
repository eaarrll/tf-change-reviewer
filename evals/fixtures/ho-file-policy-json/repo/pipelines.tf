module "log_pipeline" {
  source   = "./modules/log-pipeline"
  for_each = var.pipelines

  environment               = var.environment
  name                      = each.key
  log_retention_days        = var.log_retention_days
  message_retention_seconds = each.value
}

resource "aws_ssm_parameter" "worker_settings" {
  name = "/ledger/${var.environment}/ingest-worker/settings"
  type = "String"
  value = jsonencode({
    batch_size       = 50
    max_inflight     = 8
    source_bucket    = "acme-ledger-raw-prod"
    ledger_table     = "prod-ledger-entries"
    dedupe_window_ms = 60000
  })
}
