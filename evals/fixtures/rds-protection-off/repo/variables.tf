variable "environment" {
  type = string
}

variable "aws_account_id" {
  type = string
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "db_subnet_ids" {
  description = "Private data-tier subnets shared by every database in this stack."
  type        = list(string)
}

variable "db_security_group_ids" {
  type = list(string)
}

# orders database

variable "orders_db_instance_class" {
  type = string
}

variable "orders_db_allocated_storage" {
  type = number
}

variable "orders_db_deletion_protection" {
  type    = bool
  default = true
}

variable "orders_db_skip_final_snapshot" {
  type    = bool
  default = false
}

variable "orders_db_backup_retention_days" {
  type    = number
  default = 14
}

# inventory database

variable "inventory_db_instance_class" {
  type = string
}

variable "inventory_db_allocated_storage" {
  type = number
}

# order event fan-out

variable "order_events" {
  description = "Domain events published by the orders service; each gets an EventBridge rule and a consumer queue."
  type        = list(string)
}

variable "event_age_alarm_seconds" {
  description = "Alarm when the oldest message in a consumer queue is older than this."
  type        = number
  default     = 300
}

variable "alarm_topic_arn" {
  type = string
}
