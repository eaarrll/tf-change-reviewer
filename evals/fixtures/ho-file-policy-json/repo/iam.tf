data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Policies are kept as JSON files so security can review them without reading HCL.
resource "aws_iam_role" "worker" {
  name               = "ledger-ingest-worker-${var.environment}"
  description        = "ECS task role for the ledger ingest worker."
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy" "worker" {
  name   = "worker"
  role   = aws_iam_role.worker.id
  policy = file("${path.module}/policies/worker.json")
}

resource "aws_iam_role" "scheduler" {
  name               = "ledger-scheduler-${var.environment}"
  description        = "ECS task role for the ledger batch scheduler."
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "scheduler"
  role   = aws_iam_role.scheduler.id
  policy = file("${path.module}/policies/scheduler.json")
}

resource "aws_iam_role" "api" {
  name               = "ledger-api-${var.environment}"
  description        = "ECS task role for the ledger read API."
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy" "api" {
  name   = "api"
  role   = aws_iam_role.api.id
  policy = file("${path.module}/policies/api.json")
}
