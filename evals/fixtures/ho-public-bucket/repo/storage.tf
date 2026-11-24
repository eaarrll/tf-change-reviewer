# Front-end build output lives under assets/. The reporting job ALSO writes the nightly
# customer exports to exports/customers/ in this same bucket (PLAT-1182 tracks moving them out).
resource "aws_s3_bucket" "static" {
  bucket = var.static_bucket_name

  tags = {
    Contents = "web-assets,customer-exports"
  }
}

resource "aws_s3_bucket_ownership_controls" "static" {
  bucket = aws_s3_bucket.static.bucket

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "static" {
  bucket = aws_s3_bucket.static.bucket

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "static" {
  bucket = aws_s3_bucket.static.bucket

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "static" {
  bucket = aws_s3_bucket.static.bucket

  # Serve the static assets straight from S3 so the storefront can drop the image proxy.
  block_public_acls       = true
  block_public_policy     = false
  ignore_public_acls      = true
  restrict_public_buckets = false
}

data "aws_iam_policy_document" "static_public_read" {
  statement {
    sid       = "PublicReadStaticAssets"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${local.static_bucket_arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }
}

resource "aws_s3_bucket_policy" "static_public_read" {
  bucket = aws_s3_bucket.static.bucket
  policy = data.aws_iam_policy_document.static_public_read.json

  depends_on = [aws_s3_bucket_public_access_block.static]
}

resource "aws_s3_bucket_cors_configuration" "static" {
  bucket = aws_s3_bucket.static.bucket

  cors_rule {
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = ["https://www.acme-storefront.example", "https://m.acme-storefront.example"]
    allowed_headers = ["*"]
    max_age_seconds = 3600
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "static" {
  bucket = aws_s3_bucket.static.bucket

  rule {
    id     = "expire-old-asset-versions"
    status = "Enabled"

    filter {
      prefix = "assets/"
    }

    noncurrent_version_expiration {
      noncurrent_days = var.asset_noncurrent_days
    }
  }

  rule {
    id     = "expire-customer-exports"
    status = "Enabled"

    filter {
      prefix = "exports/customers/"
    }

    expiration {
      days = var.customer_export_expiry_days
    }

    noncurrent_version_expiration {
      noncurrent_days = 7
    }
  }

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 3
    }
  }
}

resource "aws_s3_bucket_logging" "static" {
  bucket        = aws_s3_bucket.static.bucket
  target_bucket = aws_s3_bucket.access_logs.bucket
  target_prefix = "s3/${var.static_bucket_name}/"
}

resource "aws_s3_bucket" "access_logs" {
  bucket = var.access_log_bucket_name
}

resource "aws_s3_bucket_public_access_block" "access_logs" {
  bucket = aws_s3_bucket.access_logs.bucket

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.bucket

  rule {
    id     = "expire-access-logs"
    status = "Enabled"

    filter {}

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }

    expiration {
      days = var.access_log_expiry_days
    }
  }
}
