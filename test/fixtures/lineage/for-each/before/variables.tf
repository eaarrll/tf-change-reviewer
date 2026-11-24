variable "base_services" {
  type = list(string)
}

variable "queues" {
  type = map(object({ visibility = number }))
}
