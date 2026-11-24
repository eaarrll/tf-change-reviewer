environment = "prod"

documents_bucket_kms_key_arn = "arn:aws:kms:eu-west-1:123456789012:key/7b1e2f4c-93d0-4a8e-b6c1-2f5d8e0a9c31"
workflow_kms_key_id          = "alias/prod-documents"

workflows = {
  ingest       = { max_backlog = 5000, visibility_timeout = 300 }
  ocr          = { max_backlog = 2000, visibility_timeout = 900 }
  classify     = { max_backlog = 2000, visibility_timeout = 300 }
  redact       = { max_backlog = 1000, visibility_timeout = 600 }
  thumbnail    = { max_backlog = 5000, visibility_timeout = 120 }
  index        = { max_backlog = 3000, visibility_timeout = 300 }
  retention    = { max_backlog = 500, visibility_timeout = 900 }
  export       = { max_backlog = 500, visibility_timeout = 900 }
  notify       = { max_backlog = 10000, visibility_timeout = 60 }
  audit-replay = { max_backlog = 200, visibility_timeout = 900 }
}
