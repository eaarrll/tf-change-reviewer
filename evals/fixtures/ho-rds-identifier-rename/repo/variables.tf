variable "service" {
  description = "Short service name used in resource names."
  type        = string
}

variable "environment" {
  description = "Deployment environment (prod, staging)."
  type        = string
}

variable "region_short" {
  description = "Short region code used in names, e.g. euw1."
  type        = string
}

variable "vpc_id" {
  description = "VPC from the network stack (remote state output, pinned here)."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private data subnets from the network stack."
  type        = list(string)
}

variable "app_security_group_id" {
  description = "Security group of the payments ECS services."
  type        = string
}

variable "db_instance_class" {
  type = string
}

variable "db_engine_version" {
  type = string
}

variable "db_allocated_storage" {
  type    = number
  default = 200
}

variable "workers" {
  description = "Background workers that get a queue and a log group."
  type        = list(string)
}

variable "app_settings" {
  description = "Non-secret runtime settings published to SSM for the services."
  type        = map(string)
}
