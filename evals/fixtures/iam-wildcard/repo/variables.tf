variable "region" {
  type    = string
  default = "eu-central-1"
}

variable "environment" {
  type = string
}

variable "account_id" {
  description = "Workload account. Kept as a variable so plans need no STS call."
  type        = string
}

variable "reports_bucket" {
  type = string
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "services" {
  description = "Analytics jobs: an execution role scoped to its own queue and parameters, and a log group."
  type = map(object({
    principal = string
  }))
}
