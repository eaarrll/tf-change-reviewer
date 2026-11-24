output "queue_urls" {
  value = { for k, q in aws_sqs_queue.main : k => q.url }
}
