variable "cidr" {
  type    = string
  default = "10.40.10.0/24"
}

resource "terraform_data" "network" {
  triggers_replace = var.cidr
}

resource "terraform_data" "server" {
  triggers_replace = terraform_data.network.id
  input            = "web"
}

resource "terraform_data" "dns" {
  triggers_replace = terraform_data.server.id
}
