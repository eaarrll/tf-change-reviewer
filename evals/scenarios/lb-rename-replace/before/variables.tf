variable "environment" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "certificate_arn" {
  description = "ACM certificate for the storefront hostname."
  type        = string
}

variable "zone_id" {
  description = "Route 53 hosted zone of the storefront domain (managed by the dns stack)."
  type        = string
}

variable "hostname" {
  type = string
}

variable "services" {
  description = "Backends routed by path on the public load balancer."
  type = map(object({
    path_pattern      = string
    port              = number
    priority          = number
    health_check_path = string
  }))
}
