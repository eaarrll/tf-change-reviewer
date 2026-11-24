environment        = "prod"
account_id         = "444455556666"
artifact_bucket    = "acme-notifications-artifacts"
dispatcher_version = "3.14.2"
template_version   = "2026.10.2"
log_retention_days = 14

channels = {
  "email"         = { timeout = 30, memory = 512, concurrency = 50 }
  "sms"           = { timeout = 15, memory = 256, concurrency = 20 }
  "push-ios"      = { timeout = 15, memory = 256, concurrency = 40 }
  "push-android"  = { timeout = 15, memory = 256, concurrency = 40 }
  "webhook"       = { timeout = 60, memory = 256, concurrency = 25 }
  "in-app"        = { timeout = 10, memory = 256, concurrency = 60 }
  "digest-daily"  = { timeout = 300, memory = 1024, concurrency = 5 }
  "digest-weekly" = { timeout = 300, memory = 1024, concurrency = 2 }
}
