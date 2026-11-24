variable "name" {
  type = string
}

variable "db_instance_class" {
  type = string
}

variable "db_engine_version" {
  type = string
}

variable "db_allocated_storage" {
  type = number
}

variable "db_kms_key_arn" {
  description = "CMK for RDS storage encryption (owned by the security account stack)."
  type        = string
}

variable "db_backup_retention_days" {
  type    = number
  default = 7
}

variable "db_subnet_ids" {
  type = list(string)
}

variable "vpc_id" {
  type = string
}

variable "allowed_cidrs" {
  description = "Private CIDRs of the application subnets."
  type        = list(string)
}

variable "alarm_topic_arn" {
  description = "Ops SNS topic from the monitoring stack."
  type        = string
}

variable "alarm_thresholds" {
  type = map(number)
  default = {
    cpu_high         = 80
    connections_high = 400
    free_storage_low = 10737418240
    read_latency     = 0.02
    write_latency    = 0.05
    disk_queue_depth = 64
  }
}

variable "extra_tags" {
  type    = map(string)
  default = {}
}
