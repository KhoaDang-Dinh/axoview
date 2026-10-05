variable "aws_region" {
  description = "Region used for regional resources and state-adjacent lookups."
  type        = string
}

variable "domain_name" {
  description = "Public apex/custom domain served by CloudFront, for example example.com."
  type        = string
}

variable "route53_zone_id" {
  description = "Route 53 public hosted zone id for domain_name."
  type        = string
}

variable "api_origin_host" {
  description = "TLS hostname of the EKS ALB origin, for example origin.example.com."
  type        = string
}

variable "frontend_bucket_name" {
  description = "Globally unique private S3 bucket name that stores the built frontend."
  type        = string
}

variable "price_class" {
  description = "CloudFront price class."
  type        = string
  default     = "PriceClass_200"
}
