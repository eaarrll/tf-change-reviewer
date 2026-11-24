variable "environment" {
  description = "Deployment environment name."
  type        = string
}

variable "documents_bucket_kms_key_arn" {
  description = "KMS key ARN for SSE on the documents bucket (set when the bucket was imported in 2024)."
  type        = string
}

variable "workflow_kms_key_id" {
  description = "KMS key (id, ARN or alias) for the workflow queues and SecureString parameters."
  type        = string
}

variable "workflows" {
  description = "Document workflows: each gets a queue, an encrypted settings parameter and a backlog alarm."
  type = map(object({
    max_backlog        = number
    visibility_timeout = number
  }))
}

variable "alarm_evaluation_periods" {
  description = "Consecutive 5-minute periods above the backlog threshold before the alarm fires."
  type        = number
  default     = 2
}
