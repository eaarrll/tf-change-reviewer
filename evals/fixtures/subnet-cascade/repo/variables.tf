variable "environment" {
  type = string
}

variable "vpc_cidr" {
  type = string
}

variable "public_subnets" {
  description = "AZ => CIDR for the public (NAT/ALB) subnets."
  type        = map(string)
}

variable "private_subnets" {
  description = "AZ => CIDR for the private workload subnets."
  type        = map(string)
}

variable "flow_log_retention_days" {
  type    = number
  default = 30
}

variable "ledger_ami" {
  description = "Hardened Amazon Linux image for the ledger nodes, built by the image pipeline."
  type        = string
}

variable "ledger_instance_type" {
  type    = string
  default = "m7g.large"
}

variable "internal_services" {
  description = "Services that may reach the ledger nodes on 8443."
  type        = list(string)
}
