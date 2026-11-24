variable "replicas" {
  type    = number
  default = 2
}

variable "image" {
  type    = string
  default = "web:1.4.0"
}

resource "terraform_data" "node" {
  count = var.replicas
  input = var.image
}

resource "terraform_data" "notes" {
  input = "runbook v1"
}
