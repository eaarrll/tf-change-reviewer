variable "name" {
  description = "Prefix for the subnet group, parameter group and security group."
  type        = string
}

variable "identifier" {
  description = "RDS DB instance identifier (becomes part of the endpoint hostname)."
  type        = string
}

variable "engine_version" {
  type = string
}

variable "instance_class" {
  type = string
}

variable "allocated_storage" {
  type = number
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  type = list(string)
}

variable "client_security_groups" {
  type = list(string)
}

variable "tags" {
  type    = map(string)
  default = {}
}
