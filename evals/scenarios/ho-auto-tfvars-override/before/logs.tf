resource "aws_cloudwatch_log_group" "rds" {
  for_each          = toset(["error", "slowquery"])
  name              = "/aws/rds/instance/${var.name}-prod/${each.key}"
  retention_in_days = 90
  tags              = var.extra_tags
}
