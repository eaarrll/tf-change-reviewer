environment = "prod"
vpc_cidr    = "10.40.0.0/16"

public_subnets = {
  "eu-west-1a" = "10.40.0.0/24"
  "eu-west-1b" = "10.40.1.0/24"
  "eu-west-1c" = "10.40.2.0/24"
}

private_subnets = {
  "eu-west-1a" = "10.40.10.0/24"
  "eu-west-1b" = "10.40.11.0/24"
  "eu-west-1c" = "10.40.12.0/24"
}

ledger_ami = "ami-0c1a7f2e5b3d49e61"

internal_services = [
  "card-auth",
  "card-capture",
  "refunds",
  "disputes",
  "settlement",
]
