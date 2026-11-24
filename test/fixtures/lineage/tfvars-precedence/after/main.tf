variable "instance_size" {
  type    = string
  default = "small"
}

variable "replicas" {
  type = number
}

resource "terraform_data" "cluster" {
  triggers_replace = var.instance_size
  input            = var.replicas
}
