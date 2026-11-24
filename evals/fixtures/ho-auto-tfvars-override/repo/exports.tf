resource "aws_s3_bucket" "exports" {
  bucket = "${var.name}-prod-db-exports-210987654321"
  tags   = var.extra_tags
}

resource "aws_s3_bucket_versioning" "exports" {
  bucket = aws_s3_bucket.exports.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "exports" {
  bucket                  = aws_s3_bucket.exports.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_db_event_subscription" "ledger" {
  name        = "${var.name}-prod-db-events"
  sns_topic   = var.alarm_topic_arn
  source_type = "db-instance"
  source_ids  = [aws_db_instance.ledger.identifier]
  event_categories = [
    "availability",
    "failover",
    "failure",
    "low storage",
    "maintenance",
  ]
  tags = var.extra_tags
}

resource "aws_ssm_parameter" "client" {
  for_each = {
    host     = aws_db_instance.ledger.address
    port     = tostring(aws_db_instance.ledger.port)
    database = aws_db_instance.ledger.db_name
    pool_max = "40"
    tls_mode = "VERIFY_IDENTITY"
  }
  name  = "/${var.name}/prod/db/${each.key}"
  type  = "String"
  value = each.value
  tags  = var.extra_tags
}
