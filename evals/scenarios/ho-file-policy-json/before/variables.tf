variable "environment" {
  type = string
}

variable "log_retention_days" {
  type = number
}

variable "pipelines" {
  description = "Log pipelines: one log group and one subscription queue per entry."
  type        = map(number)
}
