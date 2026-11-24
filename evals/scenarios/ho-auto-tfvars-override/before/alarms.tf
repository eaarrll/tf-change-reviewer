locals {
  db_alarms = {
    cpu_high = {
      metric     = "CPUUtilization"
      statistic  = "Average"
      comparison = "GreaterThanThreshold"
    }
    connections_high = {
      metric     = "DatabaseConnections"
      statistic  = "Maximum"
      comparison = "GreaterThanThreshold"
    }
    free_storage_low = {
      metric     = "FreeStorageSpace"
      statistic  = "Minimum"
      comparison = "LessThanThreshold"
    }
    read_latency = {
      metric     = "ReadLatency"
      statistic  = "Average"
      comparison = "GreaterThanThreshold"
    }
    write_latency = {
      metric     = "WriteLatency"
      statistic  = "Average"
      comparison = "GreaterThanThreshold"
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "db" {
  for_each            = local.db_alarms
  alarm_name          = "${var.name}-prod-db-${replace(each.key, "_", "-")}"
  namespace           = "AWS/RDS"
  metric_name         = each.value.metric
  statistic           = each.value.statistic
  comparison_operator = each.value.comparison
  threshold           = var.alarm_thresholds[each.key]
  period              = 300
  evaluation_periods  = 3
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  dimensions = {
    DBInstanceIdentifier = aws_db_instance.ledger.identifier
  }
  tags = var.extra_tags
}
