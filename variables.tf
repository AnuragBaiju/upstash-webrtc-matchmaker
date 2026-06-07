# 1. This tells Terraform to expect a variable named "upstash_email"
variable "upstash_email" {
  type        = string
  description = "The email address associated with your Upstash account"
}

# 2. This tells Terraform to expect a variable named "upstash_api_key"
variable "upstash_api_key" {
  type        = string
  description = "The management API key for your Upstash account"
  sensitive   = true # This prevents Terraform from printing your secret key out on the screen
}