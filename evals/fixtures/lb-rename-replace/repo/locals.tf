locals {
  # Naming standard v2: <env>-<app>-<region code>
  name = "${var.environment}-sf-${var.region_code}"
}
