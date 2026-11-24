variable "bucket_name" {
  type    = string
  default = "orders-archive"
}

module "app" {
  source      = "./modules/app"
  bucket_name = var.bucket_name
}
