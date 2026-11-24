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
  region = "eu-west-1"

  default_tags {
    tags = {
      Project     = "storefront"
      Environment = var.environment
      ManagedBy   = "terraform"
      Owner       = "team-storefront"
    }
  }
}
