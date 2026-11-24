module "net" {
  source = "./modules/net"
}

module "app" {
  source = "./modules/app"
  subnet = module.net.subnet_cidr
  name   = "billing"
}
