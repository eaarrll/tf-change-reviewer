variable "environment" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "services" {
  type = list(string)
}

variable "target_sg_id" {
  type = string
}

variable "target_port" {
  type = number
}

variable "target_name" {
  type = string
}

resource "aws_security_group" "client" {
  for_each    = toset(var.services)
  name        = "${var.environment}-${each.key}-to-${var.target_name}"
  description = "${each.key} clients of ${var.target_name}"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "from_client" {
  for_each                     = toset(var.services)
  security_group_id            = var.target_sg_id
  referenced_security_group_id = aws_security_group.client[each.key].id
  ip_protocol                  = "tcp"
  from_port                    = var.target_port
  to_port                      = var.target_port
  description                  = "${each.key} to ${var.target_name}"
}

resource "aws_ssm_parameter" "client_sg" {
  for_each = toset(var.services)
  name     = "/${var.environment}/${each.key}/${var.target_name}-client-sg"
  type     = "String"
  value    = aws_security_group.client[each.key].id
}
