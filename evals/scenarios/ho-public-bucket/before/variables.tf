variable "environment" {
  type = string
}

variable "account_id" {
  type = string
}

variable "static_bucket_name" {
  description = "Bucket for front-end build output. Historically also receives the nightly customer exports (see storage.tf)."
  type        = string
}

variable "access_log_bucket_name" {
  type = string
}

variable "asset_noncurrent_days" {
  type    = number
  default = 30
}

variable "customer_export_expiry_days" {
  description = "How long nightly customer exports (PII: names, emails, order totals) are kept."
  type        = number
  default     = 90
}

variable "access_log_expiry_days" {
  type    = number
  default = 365
}

variable "app_log_retention_days" {
  type    = number
  default = 30
}

variable "services" {
  description = "Storefront services and their runtime settings (published to SSM)."
  type        = map(map(string))
}
