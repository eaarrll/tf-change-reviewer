data "aws_iam_policy_document" "orders_rw" {
  statement {
    sid = "OrdersTable"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:Query",
    ]
    resources = [
      aws_dynamodb_table.orders.arn,
      "${aws_dynamodb_table.orders.arn}/index/*",
    ]
  }

  statement {
    sid       = "Exports"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.exports.arn}/*"]
  }
}

resource "aws_iam_policy" "orders_rw" {
  name        = "${var.environment}-checkout-orders-rw"
  description = "Read/write access to the orders table and export bucket."
  policy      = data.aws_iam_policy_document.orders_rw.json
}

output "orders_table_name" {
  value = aws_dynamodb_table.orders.name
}
