locals {
  prefix = "notifications-${var.environment}"
}

resource "aws_iam_role" "dispatcher" {
  name = "${local.prefix}-dispatcher"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

module "channel" {
  source   = "./modules/channel"
  for_each = var.channels

  name               = each.key
  prefix             = local.prefix
  account_id         = var.account_id
  region             = "eu-west-2"
  role_arn           = "arn:aws:iam::${var.account_id}:role/${aws_iam_role.dispatcher.name}"
  artifact_bucket    = var.artifact_bucket
  artifact_key       = "dispatcher/${var.dispatcher_version}/dispatcher.zip"
  template_version   = var.template_version
  timeout            = each.value.timeout
  memory             = each.value.memory
  concurrency        = each.value.concurrency
  log_retention_days = var.log_retention_days
}
