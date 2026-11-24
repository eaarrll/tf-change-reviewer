environment = "prod"
site_name   = "storefront"

vpc_id            = "vpc-0f3e2d1c0b9a87654"
vpc_cidr          = "10.20.0.0/16"
public_subnet_ids = ["subnet-0d1e2f3a4b5c6d701", "subnet-0d1e2f3a4b5c6d702", "subnet-0d1e2f3a4b5c6d703"]
certificate_arn   = "arn:aws:acm:eu-west-1:345678901234:certificate/0b7e5a42-1c9d-4f3e-8a26-7d5c4b3a2e10"

frontends = ["web", "checkout", "account"]

alarm_topic_arn = "arn:aws:sns:eu-west-1:345678901234:web-oncall"
