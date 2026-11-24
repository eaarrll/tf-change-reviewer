locals {
  prefix = "${var.env}-${local.region_short}"
  name   = "${local.prefix}-orders"
}

resource "terraform_data" "queue" {
  triggers_replace = local.name
  input            = { team = "payments" }
}
