locals {
  name_prefix = "${var.service}-${var.environment}"

  # Naming standard (PLAT-212): <env>-<region>-<service>-<engine>
  db_identifier = "${var.environment}-${var.region_short}-${var.service}-pg"

  common_tags = {
    Service = var.service
  }
}
