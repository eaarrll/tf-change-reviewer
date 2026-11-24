variable "region" {
  type    = string
  default = "eu-west-1"
}

variable "environment" {
  type = string
}

variable "account_id" {
  type = string
}

variable "queues" {
  description = "Work queues, keyed by domain. The key is part of the queue name: <env>-<key> and <env>-<key>-dlq."
  type = map(object({
    visibility_timeout = number
    retention_seconds  = number
    max_receive_count  = number
    dlq_alarm_at       = number
  }))
}

variable "alarm_topic_arn" {
  type = string
}
