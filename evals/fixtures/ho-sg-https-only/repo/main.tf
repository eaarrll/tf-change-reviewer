module "alb" {
  source = "./modules/public-alb"

  name       = "${var.site_name}-${var.environment}"
  vpc_id     = var.vpc_id
  vpc_cidr   = var.vpc_cidr
  subnet_ids = var.public_subnet_ids
  app_port   = var.app_port
  services   = var.frontends

  certificate_arn = var.certificate_arn
}

resource "aws_cloudwatch_log_group" "frontend" {
  for_each          = toset(var.frontends)
  name              = "/ecs/${var.site_name}/${each.key}"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "edge" {
  for_each = {
    access     = 90
    edge-auth  = 14
    csp-report = 14
  }
  name              = "/${var.site_name}/${var.environment}/${each.key}"
  retention_in_days = each.value
}
