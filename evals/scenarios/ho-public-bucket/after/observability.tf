resource "aws_cloudwatch_log_group" "customer_export" {
  name              = "/storefront/${var.environment}/customer-export"
  retention_in_days = var.app_log_retention_days
}

resource "aws_cloudwatch_log_group" "web_deploy" {
  name              = "/storefront/${var.environment}/web-deploy"
  retention_in_days = var.app_log_retention_days
}

resource "aws_ssm_parameter" "static_bucket" {
  name  = "/storefront/${var.environment}/static-bucket"
  type  = "String"
  value = var.static_bucket_name
}

resource "aws_ssm_parameter" "export_prefix" {
  name  = "/storefront/${var.environment}/customer-export-prefix"
  type  = "String"
  value = "s3://${var.static_bucket_name}/exports/customers/"
}

module "service_runtime" {
  source   = "./modules/service-runtime"
  for_each = var.services

  environment        = var.environment
  service            = each.key
  log_retention_days = var.app_log_retention_days
  settings           = each.value
}
