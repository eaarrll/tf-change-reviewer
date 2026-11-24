locals {
  cidr = "10.40.16.0/20"
}

output "subnet_cidr" {
  value = local.cidr
}
