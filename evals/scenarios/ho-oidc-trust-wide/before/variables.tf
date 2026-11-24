variable "region" {
  type    = string
  default = "eu-west-1"
}

variable "environment" {
  type = string
}

variable "account_id" {
  description = "AWS account that owns the GitHub OIDC provider (created by the org-bootstrap stack)."
  type        = string
}

variable "ecr_namespace" {
  type = string
}

variable "ecr_repositories" {
  description = "Service images pushed by GitHub Actions. keep_images = how many tagged images the lifecycle policy keeps."
  type = map(object({
    scan_on_push = bool
    keep_images  = number
  }))
}

variable "deploy_role_subjects" {
  description = "GitHub OIDC token subjects (repo:<org>/<repo>:ref:<ref>) allowed to assume the deploy role."
  type        = list(string)
}

variable "ecs_cluster_name" {
  type = string
}

variable "deploy_log_retention_days" {
  type    = number
  default = 90
}
