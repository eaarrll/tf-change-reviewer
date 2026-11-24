variable "name" {
  type = string
}

resource "terraform_data" "role" {
  triggers_replace = "svc-${var.name}"
}
