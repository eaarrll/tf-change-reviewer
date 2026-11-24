module "current" {
  source = "./modules/current"
}

module "old" {
  source = "./modules/old"
  name   = "legacy-reports"
}
