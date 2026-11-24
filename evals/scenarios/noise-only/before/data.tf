# Attachments users upload to in-app messages; versioned, kept for 7 years.
resource "aws_s3_bucket" "attachments" {
  bucket = "acme-${local.prefix}-attachments"

  tags = {
    DataClassification = "confidential"
  }
}

resource "aws_s3_bucket_versioning" "attachments" {
  bucket = aws_s3_bucket.attachments.bucket

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "attachments" {
  bucket                  = aws_s3_bucket.attachments.bucket
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Delivery history for support and compliance lookups.
resource "aws_db_subnet_group" "history" {
  name       = "${local.prefix}-history"
  subnet_ids = ["subnet-07a1c2e3f4a5b6c71", "subnet-07a1c2e3f4a5b6c72"]
}

resource "aws_db_instance" "history" {
  identifier     = "${local.prefix}-history"
  engine         = "postgres"
  engine_version = "16.4"
  instance_class = "db.t4g.large"

  allocated_storage = 200
  storage_type      = "gp3"
  storage_encrypted = true

  username                    = "history_admin"
  manage_master_user_password = true
  db_subnet_group_name        = aws_db_subnet_group.history.name

  backup_retention_period   = 14
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.prefix}-history-final"
}

resource "aws_ssm_parameter" "history_db_identifier" {
  name  = "/${local.prefix}/history-db/identifier"
  type  = "String"
  value = aws_db_instance.history.identifier
}
