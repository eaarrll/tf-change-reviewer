resource "aws_cloudwatch_dashboard" "ledger_db" {
  dashboard_name = "${var.name}-prod-db"
  dashboard_body = jsonencode({
    widgets = [
      for i, key in keys(local.db_alarms) : {
        type   = "metric"
        x      = (i % 3) * 8
        y      = floor(i / 3) * 6
        width  = 8
        height = 6
        properties = {
          title   = replace(key, "_", " ")
          region  = "eu-west-1"
          stat    = local.db_alarms[key].statistic
          period  = 300
          metrics = [["AWS/RDS", local.db_alarms[key].metric, "DBInstanceIdentifier", aws_db_instance.ledger.identifier]]
          annotations = {
            horizontal = [{ label = "alarm", value = var.alarm_thresholds[key] }]
          }
        }
      }
    ]
  })
}
