# Sample PR comment

The comment below is the real output for the `subnet-cascade` eval fixture (rules only, no AI review),
regenerated with:

```sh
npx tsx src/cli.ts review --plan evals/fixtures/subnet-cascade/plan.json \
  --repo evals/fixtures/subnet-cascade/repo --root-dir . \
  --diff evals/fixtures/subnet-cascade/pr.diff --format markdown --rules-only
```

In a pull request, every `file:line` is a permalink at the head commit (base commit for deleted code).

---

<!-- tf-change-reviewer -->
## 🔎 Terraform change review

**1 finding needs your attention** (3 changes, of 43 in the plan)
**+6** create · **\~33** update · **−0** destroy · **±4** replace

1 finding (1 critical) covering 3 changes; all changes by severity: 1 critical, 2 high, 1 medium, 6 low, 33 noise. Lines this PR changed that cause them: terraform.tfvars:11 (3 changes).

#### 🔴 Critical · `module.vpc.aws_subnet.private["eu-west-1a"]`

**Subnet prod-payments-private-eu-west-1a will be destroyed and re-created (and 2 related changes)** · ±replace

**Why it matters:** cidr_block "10.40.10.0/24" → "10.40.16.0/20" forces replacement (a subnet's CIDR block cannot change; AWS creates a new subnet): the subnet is destroyed and re-created, and everything with a network interface in it (databases, clusters, load balancers, instances) must be replaced too.

**Why it happens:** cidr_block "10.40.10.0/24" → "10.40.16.0/20" forces replacement; it comes from aws_subnet.private for_each (modules/vpc/main.tf:49), from module "vpc" argument private_subnets (main.tf:6), from private_subnets in terraform.tfvars (terraform.tfvars:11, changed in this PR).

**Cause chain:** `cidr_block` ← `modules/vpc/main.tf:52` ← `modules/vpc/main.tf:49` ← `main.tf:6` ← **`terraform.tfvars:11`** ✏️ · ✏️ changed in this PR

**Same cause, also changes (2):**
- `aws_instance` ±replace ×2: `aws_instance.ledger["ledger-a1"]`, `aws_instance.ledger["ledger-a2"]`

<details><summary>How this was traced (5 steps)</summary>

1. aws\_subnet.private cidr\_block · `modules/vpc/main.tf:52` · `cidr_block        = each.value`
2. aws\_subnet.private for\_each · `modules/vpc/main.tf:49` · `for_each          = var.private_subnets`
3. module "vpc" argument private\_subnets · `main.tf:6` · `private_subnets         = var.private_subnets`
4. variable "private\_subnets" (no default) · `variables.tf:14-17` · `variable "private_subnets" {   description = "AZ => CIDR for the private workload subnets."   type        = map(string) }`
5. ✏️ **private\_subnets in terraform.tfvars** · `terraform.tfvars:11` · `private_subnets = {   "eu-west-1a" = "10.40.16.0/20"   "eu-west-1b" = "10.40.11.0/24"   "eu-west-1c" = "10.40.12.0/24" }`

</details>

<sub>rules: `identity-replace` · confidence: high · raised by: rules</sub>

- [ ] Confirmed: this needs attention <!-- finding:4ddb832fb593 -->

<details><summary>Other changes (40)</summary>

**🟡 Medium (1)**

- `module.vpc.aws_route_table_association.private["eu-west-1a"]` · ±replace · subnet\_id follows module.vpc.aws\_subnet.private\["eu-west-1a"\], which is replaced, and it cannot move to another subnet, so aws\_route\_table\_association is destroyed and re-created too.

**⚪ Low (6)**

- 2 × `module.service_access.aws_security_group.client[*]` · +create
- 2 × `module.service_access.aws_ssm_parameter.client_sg[*]` · +create
- 2 × `module.service_access.aws_vpc_security_group_ingress_rule.from_client[*]` · +create

**🔇 Noise (33)**

- 30 tag-only updates (`aws_security_group` ×6, `aws_ssm_parameter` ×5, `aws_subnet` ×5, 9 more types)
- 2 `aws_instance` updates changing `root_block_device`, `tags_all`: `aws_instance.ledger["ledger-b1"]`, `aws_instance.ledger["ledger-c1"]`
- 1 `aws_cloudwatch_log_group` update changing `retention_in_days`, `tags_all`: `module.vpc.aws_cloudwatch_log_group.flow_logs`

</details>

---

💬 Tick **Confirmed** on each finding that really needs attention. Missed something? Reply `missed: <address>` (one per line) in a PR comment or review.

<sub>🤖 tf-change-reviewer 0.1.0 · rules only (no AI review)</sub>

<!-- tf-change-reviewer:data {"v":1,"findings":[{"id":"4ddb832fb593","address":"module.vpc.aws_subnet.private[\"eu-west-1a\"]","severity":"critical","origin":"rules","root":"","related":["aws_instance.ledger[\"ledger-a1\"]","aws_instance.ledger[\"ledger-a2\"]"]}]} -->
