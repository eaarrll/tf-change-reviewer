locals {
  cidr = "10.40.10.0/24"
}

output "subnet_cidr" {
  value = local.cidr
}
