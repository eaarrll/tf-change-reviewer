module "ecr" {
  source       = "./modules/ecr"
  namespace    = var.ecr_namespace
  repositories = var.ecr_repositories
}

module "github_deploy_role" {
  source = "./modules/github-oidc-role"

  name                = "gha-deploy-${var.environment}"
  account_id          = var.account_id
  allowed_subjects    = var.deploy_role_subjects
  ecr_repository_arns = module.ecr.repository_arns
  ecs_cluster_name    = var.ecs_cluster_name
}

resource "aws_cloudwatch_log_group" "deploy_audit" {
  name              = "/ci/${var.environment}/deploys"
  retention_in_days = var.deploy_log_retention_days
}

resource "aws_ssm_parameter" "deploy_role_arn" {
  name  = "/ci/${var.environment}/deploy-role-arn"
  type  = "String"
  value = "arn:aws:iam::${var.account_id}:role/gha-deploy-${var.environment}"
}
