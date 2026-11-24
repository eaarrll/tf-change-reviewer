variable "prefix" {
  description = "SSM path prefix, e.g. /payments/prod."
  type        = string
}

variable "settings" {
  type = map(string)
}

resource "aws_ssm_parameter" "setting" {
  for_each = var.settings
  name     = "${var.prefix}/${each.key}"
  type     = "String"
  value    = each.value
}

output "parameter_names" {
  value = [for p in aws_ssm_parameter.setting : p.name]
}
