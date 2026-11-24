variable "bucket_name" {
  type = string
}

module "store" {
  source = "../store"
  name   = "${var.bucket_name}-v2"
}
