locals {
  allowed_db_cidrs = var.db_public ? ["0.0.0.0/0"] : var.office_cidrs
}

resource "aws_security_group" "db" {
  name        = "billing-${var.environment}-postgres"
  description = "Billing Postgres cluster"
  vpc_id      = var.vpc_id

  ingress {
    description = "Postgres from billing services"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = var.app_subnet_cidrs
  }

  ingress {
    description = "Postgres from office and VPN"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = local.allowed_db_cidrs
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "billing-${var.environment}-postgres"
  }
}

module "service" {
  source   = "./modules/service"
  for_each = var.services

  name               = each.key
  environment        = var.environment
  keep_images        = each.value.keep_images
  log_retention_days = var.log_retention_days
}
