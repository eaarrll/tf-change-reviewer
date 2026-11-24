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
  region = "us-east-1"

  default_tags {
    tags = {
      Project     = "billing"
      Environment = var.environment
      ManagedBy   = "terraform"
      Repository  = "acme/billing-infra"
      Team        = "billing-platform"
    }
  }
}
