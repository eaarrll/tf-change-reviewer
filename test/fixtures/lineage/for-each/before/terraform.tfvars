base_services = ["billing", "ledger", "legacy"]

queues = {
  orders  = { visibility = 30 }
  refunds = { visibility = 60 }
}
