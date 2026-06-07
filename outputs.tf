# 1. This prints out the clean endpoint address of our new Redis database
output "redis_endpoint" {
  value       = upstash_redis_database.matchmaking_db.endpoint
  description = "The endpoint URL of the created Upstash Redis database"
}

# 2. This prints out the secret password needed to connect to the database
output "redis_password" {
  value       = upstash_redis_database.matchmaking_db.password
  description = "The password for the Upstash Redis database"
  sensitive   = true # Keeps it hidden from plain view in standard logs
}

output "redis_rest_token" {
  value       = upstash_redis_database.matchmaking_db.rest_token
  description = "The REST API token for serverless HTTP connections"
  sensitive   = true
}