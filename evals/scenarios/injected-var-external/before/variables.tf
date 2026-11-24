variable "environment" {
  type = string
}

variable "db_subnet_ids" {
  description = "Database subnets from the network stack."
  type        = list(string)
}

variable "db_instance_class" {
  type    = string
  default = "db.r6g.xlarge"
}

variable "restore_snapshot_identifier" {
  description = "Only for disaster-recovery restores: create the database from this snapshot."
  type        = string
  default     = null
}

variable "services" {
  description = "Reporting services that get app/access log groups and an error metric filter."
  type        = list(string)
}

variable "log_retention_days" {
  type    = number
  default = 30
}
