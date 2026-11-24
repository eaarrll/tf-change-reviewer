environment           = "prod"
aws_account_id        = "111122223333"
db_subnet_ids         = ["subnet-0c1a7e5d2b9f40a11", "subnet-0c1a7e5d2b9f40a12", "subnet-0c1a7e5d2b9f40a13"]
db_security_group_ids = ["sg-0f3e9d8c7b6a50412"]
alarm_topic_arn       = "arn:aws:sns:us-east-1:111122223333:commerce-prod-pager"

# orders database: source of truth for order history
orders_db_instance_class        = "db.r6g.xlarge"
orders_db_allocated_storage     = 500
orders_db_deletion_protection   = true
orders_db_skip_final_snapshot   = false
orders_db_backup_retention_days = 14

# inventory database
inventory_db_instance_class    = "db.r6g.large"
inventory_db_allocated_storage = 200

order_events = [
  "order.placed",
  "order.paid",
  "order.shipped",
  "order.cancelled",
  "order.returned",
  "order.refunded",
  "order.address-changed",
]

event_age_alarm_seconds = 300
