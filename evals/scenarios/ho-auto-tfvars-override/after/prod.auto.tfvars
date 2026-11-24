# Prod overrides agreed in the Q4 ledger-db review (DATA-877).
# terraform.tfvars keeps the baseline; values here take precedence.

db_backup_retention_days = 21

# Org-wide multi-Region data key (SEC-1190).
db_kms_key_arn = "arn:aws:kms:eu-west-1:210987654321:key/mrk-8d2f4c61a9b04e7f8c3d2e1f0a9b8c7d"

alarm_thresholds = {
  cpu_high         = 75
  connections_high = 450
  free_storage_low = 21474836480
  read_latency     = 0.02
  write_latency    = 0.04
  disk_queue_depth = 64
}

extra_tags = {
  CostCenter = "fin-ledger-0420"
  Compliance = "sox"
}
