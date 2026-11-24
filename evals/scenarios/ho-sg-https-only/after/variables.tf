variable "region" {
  type    = string
  default = "eu-west-1"
}

variable "environment" {
  type = string
}

variable "site_name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "vpc_cidr" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "certificate_arn" {
  description = "ACM certificate for www (issued by the dns stack)."
  type        = string
}

variable "app_port" {
  type    = number
  default = 8080
}

variable "frontends" {
  description = "Frontend services behind the ALB."
  type        = list(string)
}

variable "alarm_topic_arn" {
  type = string
}
