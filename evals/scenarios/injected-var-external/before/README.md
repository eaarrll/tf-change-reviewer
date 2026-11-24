# reporting-infra

Infrastructure for the reporting platform: the reporting Postgres database and the
log groups / error metric filters of every reporting service.

## Layout

- `main.tf`: module calls
- `modules/postgres`: RDS instance, subnet group, parameter group, alarms
- `modules/service-logs`: per-service log groups and error metric filters

## Deploying

CI runs `terraform plan` on every pull request and `terraform apply` on merge to `main`.
Variables come from `terraform.tfvars`.
