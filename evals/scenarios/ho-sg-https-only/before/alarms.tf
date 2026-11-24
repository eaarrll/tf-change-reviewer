resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${var.site_name}-${var.environment}-alb-5xx"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_ELB_5XX_Count"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 5
  threshold           = 50
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  dimensions = {
    LoadBalancer = module.alb.arn_suffix
  }
}

resource "aws_cloudwatch_metric_alarm" "target_latency" {
  for_each            = module.alb.target_group_arn_suffixes
  alarm_name          = "${var.site_name}-${var.environment}-${each.key}-latency"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  extended_statistic  = "p95"
  period              = 60
  evaluation_periods  = 5
  threshold           = 1.5
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = [var.alarm_topic_arn]
  dimensions = {
    LoadBalancer = module.alb.arn_suffix
    TargetGroup  = each.value
  }
}

resource "aws_cloudwatch_metric_alarm" "unhealthy_hosts" {
  for_each            = module.alb.target_group_arn_suffixes
  alarm_name          = "${var.site_name}-${var.environment}-${each.key}-unhealthy"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = [var.alarm_topic_arn]
  dimensions = {
    LoadBalancer = module.alb.arn_suffix
    TargetGroup  = each.value
  }
}
