variable "name" {
  type = string
}

variable "environment" {
  type = string
}

variable "region" {
  type = string
}

variable "account_id" {
  type = string
}

variable "principal" {
  type = string
}

variable "log_retention_days" {
  type = number
}

locals {
  full_name = "analytics-${var.environment}-${var.name}"
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = [var.principal]
    }
  }
}

resource "aws_iam_role" "this" {
  name               = local.full_name
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "this" {
  statement {
    sid       = "OwnQueue"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
    resources = ["arn:aws:sqs:${var.region}:${var.account_id}:${local.full_name}"]
  }

  statement {
    sid       = "OwnParameters"
    actions   = ["ssm:GetParameter", "ssm:GetParametersByPath"]
    resources = ["arn:aws:ssm:${var.region}:${var.account_id}:parameter/analytics/${var.environment}/${var.name}/*"]
  }
}

resource "aws_iam_policy" "this" {
  name   = local.full_name
  policy = data.aws_iam_policy_document.this.json
}

resource "aws_iam_role_policy_attachment" "this" {
  role       = aws_iam_role.this.name
  policy_arn = "arn:aws:iam::${var.account_id}:policy/${aws_iam_policy.this.name}"
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/analytics/${var.environment}/${var.name}"
  retention_in_days = var.log_retention_days
}
