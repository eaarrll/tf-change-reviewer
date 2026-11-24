variable "name" {
  type = string
}

variable "environment" {
  type = string
}

variable "keep_images" {
  type = number
}

variable "log_retention_days" {
  type = number
}

resource "aws_ecr_repository" "this" {
  name                 = "billing/${var.name}"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "this" {
  repository = aws_ecr_repository.this.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last ${var.keep_images} images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = var.keep_images
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/${var.environment}/${var.name}"
  retention_in_days = var.log_retention_days
}
