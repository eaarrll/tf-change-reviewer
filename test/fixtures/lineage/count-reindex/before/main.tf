variable "names" {
  type = list(string)
}

resource "terraform_data" "bucket" {
  count            = length(var.names)
  triggers_replace = "acme-${var.names[count.index]}"
}
