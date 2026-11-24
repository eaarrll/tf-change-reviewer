resource "terraform_data" "keep" {
  input = "keep"
}

resource "terraform_data" "legacy" {
  input = "legacy"
}

resource "terraform_data" "also_keep" {
  input = "also"
}
