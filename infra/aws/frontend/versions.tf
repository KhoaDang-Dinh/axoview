terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# CloudFront requires its ACM viewer certificate in us-east-1.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}
