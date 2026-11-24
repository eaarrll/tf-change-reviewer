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
  region = "eu-west-2"

  default_tags {
    tags = {
      Project     = "notifications"
      Environment = var.environment
      Team        = "messaging"
      ManagedBy   = "terraform"
      CostCenter  = "cc-comms-118"
    }
  }
}
