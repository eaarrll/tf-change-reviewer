module "alb" {
  source = "./modules/public-alb"

  name       = "${var.site_name}-${var.environment}"
  vpc_id     = var.vpc_id
  vpc_cidr   = var.vpc_cidr
  subnet_ids = var.public_subnet_ids
  app_port   = var.app_port
  services   = var.frontends
}

resource "aws_cloudwatch_log_group" "frontend" {
  for_each          = toset(var.frontends)
  name              = "/ecs/${var.site_name}/${each.key}"
  retention_in_days = 30
}
