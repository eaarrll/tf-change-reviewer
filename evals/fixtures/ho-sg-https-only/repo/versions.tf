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
      Environment = var.environment
      Team        = "web-experience"
      ManagedBy   = "terraform"
      Service     = var.site_name
      Tier        = "public-edge"
    }
  }
}
