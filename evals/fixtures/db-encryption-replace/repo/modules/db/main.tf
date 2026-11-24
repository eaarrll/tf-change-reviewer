variable "name" {
  type = string
}

variable "engine_version" {
  type = string
}

variable "instance_class" {
  type = string
}

variable "encrypted" {
  type    = bool
  default = true
}

locals {
  identifier = "${var.name}-prod"
}

resource "aws_db_instance" "this" {
  identifier              = local.identifier
  engine                  = "postgres"
  engine_version          = var.engine_version
  instance_class          = var.instance_class
  allocated_storage       = 100
  storage_encrypted       = var.encrypted
  username                = "app"
  password                = "not-a-real-password-123"
  backup_retention_period = 7
  skip_final_snapshot     = false
  deletion_protection     = true
}

output "endpoint" {
  value = aws_db_instance.this.endpoint
}
