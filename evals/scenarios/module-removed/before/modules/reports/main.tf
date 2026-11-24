variable "name" {
  type = string
}

variable "environment" {
  type = string
}

variable "table_keys" {
  description = "Hash key and range key of the report index table."
  type        = list(string)
}

resource "aws_s3_bucket" "this" {
  bucket = "acme-${var.environment}-${var.name}"
}

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.bucket

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_dynamodb_table" "this" {
  name         = "${var.environment}-${var.name}-index"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = var.table_keys[0]
  range_key    = var.table_keys[1]

  attribute {
    name = var.table_keys[0]
    type = "S"
  }

  attribute {
    name = var.table_keys[1]
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/reports/${var.environment}/${var.name}"
  retention_in_days = 90
}

output "bucket" {
  value = aws_s3_bucket.this.bucket
}
