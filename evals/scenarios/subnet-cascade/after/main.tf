module "vpc" {
  source                  = "./modules/vpc"
  name                    = "${var.environment}-payments"
  cidr                    = var.vpc_cidr
  public_subnets          = var.public_subnets
  private_subnets         = var.private_subnets
  flow_log_retention_days = var.flow_log_retention_days
}

module "service_access" {
  source            = "./modules/service-access"
  environment       = var.environment
  vpc_id            = module.vpc.vpc_id
  services          = var.internal_services
  target_sg_id      = aws_security_group.ledger.id
  target_port       = 8443
  target_name       = "ledger"
}
