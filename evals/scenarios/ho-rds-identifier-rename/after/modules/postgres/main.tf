resource "aws_db_subnet_group" "this" {
  name        = "${var.name}-db"
  description = "Private data subnets for ${var.name}"
  subnet_ids  = var.subnet_ids
  tags        = var.tags
}

resource "aws_security_group" "db" {
  name        = "${var.name}-db"
  description = "Postgres access for ${var.name}"
  vpc_id      = var.vpc_id
  tags        = var.tags
}

resource "aws_vpc_security_group_ingress_rule" "clients" {
  for_each                     = toset(var.client_security_groups)
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "Postgres from application tasks"
}

resource "aws_db_parameter_group" "this" {
  name        = "${var.name}-pg16"
  family      = "postgres16"
  description = "Postgres 16 parameters for ${var.name}"

  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  parameter {
    name  = "idle_in_transaction_session_timeout"
    value = "60000"
  }

  tags = var.tags
}

resource "aws_db_instance" "this" {
  identifier                      = var.identifier
  engine                          = "postgres"
  engine_version                  = var.engine_version
  instance_class                  = var.instance_class
  allocated_storage               = var.allocated_storage
  max_allocated_storage           = var.allocated_storage * 2
  storage_type                    = "gp3"
  storage_encrypted               = true
  db_name                         = "payments"
  username                        = "payments_admin"
  manage_master_user_password     = true
  db_subnet_group_name            = aws_db_subnet_group.this.name
  vpc_security_group_ids          = [aws_security_group.db.id]
  parameter_group_name            = aws_db_parameter_group.this.name
  multi_az                        = true
  backup_retention_period         = 14
  backup_window                   = "02:00-03:00"
  maintenance_window              = "sun:03:30-sun:04:30"
  enabled_cloudwatch_logs_exports = ["postgresql"]
  performance_insights_enabled    = true
  copy_tags_to_snapshot           = true
  skip_final_snapshot             = false
  final_snapshot_identifier       = "${var.name}-final"
  deletion_protection             = true
  tags                            = var.tags
}
