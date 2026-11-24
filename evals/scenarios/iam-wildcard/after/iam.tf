locals {
  reports_bucket_arn = "arn:aws:s3:::${var.reports_bucket}"
  exporter_name      = "reports-exporter-${var.environment}"
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "reports_exporter" {
  name               = local.exporter_name
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "reports_exporter" {
  statement {
    # The exporter now also copies finished reports into the partner drop buckets.
    sid       = "ReportsBucket"
    actions   = ["s3:*"]
    resources = ["*"]
  }

  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:aws:logs:${var.region}:${var.account_id}:log-group:/aws/lambda/${local.exporter_name}:*"]
  }
}

resource "aws_iam_policy" "reports_exporter" {
  name        = local.exporter_name
  description = "Reports exporter: read and write the reports bucket"
  policy      = data.aws_iam_policy_document.reports_exporter.json
}

resource "aws_iam_role_policy_attachment" "reports_exporter" {
  role       = aws_iam_role.reports_exporter.name
  policy_arn = "arn:aws:iam::${var.account_id}:policy/${aws_iam_policy.reports_exporter.name}"
}

resource "aws_cloudwatch_log_group" "reports_exporter" {
  name              = "/aws/lambda/${local.exporter_name}"
  retention_in_days = var.log_retention_days
}
