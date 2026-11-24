resource "aws_kms_key" "documents" {
  description             = "Customer documents at rest (S3, SQS, SSM)"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

resource "aws_kms_alias" "documents" {
  name          = "alias/${var.environment}-documents"
  target_key_id = aws_kms_key.documents.key_id
}

resource "aws_kms_key" "logs" {
  description             = "CloudWatch Logs for the documents platform"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

resource "aws_kms_alias" "logs" {
  name          = "alias/${var.environment}-documents-logs"
  target_key_id = aws_kms_key.logs.key_id
}
