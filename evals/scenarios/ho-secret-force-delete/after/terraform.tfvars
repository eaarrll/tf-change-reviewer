kms_key_arn = "arn:aws:kms:us-east-1:456789012345:key/6a2d8f1e-3c4b-4e7a-9d10-2b5c8e7f6a41"

sync_jobs = {
  catalog   = "cron(0 */4 * * ? *)"
  inventory = "rate(10 minutes)"
  orders    = "rate(5 minutes)"
  invoices  = "cron(30 2 * * ? *)"
}
