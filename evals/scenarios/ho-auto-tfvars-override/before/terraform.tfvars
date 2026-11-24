name = "ledger"

db_instance_class        = "db.m6g.2xlarge"
db_engine_version        = "8.0.39"
db_allocated_storage     = 500
db_kms_key_arn           = "arn:aws:kms:eu-west-1:210987654321:key/3f1c9a2e-7b44-4d8e-9a61-5c2d8e0f4b17"
db_backup_retention_days = 14

vpc_id        = "vpc-07d1c2b3a4e5f6a71"
db_subnet_ids = ["subnet-04a1b2c3d4e5f6071", "subnet-04a1b2c3d4e5f6072", "subnet-04a1b2c3d4e5f6073"]
allowed_cidrs = ["10.40.16.0/20", "10.40.32.0/20", "10.40.48.0/20"]

alarm_topic_arn = "arn:aws:sns:eu-west-1:210987654321:ops-pager"
