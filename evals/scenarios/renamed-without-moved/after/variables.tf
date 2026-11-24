variable "environment" {
  description = "Deployment environment name."
  type        = string
}

variable "services" {
  description = "Checkout services that get a work queue, a dead-letter queue and a log group."
  type = map(object({
    log_retention_days = number
    visibility_timeout = number
    max_receive_count  = number
  }))
}
