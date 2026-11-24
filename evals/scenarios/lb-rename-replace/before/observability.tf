resource "aws_cloudwatch_log_group" "svc" {
  for_each          = var.services
  name              = "/storefront/${var.environment}/${each.key}"
  retention_in_days = 30
}

resource "aws_cloudwatch_metric_alarm" "target_5xx" {
  for_each            = var.services
  alarm_name          = "${var.environment}-storefront-${each.key}-5xx"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = { TargetGroup = aws_lb_target_group.svc[each.key].arn_suffix, LoadBalancer = aws_lb.public.arn_suffix }
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 5
  threshold           = 25
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
}
