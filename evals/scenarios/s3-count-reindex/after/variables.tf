variable "region" {
  type    = string
  default = "eu-west-1"
}

variable "environment" {
  type = string
}

variable "data_buckets" {
  description = "Data lake buckets, one per dataset. Bucket name is acme-<env>-<dataset>."
  type        = list(string)
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "pipelines" {
  description = "Ingest pipelines: one queue, log group and backlog alarm each."
  type = map(object({
    visibility_timeout = number
    max_backlog        = number
  }))
}
