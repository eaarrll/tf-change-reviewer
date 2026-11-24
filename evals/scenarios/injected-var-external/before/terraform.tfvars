environment   = "prod"
db_subnet_ids = ["subnet-03b9e2c7d41a6f580", "subnet-0f61a8d3e9c2b7014", "subnet-0c4d7e1b2a9f36d85"]

services = [
  "ingest-api",
  "etl-orders",
  "etl-payments",
  "etl-inventory",
  "aggregator",
  "report-builder",
  "scheduler",
  "exporter",
  "dashboard-api",
  "alerting",
  "data-quality",
  "lineage",
  "cost-allocation",
  "forecasting",
  "anomaly-detector",
  "partner-feeds",
]

log_retention_days = 30
