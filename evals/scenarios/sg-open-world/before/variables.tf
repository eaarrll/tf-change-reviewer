variable "environment" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "app_subnet_cidrs" {
  description = "Private subnets the billing services run in."
  type        = list(string)
}

variable "office_cidrs" {
  description = "Office and VPN egress ranges allowed to reach the database directly."
  type        = list(string)
}

variable "db_public" {
  description = "Open the database port to any address instead of office_cidrs."
  type        = bool
  default     = false
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "services" {
  description = "Container services: ECR repository, log group and image-tag parameter each."
  type = map(object({
    keep_images = number
  }))
}
