variable "environment" {
  type = string
}

variable "account_id" {
  type = string
}

variable "artifact_bucket" {
  description = "Bucket holding the dispatcher Lambda bundles built by CI."
  type        = string
}

variable "dispatcher_version" {
  description = "Dispatcher bundle version deployed to every channel."
  type        = string
}

variable "template_version" {
  description = "Message template set the dispatchers render (TEMPLATE_VERSION)."
  type        = string
}

variable "log_retention_days" {
  type = number
}

variable "channels" {
  description = "Delivery channels: one queue, dead-letter queue, dispatcher Lambda and log group each."
  type = map(object({
    timeout     = number
    memory      = number
    concurrency = number
  }))
}
