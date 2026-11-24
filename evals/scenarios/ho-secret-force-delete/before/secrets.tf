resource "aws_secretsmanager_secret" "db_credentials" {
  name                    = "${var.app}/prod/db-credentials"
  description             = "Gateway Postgres credentials (rotated by the platform rotator)."
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = 30
}

resource "aws_secretsmanager_secret" "webhook_signing" {
  name                    = "${var.app}/prod/webhook-signing-key"
  description             = "HMAC key used to sign outbound partner webhooks."
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = 30
}

resource "aws_secretsmanager_secret" "acme_partner_api" {
  name                    = "${var.app}/prod/acme-partner-api"
  description             = "OAuth client for the ACME wholesale API (legacy v1 integration)."
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "acme_partner_api" {
  secret_id = aws_secretsmanager_secret.acme_partner_api.id
  secret_string = jsonencode({
    client_id     = "REPLACE_ME"
    client_secret = "REPLACE_ME"
    token_url     = "https://auth.acme-wholesale.example/oauth2/token"
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_secretsmanager_secret" "sftp_key" {
  name                    = "${var.app}/prod/sftp-private-key"
  description             = "SSH key for the nightly invoice SFTP drop."
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = 14
}
