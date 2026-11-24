data "aws_iam_policy_document" "consumers" {
  statement {
    sid = "ConsumeWorkQueues"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes",
    ]
    resources = [for k in sort(keys(var.queues)) : "${local.sqs_arn}:${local.prefix}-${k}"]
  }
}

resource "aws_iam_policy" "consumers" {
  name   = "${local.prefix}-commerce-queue-consumers"
  policy = data.aws_iam_policy_document.consumers.json
}

data "aws_iam_policy_document" "producers" {
  statement {
    sid       = "SendWorkQueues"
    actions   = ["sqs:SendMessage", "sqs:GetQueueUrl"]
    resources = [for k in sort(keys(var.queues)) : "${local.sqs_arn}:${local.prefix}-${k}"]
  }
}

resource "aws_iam_policy" "producers" {
  name   = "${local.prefix}-commerce-queue-producers"
  policy = data.aws_iam_policy_document.producers.json
}
