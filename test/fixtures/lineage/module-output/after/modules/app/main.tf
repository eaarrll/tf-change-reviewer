variable "subnet" {
  type = string
}

variable "name" {
  type = string
}

resource "terraform_data" "server" {
  triggers_replace = var.subnet
  input            = var.name
}
