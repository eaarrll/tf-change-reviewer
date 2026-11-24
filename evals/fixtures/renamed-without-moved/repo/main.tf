module "messaging" {
  source      = "./modules/messaging"
  environment = var.environment
  services    = var.services
}

output "queue_urls" {
  value = module.messaging.queue_urls
}
