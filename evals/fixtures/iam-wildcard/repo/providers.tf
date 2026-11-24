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
      Project     = "analytics"
      Environment = var.environment
      ManagedBy   = "terraform"
      CostCenter  = "cc-analytics-210"
      DataOwner   = "analytics-eng"
    }
  }
}
