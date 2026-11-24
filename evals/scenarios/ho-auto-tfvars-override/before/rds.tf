resource "aws_db_subnet_group" "ledger" {
  name       = "${var.name}-mysql"
  subnet_ids = var.db_subnet_ids
}

resource "aws_security_group" "ledger_db" {
  name        = "${var.name}-mysql"
  description = "MySQL for ${var.name}"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "app" {
  for_each          = toset(var.allowed_cidrs)
  security_group_id = aws_security_group.ledger_db.id
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 3306
  to_port           = 3306
  description       = "MySQL from app subnet ${each.value}"
}

resource "aws_db_parameter_group" "ledger" {
  name_prefix = "${var.name}-mysql80-"
  family      = "mysql8.0"
  description = "ledger MySQL 8.0"

  parameter {
    name  = "slow_query_log"
    value = "1"
  }

  parameter {
    name  = "long_query_time"
    value = "2"
  }

  parameter {
    name         = "binlog_format"
    value        = "ROW"
    apply_method = "pending-reboot"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_db_instance" "ledger" {
  identifier                      = "${var.name}-prod"
  engine                          = "mysql"
  engine_version                  = var.db_engine_version
  instance_class                  = var.db_instance_class
  allocated_storage               = var.db_allocated_storage
  storage_type                    = "io1"
  iops                            = 6000
  storage_encrypted               = true
  kms_key_id                      = var.db_kms_key_arn
  db_name                         = "ledger"
  username                        = "ledger_admin"
  manage_master_user_password     = true
  db_subnet_group_name            = aws_db_subnet_group.ledger.name
  vpc_security_group_ids          = [aws_security_group.ledger_db.id]
  parameter_group_name            = aws_db_parameter_group.ledger.name
  multi_az                        = true
  backup_retention_period         = var.db_backup_retention_days
  enabled_cloudwatch_logs_exports = ["error", "slowquery"]
  deletion_protection             = true
  skip_final_snapshot             = false
  final_snapshot_identifier       = "${var.name}-prod-final"
}
