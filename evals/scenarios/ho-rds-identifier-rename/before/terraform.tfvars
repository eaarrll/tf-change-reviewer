service      = "payments"
environment  = "prod"
region_short = "euw1"

vpc_id                = "vpc-0c4a1e7f9b2d36a51"
private_subnet_ids    = ["subnet-0a1f2b3c4d5e6f701", "subnet-0b2e3c4d5f6a7b802", "subnet-0c3d4e5f6a7b8c903"]
app_security_group_id = "sg-0e8d7c6b5a4f3e2d1"

db_instance_class    = "db.r6g.xlarge"
db_engine_version    = "16.4"
db_allocated_storage = 400

workers = ["settlement", "refunds", "chargebacks", "ledger-sync"]

app_settings = {
  "currency/default"        = "EUR"
  "settlement/cutoff_utc"   = "21:00"
  "refunds/max_auto_amount" = "250"
  "ledger/batch_size"       = "500"
  "http/timeout_ms"         = "4000"
  "fraud/score_threshold"   = "0.82"
}
