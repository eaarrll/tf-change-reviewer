# Archive pipeline, retired in Q3.
resource "terraform_data" "archive" {
  input = {
    bucket = "acme-archive"
    days   = 365
  }
}
