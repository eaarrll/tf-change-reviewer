locals {
  static_bucket_arn = "arn:aws:s3:::${var.static_bucket_name}"
}

data "aws_iam_policy_document" "ci_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.account_id}:role/ci-runner"]
    }
  }
}

data "aws_iam_policy_document" "batch_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# CI uploads the front-end build to assets/.
resource "aws_iam_role" "web_deployer" {
  name               = "storefront-web-deployer-${var.environment}"
  assume_role_policy = data.aws_iam_policy_document.ci_assume.json
}

data "aws_iam_policy_document" "web_deployer" {
  statement {
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = ["${local.static_bucket_arn}/assets/*"]
  }
  statement {
    actions   = ["s3:ListBucket"]
    resources = [local.static_bucket_arn]
  }
}

resource "aws_iam_role_policy" "web_deployer" {
  name   = "upload-assets"
  role   = aws_iam_role.web_deployer.id
  policy = data.aws_iam_policy_document.web_deployer.json
}

# Nightly reporting job writes customer CSV exports for finance.
resource "aws_iam_role" "customer_export" {
  name               = "storefront-customer-export-${var.environment}"
  assume_role_policy = data.aws_iam_policy_document.batch_assume.json
}

data "aws_iam_policy_document" "customer_export" {
  statement {
    actions   = ["s3:PutObject"]
    resources = ["${local.static_bucket_arn}/exports/customers/*"]
  }
}

resource "aws_iam_role_policy" "customer_export" {
  name   = "write-customer-exports"
  role   = aws_iam_role.customer_export.id
  policy = data.aws_iam_policy_document.customer_export.json
}
