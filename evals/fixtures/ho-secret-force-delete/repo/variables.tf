variable "app" {
  type    = string
  default = "partner-gateway"
}

variable "kms_key_arn" {
  description = "Application CMK (from the security baseline stack)."
  type        = string
}

variable "sync_jobs" {
  description = "Scheduled partner sync jobs: name => schedule expression."
  type        = map(string)
}

variable "queue_retention_seconds" {
  type    = number
  default = 604800
}
