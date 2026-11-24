variable "name" {
  type = string
}

variable "environment" {
  type = string
}

variable "instance_class" {
  type = string
}

variable "allocated_storage" {
  type = number
}

variable "subnet_ids" {
  type = list(string)
}

variable "security_group_ids" {
  type = list(string)
}

variable "alarm_topic_arn" {
  type = string
}

variable "engine_version" {
  type    = string
  default = "16.4"
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "skip_final_snapshot" {
  type    = bool
  default = false
}

variable "backup_retention_period" {
  type    = number
  default = 7
}

variable "slow_query_ms" {
  description = "log_min_duration_statement: log statements slower than this many milliseconds."
  type        = number
  default     = 2000
}

locals {
  identifier = "${var.name}-${var.environment}"
}

resource "aws_db_subnet_group" "this" {
  name       = local.identifier
  subnet_ids = var.subnet_ids
}

resource "aws_db_parameter_group" "this" {
  name        = "${local.identifier}-pg16"
  family      = "postgres16"
  description = "${var.name} Postgres 16 settings"

  parameter {
    name  = "log_min_duration_statement"
    value = tostring(var.slow_query_ms)
  }

  parameter {
    name  = "idle_in_transaction_session_timeout"
    value = "60000"
  }

  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }
}

resource "aws_cloudwatch_log_group" "postgres" {
  name              = "/aws/rds/instance/${local.identifier}/postgresql"
  retention_in_days = 30
}

resource "aws_db_instance" "this" {
  identifier     = local.identifier
  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class

  allocated_storage     = var.allocated_storage
  max_allocated_storage = var.allocated_storage * 2
  storage_type          = "gp3"
  storage_encrypted     = true

  username                    = "app_admin"
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = var.security_group_ids
  parameter_group_name   = aws_db_parameter_group.this.name
  multi_az               = true

  backup_retention_period   = var.backup_retention_period
  backup_window             = "03:00-04:00"
  maintenance_window        = "sun:04:30-sun:05:30"
  copy_tags_to_snapshot     = true
  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = var.skip_final_snapshot
  final_snapshot_identifier = "${local.identifier}-final"

  enabled_cloudwatch_logs_exports = ["postgresql"]
  performance_insights_enabled    = true

  depends_on = [aws_cloudwatch_log_group.postgres]
}

resource "aws_cloudwatch_metric_alarm" "cpu" {
  alarm_name          = "${local.identifier}-cpu-high"
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = [var.alarm_topic_arn]
  dimensions = {
    DBInstanceIdentifier = aws_db_instance.this.identifier
  }
}

resource "aws_cloudwatch_metric_alarm" "free_storage" {
  alarm_name          = "${local.identifier}-free-storage-low"
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 2
  threshold           = var.allocated_storage * 1073741824 * 0.1
  comparison_operator = "LessThanThreshold"
  alarm_actions       = [var.alarm_topic_arn]
  dimensions = {
    DBInstanceIdentifier = aws_db_instance.this.identifier
  }
}

output "identifier" {
  value = aws_db_instance.this.identifier
}
