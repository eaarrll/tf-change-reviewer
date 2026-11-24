variable "office_cidrs" {
  type    = list(string)
  default = ["203.0.113.0/24"]
}

variable "extra_rules" {
  type = map(object({ port = number, cidrs = list(string) }))
  default = {
    https = { port = 443, cidrs = ["10.0.0.0/8"] }
  }
}

resource "aws_security_group" "db" {
  name        = "billing-db"
  description = "Billing database"

  ingress {
    description = "app subnets"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = ["10.40.0.0/16"]
  }

  ingress {
    description = "office"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = var.office_cidrs
  }

  dynamic "ingress" {
    for_each = var.extra_rules
    content {
      description = ingress.key
      from_port   = ingress.value.port
      to_port     = ingress.value.port
      protocol    = "tcp"
      cidr_blocks = ingress.value.cidrs
    }
  }
}
