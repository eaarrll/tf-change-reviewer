output "ecr_repository_urls" {
  value = module.ecr.repository_urls
}

output "deploy_role_name" {
  value = module.github_deploy_role.role_name
}
