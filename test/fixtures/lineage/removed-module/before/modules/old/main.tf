variable "name" {
  type = string
}

resource "terraform_data" "bucket" {
  input = var.name
}

module "inner" {
  source = "./inner"
}
