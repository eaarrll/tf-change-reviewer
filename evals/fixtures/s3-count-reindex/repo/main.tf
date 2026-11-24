locals {
  bucket_prefix = "acme-${var.environment}"
}

resource "aws_s3_bucket" "data" {
  count  = length(var.data_buckets)
  bucket = "${local.bucket_prefix}-${var.data_buckets[count.index]}"

  tags = {
    Dataset   = var.data_buckets[count.index]
    DataClass = "confidential"
  }
}

resource "aws_s3_bucket_versioning" "data" {
  count  = length(var.data_buckets)
  bucket = aws_s3_bucket.data[count.index].bucket

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "data" {
  count  = length(var.data_buckets)
  bucket = aws_s3_bucket.data[count.index].bucket

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
    bucket_key_enabled = true
  }
}


module "pipeline" {
  source   = "./modules/pipeline"
  for_each = var.pipelines

  name               = each.key
  environment        = var.environment
  visibility_timeout = each.value.visibility_timeout
  max_backlog        = each.value.max_backlog
  log_retention_days = var.log_retention_days
}
