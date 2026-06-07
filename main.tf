# 1. We tell Terraform that we want to use the Upstash provider to build our database.
terraform {
  required_providers {
    upstash = {
      source  = "upstash/upstash"
      version = "2.1.0"
    }
  }
}

# 2. We configure the provider with our login credentials (which we will hide in the variables file later).
provider "upstash" {
  email   = var.upstash_email
  api_key = var.upstash_api_key
}

# 3. This is the actual instruction to build a Serverless Redis database in AWS (Ireland region).
resource "upstash_redis_database" "matchmaking_db" {
  database_name  = "global-matchmaking-queue"
  region         = "global"
  primary_region = "eu-west-1"
  tls            = true
  eviction       = false
}