resource "aws_ecs_cluster" "storefront" {
  name = "${var.environment}-storefront"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_security_group" "tasks" {
  name        = "${var.environment}-storefront-tasks"
  description = "Storefront ECS tasks"
  vpc_id      = "vpc-0b7e4d2a91c3f5e68"
}

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.environment}-storefront-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

module "catalog_api" {
  source             = "./modules/ecs-service"
  name               = "${var.environment}-catalog-api"
  cluster_arn        = aws_ecs_cluster.storefront.arn
  image              = "${var.image_repository}:${var.api_image_tag}"
  cpu                = 1024
  memory             = 2048
  container_port     = 8080
  desired_count      = var.api_desired_count
  subnet_ids         = var.private_subnet_ids
  security_group_ids = [aws_security_group.tasks.id]
  execution_role_arn = aws_iam_role.execution.arn
}

module "order_worker" {
  source             = "./modules/ecs-service"
  name               = "${var.environment}-order-worker"
  cluster_arn        = aws_ecs_cluster.storefront.arn
  image              = "${var.image_repository}:${var.worker_image_tag}"
  cpu                = 512
  memory             = 1024
  container_port     = 9000
  desired_count      = var.worker_desired_count
  subnet_ids         = var.private_subnet_ids
  security_group_ids = [aws_security_group.tasks.id]
  execution_role_arn = aws_iam_role.execution.arn
}

module "jobs" {
  source         = "./modules/scheduled-jobs"
  environment    = var.environment
  jobs           = var.jobs
  retention_days = var.job_log_retention_days
}
