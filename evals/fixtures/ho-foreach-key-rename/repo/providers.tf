terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "commerce-events"
      Environment = var.environment
      ManagedBy   = "terraform"
      Team        = "commerce-core"
      Runbook     = "https://wiki.acme.example/runbooks/commerce-events"
    }
  }
}
