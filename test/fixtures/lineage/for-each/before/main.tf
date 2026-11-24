locals {
  services = concat(var.base_services, ["audit"])
}

module "svc" {
  source   = "./modules/svc"
  for_each = toset(local.services)

  name = each.key
}

resource "terraform_data" "queue" {
  for_each         = var.queues
  triggers_replace = "${each.key}-${each.value.visibility}"
}
