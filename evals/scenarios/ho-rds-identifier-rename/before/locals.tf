locals {
  name_prefix   = "${var.service}-${var.environment}"
  db_identifier = "${var.service}-${var.environment}"

  common_tags = {
    Service = var.service
  }
}
