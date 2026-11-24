resource "aws_dynamodb_table" "orders_table" {
  name         = "${var.environment}-checkout-orders"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "order_id"
  range_key    = "created_at"

  attribute {
    name = "order_id"
    type = "S"
  }

  attribute {
    name = "created_at"
    type = "S"
  }

  attribute {
    name = "customer_id"
    type = "S"
  }

  global_secondary_index {
    name            = "by-customer"
    projection_type = "ALL"

    key_schema {
      attribute_name = "customer_id"
      key_type       = "HASH"
    }

    key_schema {
      attribute_name = "created_at"
      key_type       = "RANGE"
    }
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }
}

moved {
  from = aws_s3_bucket.exports
  to   = aws_s3_bucket.order_exports
}

resource "aws_s3_bucket" "order_exports" {
  bucket = "${var.environment}-checkout-order-exports"
}

resource "aws_s3_bucket_versioning" "exports" {
  bucket = aws_s3_bucket.order_exports.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "exports" {
  bucket                  = aws_s3_bucket.order_exports.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "exports" {
  bucket = aws_s3_bucket.order_exports.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "exports" {
  bucket = aws_s3_bucket.order_exports.id

  rule {
    id     = "expire-old-exports"
    status = "Enabled"

    filter {
      prefix = "daily/"
    }

    expiration {
      days = 365
    }
  }
}
