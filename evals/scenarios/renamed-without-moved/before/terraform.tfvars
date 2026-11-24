environment = "prod"

services = {
  cart          = { log_retention_days = 30, visibility_timeout = 30, max_receive_count = 5 }
  pricing       = { log_retention_days = 30, visibility_timeout = 30, max_receive_count = 5 }
  payments      = { log_retention_days = 90, visibility_timeout = 120, max_receive_count = 3 }
  fulfillment   = { log_retention_days = 30, visibility_timeout = 300, max_receive_count = 5 }
  invoicing     = { log_retention_days = 90, visibility_timeout = 120, max_receive_count = 3 }
  notifications = { log_retention_days = 14, visibility_timeout = 30, max_receive_count = 10 }
  promotions    = { log_retention_days = 14, visibility_timeout = 30, max_receive_count = 5 }
  returns       = { log_retention_days = 30, visibility_timeout = 120, max_receive_count = 5 }
}
