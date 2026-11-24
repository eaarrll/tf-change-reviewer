variable "name" {
  type = string
}

resource "terraform_data" "bucket" {
  triggers_replace = var.name
}
