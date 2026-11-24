variable "environment" {
  type = string
}

variable "private_subnet_ids" {
  description = "Private subnets from the network stack."
  type        = list(string)
}

variable "image_repository" {
  type = string
}

variable "api_image_tag" {
  type = string
}

variable "api_desired_count" {
  description = "Running tasks for the public catalog API."
  type        = number
}

variable "worker_image_tag" {
  type = string
}

variable "worker_desired_count" {
  type = number
}

variable "jobs" {
  description = "Scheduled maintenance jobs (EventBridge schedules)."
  type = map(object({
    schedule = string
    enabled  = bool
  }))
}

variable "job_log_retention_days" {
  type    = number
  default = 14
}
