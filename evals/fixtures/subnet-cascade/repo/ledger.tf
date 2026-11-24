locals {
  # Ledger nodes are pinned to AZs; two in eu-west-1a hold the primary shards.
  ledger_nodes = {
    "ledger-a1" = "eu-west-1a"
    "ledger-a2" = "eu-west-1a"
    "ledger-b1" = "eu-west-1b"
    "ledger-c1" = "eu-west-1c"
  }
}

resource "aws_security_group" "ledger" {
  name        = "${var.environment}-ledger"
  description = "Ledger nodes"
  vpc_id      = module.vpc.vpc_id
}

resource "aws_vpc_security_group_egress_rule" "ledger_all" {
  security_group_id = aws_security_group.ledger.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_instance" "ledger" {
  for_each               = local.ledger_nodes
  ami                    = var.ledger_ami
  instance_type          = var.ledger_instance_type
  subnet_id              = module.vpc.private_subnet_ids[each.value]
  vpc_security_group_ids = [aws_security_group.ledger.id]

  root_block_device {
    volume_size = 200
    volume_type = "gp3"
    encrypted   = true
  }

  metadata_options {
    http_tokens = "required"
  }

  tags = {
    Name = "${var.environment}-${each.key}"
    Role = "ledger"
  }
}
