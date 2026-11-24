resource "aws_cloudwatch_metric_alarm" "dlq_not_empty" {
  for_each = var.queues

  alarm_name          = "${local.dlq_name[each.key]}-not-empty"
  alarm_description   = "Messages are landing in the ${each.key} dead-letter queue."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = local.dlq_name[each.key] }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = each.value.dlq_alarm_at
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "oldest_message" {
  for_each = var.queues

  alarm_name          = "${local.prefix}-${each.key}-oldest-message"
  alarm_description   = "Consumers of ${each.key} are falling behind."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = "${local.prefix}-${each.key}" }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 3
  threshold           = 900
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
}
