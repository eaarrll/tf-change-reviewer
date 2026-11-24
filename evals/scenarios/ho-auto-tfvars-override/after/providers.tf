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
      Owner       = "data-platform"
      Environment = "prod"
      Stack       = "ledger-db"
      ManagedBy   = "terraform"
    }
  }
}
