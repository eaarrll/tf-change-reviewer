variable "namespace" {
  type = string
}

variable "repositories" {
  type = map(object({
    scan_on_push = bool
    keep_images  = number
  }))
}

resource "aws_ecr_repository" "this" {
  for_each             = var.repositories
  name                 = "${var.namespace}/${each.key}"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = each.value.scan_on_push
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = {
    Service = each.key
  }
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each   = var.repositories
  repository = "${var.namespace}/${each.key}"

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 7 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 7
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the last ${each.value.keep_images} images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = each.value.keep_images
        }
        action = { type = "expire" }
      },
    ]
  })

  depends_on = [aws_ecr_repository.this]
}

output "repository_arns" {
  value = [for k in sort(keys(var.repositories)) : "arn:aws:ecr:eu-west-1:*:repository/${var.namespace}/${k}"]
}

output "repository_urls" {
  value = { for k, r in aws_ecr_repository.this : k => r.repository_url }
}
