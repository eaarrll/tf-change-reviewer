environment     = "prod"
account_id      = "730415926611"
alarm_topic_arn = "arn:aws:sns:eu-west-1:730415926611:prod-oncall"

queues = {
  orders = {
    visibility_timeout = 90
    retention_seconds  = 345600
    max_receive_count  = 5
    dlq_alarm_at       = 1
  }
  "payments-v2" = {
    visibility_timeout = 120
    retention_seconds  = 1209600
    max_receive_count  = 3
    dlq_alarm_at       = 1
  }
  shipments = {
    visibility_timeout = 60
    retention_seconds  = 345600
    max_receive_count  = 5
    dlq_alarm_at       = 5
  }
  notifications = {
    visibility_timeout = 30
    retention_seconds  = 86400
    max_receive_count  = 10
    dlq_alarm_at       = 50
  }
  loyalty-points = {
    visibility_timeout = 45
    retention_seconds  = 345600
    max_receive_count  = 5
    dlq_alarm_at       = 10
  }
}
