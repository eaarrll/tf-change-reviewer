# Research: materiality taxonomy for plan changes (AWS v6, azurerm, google)

This is a materiality rule set for tf-change-reviewer, built from primary sources. Each rule gives the trigger condition with exact plan-JSON and provider attribute names, a severity, and a one-line reason a reviewer would care.

**How it was verified**

- **Plan JSON fields:** read from hashicorp/terraform internal/command/jsonplan/plan.go and jsonconfig/config.go (main branch).
- **Local experiment:** run with the installed Terraform v1.10.5 using the built-in `terraform_data` resource (no provider download).
- **Replacement attributes:** extracted mechanically from provider source. I grepped every `ForceNew: true`, `customdiff.ForceNewIf` / `ForceNewIfChange` and `diff.ForceNew()` call in:
  - terraform-provider-aws main (about v6.74.0, released 2026-11-23) and tag v5.100.0
  - terraform-provider-azurerm main (about v5.15.0, which uses the new `resources/<name>/r_schema.go` layout)
  - terraform-provider-google main (about v8.12.0)
- **In-place risk rules:** come from the provider docs and the AWS RDS "Settings for DB instances" downtime table.

**Findings that correct the brief's assumptions**

1. **`aws_db_instance.identifier` does not force replacement** in v5.100.0 or v6. It is renamed in place via `NewDBInstanceIdentifier`. The endpoint changes, and AWS documents downtime.
2. **`aws_db_instance.engine` does force replacement; `engine_version` does not.** `engine_version` changes in place, and AWS documents downtime.
3. **`db_subnet_group_name` differs by resource.** On `aws_db_instance` it changes in place (with downtime). On `aws_rds_cluster`, `aws_docdb_cluster` and `aws_rds_cluster_instance` it forces replacement.
4. **`aws_eks_cluster.vpc_config.subnet_ids` changes in place** (via `UpdateClusterConfig`). `aws_eks_cluster.role_arn` and `access_config.bootstrap_cluster_creator_admin_permissions` force replacement.
5. **Removing a module call yields `action_reason` `delete_because_no_resource_config`, not `delete_because_no_module`.** Verified locally. `delete_because_no_module` only appears when a module instance disappears because the module's `count`/`for_each` shrank.
6. **`forget` is emitted on 1.10.5.** It appears as `["forget"]` with `action_reason` `delete_because_no_resource_config`, even though the public JSON-format doc does not list it.
7. **`lifecycle` is not in the plan JSON configuration.** So `prevent_destroy`, `ignore_changes` and `create_before_destroy` must be read from HCL or the PR diff.
8. **Sensitive values appear in plaintext in `terraform show -json`.** Verified with a canary value.

## Findings

- **[high] [PLAN-01] Base severity is the action type multiplied by the resource's stateful tier** — Trigger: change.actions contains "delete" (exact lists: ["delete"], ["delete","create"], ["create","delete"]). "create" and "delete" only ever co-occur as a replace. Severity: Tier-A data-holding types (see the AWS-/AZ-/GCP- rules) are CRITICAL. Tier-B identity/addressing types (aws_lb, aws_route53_zone, aws_iam_role, aws_kms_key, aws_secretsmanager_secret, aws_sqs_queue, aws_acm_certificate, aws_cognito_user_pool, aws_ecr_repository) are HIGH to CRITICAL. Tier-C cattle (instances in an ASG, node groups, task definitions, lambda versions) is MEDIUM. ["create","delete"] (create_before_destroy) lowers outage severity by one level but never lowers data-loss severity. Reason: replace means a new object, so data, IDs, endpoints and ARNs change. All action strings come from jsonplan actionString(): no-op, create, read, update, delete, [delete,create], [create,delete], forget, [forget,create], [create,forget].  
  Sources: https://github.com/hashicorp/terraform/blob/main/internal/command/jsonplan/plan.go, https://developer.hashicorp.com/terraform/internals/json-format
- **[high] [PLAN-02] replace_because_cannot_update plus replace_paths is where the lineage trace starts** — Trigger: action_reason == "replace_because_cannot_update". change.replace_paths is an array of paths, and each step is a string attribute name, a number index, or (for set elements) the JSON-encoded element value, because encodePath marshals cty.IndexStep keys of any type. Severity: inherit PLAN-01, then add the attribute-specific reason from the ForceNew tables below. Reason: this tells the reviewer which attribute forced replacement. Next, resolve configuration.root_module.resources[].expressions.<attr> → {references:[...]} or constant_value, then module_calls.<name>.expressions.<var>.references in the parent, then the changed PR line. Verified locally: terraform_data triggers_replace produced replace_paths [["triggers_replace"]].  
  Sources: https://github.com/hashicorp/terraform/blob/main/internal/command/jsonplan/plan.go, https://github.com/hashicorp/terraform/blob/main/internal/command/jsonconfig/config.go, Local experiment: Terraform v1.10.5, terraform_data, terraform show -json
- **[medium] [PLAN-03] A replacement that cannot be traced to the PR diff is a surprise replacement** — Trigger: replace (PLAN-02) where the lineage walk from replace_paths reaches no changed .tf line and no changed tfvars value. Typical dead-ends:
- a data source, e.g. data.aws_ami with most_recent=true feeding aws_instance.ami (ForceNew);
- resource_drift on the same address;
- a provider version bump (.terraform.lock.hcl changed);
- launch_template.version "$Latest"/"$Default" on aws_instance (diff.ForceNew("launch_template.0.version") when the LT version moved).
  Severity: one level above the PLAN-01 base, capped at CRITICAL. Tier-A is always CRITICAL. Reason: nobody intended it, and reviewers will not spot it in the PR diff.  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/ec2/ec2_instance.go
- **[high] [PLAN-04] delete_because_no_resource_config: the resource block or the whole module call was removed** — Trigger: actions ["delete"] with action_reason "delete_because_no_resource_config". Group by module_address. If every instance under a module_address has this reason and the call is missing from configuration.root_module.module_calls, report it as "module removed" (verified locally: removing `module "m"` gave this reason, not delete_because_no_module). Severity: max of the member severities (PLAN-01). HIGH minimum if any Tier-A is included, then escalated to CRITICAL. Reason: deleting a block also bypasses prevent_destroy (Terraform docs: the rule doesn't stop destruction if you remove the configuration).  
  Sources: Local experiment: Terraform v1.10.5, terraform_data, terraform show -json, https://developer.hashicorp.com/terraform/language/meta-arguments/lifecycle, https://developer.hashicorp.com/terraform/internals/json-format
- **[high] [PLAN-05] delete_because_no_module: a module's count or for_each shrank** — Trigger: action_reason == "delete_because_no_module". Verified: module "mc" count 2→1 produced module.mc[1].* ["delete"] with this reason. Severity: CRITICAL if any member is Tier-A, otherwise HIGH (a whole environment or tenant stamp is going away). Reason: one numeric or map change in the parent tears down an entire module instance.  
  Sources: Local experiment: Terraform v1.10.5, terraform_data, terraform show -json, https://github.com/hashicorp/terraform/blob/main/internal/command/jsonplan/plan.go
- **[high] [PLAN-06] delete_because_count_index or delete_because_each_key: re-indexing churn** — Trigger: action_reason in {"delete_because_count_index","delete_because_each_key"} (both verified locally). Re-index heuristic: the same resource type and name also has creates at other index keys whose `after` closely matches the deleted `before`. That means an element was removed from the middle of a count list, shifting every later index. Severity: CRITICAL for Tier-A, HIGH when 3 or more instances are touched, otherwise MEDIUM. Reason: the fix is a moved block or switching to for_each; without one, healthy objects get destroyed. Also flag delete_because_wrong_repetition (count↔for_each switched without moved blocks) as HIGH/CRITICAL, and delete_because_no_move_target (a moved target is missing) as HIGH.  
  Sources: Local experiment: Terraform v1.10.5, terraform_data, terraform show -json, https://developer.hashicorp.com/terraform/internals/json-format
- **[high] [PLAN-07] forget action: a removed block with lifecycle destroy = false** — Trigger: change.actions == ["forget"] (verified on 1.10.5, with action_reason "delete_because_no_resource_config"). Also handle ["forget","create"] and ["create","forget"] from actionString. Severity:
- ["forget"] is MEDIUM: the object keeps running and costing money but is no longer managed, so confirm the handoff.
- ["forget","create"] / ["create","forget"] is HIGH: a duplicate object is created, with name collisions or two live copies.
  Reason: the public json-format doc does not list "forget", and terraform-json issue #125 reported it missing. Parse unknown action strings defensively rather than crashing.  
  Sources: Local experiment: Terraform v1.10.5, terraform_data, terraform show -json, https://github.com/hashicorp/terraform/blob/main/internal/command/jsonplan/plan.go, https://developer.hashicorp.com/terraform/language/block/removed, https://github.com/hashicorp/terraform-json/issues/125
- **[high] [PLAN-08] Tainted, user-requested, and trigger-driven replacements** — Trigger and severity:
- replace_because_tainted (verified; replace_paths absent): MEDIUM, or CRITICAL for Tier-A. A failed or partial earlier apply, or a manual taint, means data written since creation would be lost.
- replace_by_request (from -replace; verified): MEDIUM, explicit intent but confirm.
- replace_by_triggers (lifecycle.replace_triggered_by; verified, replace_paths absent): severity by type. Trace the trigger reference from HCL, because lifecycle is not in the plan JSON.
  Note: a provider-level triggers attribute (terraform_data.triggers_replace, null_resource.triggers) shows as replace_because_cannot_update, not replace_by_triggers.  
  Sources: Local experiment: Terraform v1.10.5, terraform_data, terraform show -json, https://developer.hashicorp.com/terraform/internals/json-format
- **[high] [PLAN-09] moved and import blocks are noise unless they are combined with a destructive action** — Trigger: resource_changes[].previous_address is set and actions == ["no-op"] → NOISE (a pure moved block; verified). previous_address is set but actions include delete → HIGH (the move did not absorb the change). change.importing present (verified: {"id":"abc"}): with no-op it is LOW (adoption), with update it is MEDIUM (the adopted object is modified on its first apply), and importing together with delete or replace is HIGH.  
  Sources: Local experiment: Terraform v1.10.5, terraform_data, terraform show -json, https://developer.hashicorp.com/terraform/internals/json-format
- **[medium] [PLAN-10] The plan would revert drift (resource_drift)** — Trigger: an address appears in resource_drift AND in resource_changes with actions ["update"] or a replace, and the drifted leaf paths overlap the planned changed paths. relevant_attributes lists the drifted {resource, attribute} pairs that feed the plan. Severity:
- HIGH when the drifted path is security-relevant (SG rules, IAM or resource policy, public-access flags, KMS policy), because it may revert a console hotfix;
- HIGH when it is a capacity value managed by autoscaling (aws_autoscaling_group.desired_capacity, aws_ecs_service.desired_count, aws_eks_node_group.scaling_config.desired_size), because the plan would scale back down;
- otherwise MEDIUM.
  Reason: the change is not in the PR, but apply will undo someone's out-of-band action.  
  Sources: https://developer.hashicorp.com/terraform/internals/json-format, https://github.com/hashicorp/terraform/blob/main/internal/command/jsonplan/plan.go
- **[medium] [PLAN-11] Mass destroy and plan-health banner** — Trigger: count resource_changes with "delete" in actions, replaces included and forget excluded. HIGH if the count is ≥5 or more than 20% of managed instances in prior_state; CRITICAL if any Tier-A delete exists, whatever the count. These thresholds are tunable, not sourced. Also emit a banner when errored==true, applyable==false, or complete==false (deferred_changes present). Reason: one place to see the destroy blast radius, and a warning that the plan is partial.  
  Sources: https://github.com/hashicorp/terraform/blob/main/internal/command/jsonplan/plan.go
- **[medium] [PLAN-12] Provider or module version bump causing mass diffs** — Trigger: the PR diff touches .terraform.lock.hcl or a module `version` / `source` ref, or configuration.provider_config._.version_constraint or module_calls._.version_constraint changed, AND many updates where every changed leaf was null or absent in `before` (new defaulted attributes). Severity: LOW, aggregated into one line. But any replace in the same plan whose replace_paths attribute is not touched by the PR is HIGH, as a provider-induced replacement (PLAN-03). Reason: schema and default changes produce noisy churn, while hidden ForceNew changes ride along.  
  Sources: https://github.com/hashicorp/terraform/blob/main/internal/command/jsonconfig/config.go
- **[high] [PLAN-13] prevent_destroy removed in the PR diff** — Trigger: the PR diff removes or sets false `prevent_destroy = true` inside a lifecycle block, AND the same address has delete or replace in the plan. Lifecycle is NOT serialized in the plan JSON configuration (jsonconfig resource fields are only address, mode, type, name, provider_config_key, provisioners, expressions, schema_version, count/for_each, depends_on), so this must come from HCL or the diff. Severity: CRITICAL. Reason: someone deliberately disarmed the guard so the destroy can proceed. With prevent_destroy still in place, Terraform "rejects plans that would destroy" and you would never see this plan.  
  Sources: https://github.com/hashicorp/terraform/blob/main/internal/command/jsonconfig/config.go, https://developer.hashicorp.com/terraform/language/meta-arguments/lifecycle
- **[high] [PLAN-14] Unknowns flowing from a replacement inherit its severity; they are not noise** — Trigger: an update whose only changed leaves are in change.after_unknown ("all unknown leaf values replaced with true"), where the config expression for those attributes has references to an address that is being replaced, e.g. aws_instance.vpc_security_group_ids → aws_security_group being replaced. Verified: references appear as expressions.<attr>.references, e.g. ["terraform_data.s.id","terraform_data.s"]. Severity: the upstream severity minus one level (blast radius). If the unknown attribute is ForceNew on the downstream type, use full upstream severity, because a cascade replace is coming. Reason: this is how one replace fans out.  
  Sources: https://developer.hashicorp.com/terraform/internals/json-format, Local experiment: Terraform v1.10.5, terraform_data, terraform show -json
- **[high] [AWS-01] aws_db_instance: attributes that force replacement (verified v5.100.0 and v6)** — Trigger: replace with replace_paths in: availability_zone, backup_target, character_set_name, custom_iam_instance_profile, db_name, engine, kms_key_id, nchar_character_set_name, restore_to_point_in_time, s3_import.{bucket_name,bucket_prefix,ingestion_role,source_engine,source_engine_version}, snapshot_identifier, storage_encrypted, timezone, username. Conditional: multi_tenant true→false (customdiff.ForceNewIf). Severity: CRITICAL. Reason: a new instance is created from scratch, or from a snapshot, losing data written since; endpoint and identity change. Unless after.skip_final_snapshot==false, no final snapshot is taken.
  NOT ForceNew: identifier (renamed in place via ModifyDBInstance NewDBInstanceIdentifier), engine_version, instance_class, db_subnet_group_name, allocated_storage, storage_type (see AWS-U rules).  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/rds/instance.go, https://github.com/hashicorp/terraform-provider-aws/blob/v5.100.0/internal/service/rds/instance.go
- **[high] [AWS-02] aws_db_instance.identifier change renames in place, changing the endpoint and causing downtime** — Trigger: actions ["update"] with before.identifier != after.identifier. Severity: HIGH. Reason: the hostname in `address`/`endpoint` changes, so every consumer's connection string breaks, and the AWS settings table lists downtime for DB instance identifier changes. With apply_immediately=false the rename is deferred to the maintenance window, which is a surprise later.  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/rds/instance.go, https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ModifyInstance.Settings.html
- **[high] [AWS-03] aws_rds_cluster (Aurora / Multi-AZ cluster): attributes that force replacement, plus the availability_zones trap** — Trigger: replace_paths in: availability_zones, cluster_identifier, cluster_identifier_prefix, cluster_scalability_type, database_name, db_subnet_group_name, db_system_id, engine, engine_mode, kms_key_id, master_username, restore_to_point_in_time._, s3_import._, snapshot_identifier, source_region, storage_encrypted. publicly_accessible is ForceNew on main (v6) but not in v5.100.0. Conditional: storage_type is ForceNew when engine does not start with "aurora". Severity: CRITICAL. Reason: the whole cluster and its data are recreated. Provider docs: if fewer than 3 availability_zones are configured, RDS assigns 3, which "will show as a difference requiring resource recreation". Annotate as a known perpetual diff and suggest 3 AZs or ignore_changes, but keep it CRITICAL because apply really does replace.  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/rds/cluster.go, https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/rds_cluster.html.markdown
- **[high] [AWS-04] aws_rds_cluster_instance: replacement means the instance is recreated and a failover may occur** — Trigger: replace_paths in: availability_zone, cluster_identifier, custom_iam_instance_profile, db_subnet_group_name, engine, identifier, identifier_prefix. Severity: HIGH (CRITICAL if it is the only instance or the writer). Reason: cluster data survives, but the instance endpoint goes away. Replacing the writer forces failover, and a single-instance cluster has an outage.  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/rds/cluster_instance.go
- **[high] [AWS-05] aws_dynamodb_table: attributes that force replacement** — Trigger: replace_paths in: name, hash_key, range_key, local_secondary_index (and every nested field), import_table.s3_bucket_source, restore_date_time, restore_to_latest_time. Conditional ForceNewIfChange: restore_source_name, restore_source_table_arn, restore_backup_arn. Severity: CRITICAL. Reason: the table and all items are dropped. Key schema and LSIs cannot be changed after creation. Note: attribute definitions and GSIs update in place, which is MEDIUM (index rebuild).  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/dynamodb/table.go
- **[high] [AWS-06] aws_s3_bucket: replacement and object_lock_enabled differences between provider majors** — Trigger: replace_paths in bucket, bucket_prefix, or bucket_namespace (v6 only). object_lock_enabled: on v6 it forces replacement only when true→false (customdiff.ForceNewIf); on v5.100.0 any change, including false→true, forces replacement. Severity: CRITICAL, and if before.force_destroy==true all objects, including locked ones, are deleted. Reason: provider docs say force_destroy deletes objects that "are _not_ recoverable". Read the provider version from .terraform.lock.hcl to pick the rule set.  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/s3/bucket.go, https://github.com/hashicorp/terraform-provider-aws/blob/v5.100.0/internal/service/s3/bucket.go, https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/s3_bucket.html.markdown
- **[high] [AWS-07] aws_instance: replacement triggers that surprise people** — Trigger: replace_paths in: ami, associate_public_ip_address, availability_zone, subnet_id, key_name, private_ip, security_groups (the name-based list, NOT vpc_security_group_ids), tenancy, host_id, ebs_optimized, hibernation, ephemeral_block_device, instance_market_options._, launch_template.{id,name}, root_block_device.{encrypted,kms_key_id}, ebs_block_device._ (device_name, volume_size, volume_type, iops, throughput, encrypted, kms_key_id, snapshot_id, delete_on_termination), network_interface.*, private_dns_name_options, enclave_options.enabled, cpu_options.amd_sev_snp. v5.100.0 also has cpu_core_count, cpu_threads_per_core and cpu_options.{core_count,threads_per_core}.
  Conditional replacements:
- user_data / user_data_base64 only when user_data_replace_on_change==true;
- instance_type only when old and new types share no CPU architecture (x86↔arm64);
- enable_primary_ipv6 true→false;
- ipv6_addresses;
- placement_group / placement_group_id / placement_partition_number;
- launch_template.version when "$Latest"/"$Default" moved.
  Severity: HIGH for a singleton; CRITICAL if it holds data on root or ebs_block_device; MEDIUM if in an ASG. Reason: the root volume is lost (delete_on_termination), and the private IP and instance ID change.  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/ec2/ec2_instance.go, https://github.com/hashicorp/terraform-provider-aws/blob/v5.100.0/internal/service/ec2/ec2_instance.go, https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/instance.html.markdown
- **[high] [AWS-08] aws_ebs_volume and aws_efs_file_system: replacement loses data** — Trigger:
- aws_ebs_volume replace_paths in availability_zone, encrypted, kms_key_id, multi_attach_enabled, outpost_arn, snapshot_id;
- aws_efs_file_system replace_paths in availability_zone_name, creation_token, encrypted, kms_key_id, performance_mode;
- delete of either.
  Severity: CRITICAL. Reason: the block or file data is destroyed, and enabling encryption on an existing volume or filesystem is a replace, not an in-place toggle. Also: aws_volume_attachment delete is HIGH (the volume is detached from a running instance), and aws_efs_mount_target replace is HIGH (mounts drop).  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/ec2/ebs_volume.go, https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/efs/file_system.go
- **[high] [AWS-09] aws_elasticache_replication_group and aws_elasticache_cluster: attributes that force replacement** — Trigger for replication_group: replace_paths in at_rest_encryption_enabled, data_tiering_enabled, durability (v6), global_replication_group_id, kms_key_id, network_type, port, replication_group_id, security_group_names, snapshot_arns, snapshot_name, subnet_group_name. Conditional:
- transit_encryption_enabled when engine_version_actual < 7.0.5;
- engine or engine_version downgrade (customizeDiffEngine*ForceNewOnDowngrade);
- node_group_configuration explicitly set or changed.
  Trigger for cluster: availability_zone, cluster_id, engine, network_type, outpost_mode, port, preferred_outpost_arn, replication_group_id, snapshot_arns, snapshot_name, subnet_group_name, transit_encryption_enabled; and node_type when engine is memcached (no vertical scaling).
  Severity: HIGH (CRITICAL if Redis/Valkey is used as a primary store with persistence). Reason: the cache is flushed and the primary endpoint changes.  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/elasticache/replication_group.go, https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/elasticache/cluster.go
- **[high] [AWS-10] aws_memorydb_cluster: replacement means a durable datastore is lost** — Trigger: replace_paths in auto_minor_version_upgrade (a surprise: ForceNew), data_tiering, multi_region_cluster_name, kms_key_arn, name, name_prefix, network_type, port, snapshot_arns, snapshot_name, subnet_group_name, tls_enabled. Severity: CRITICAL. Reason: MemoryDB is a durable primary database, not a cache.  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/memorydb/cluster.go
- **[high] [AWS-11] aws_opensearch_domain: replacement destroys indices** — Trigger: replace_paths in domain_name, encrypt_at_rest.kms_key_id, vpc_options. Conditional (customdiff.ForceNewIf):
- engine_version not in GetCompatibleVersions targets;
- encrypt_at_rest.enabled or node_to_node_encryption.enabled true→false, or any change on an engine version without in-place encryption support;
- advanced_security_options.enabled true→false;
- ip_address_type dualstack→other.
  Severity: CRITICAL. Reason: all indices and data are lost and the endpoint changes. In-place cluster_config changes trigger a blue/green deployment, which is MEDIUM.  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/opensearch/domain.go
- **[high] [AWS-12] aws_redshift_cluster, aws_docdb_cluster, aws_neptune_cluster: attributes that force replacement** — Trigger:
- redshift: cluster_identifier, cluster_subnet_group_name, master_username, snapshot_arn, snapshot_cluster_identifier, snapshot_identifier;
- docdb: availability_zones, cluster_identifier(_prefix), db_subnet_group_name, engine, kms_key_id, master_username, port (surprise), restore_to_point_in_time.*, snapshot_identifier, storage_encrypted, plus serverless_v2_scaling_configuration removal;
- neptune: availability_zones, cluster_identifier(_prefix), engine, kms_key_arn, neptune_subnet_group_name, port (surprise), snapshot_identifier, storage_encrypted.
  Severity: CRITICAL. Reason: the warehouse or graph data is recreated. Changing the port is a replace on DocDB and Neptune.  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/redshift/cluster.go, https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/docdb/cluster.go, https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/neptune/cluster.go
- **[high] [AWS-13] aws_msk_cluster: replacement loses topics and changes the bootstrap brokers** — Trigger: replace_paths in broker_node_group_info (client_subnets, security_groups, az_distribution), cluster_name, encryption_info (encryption_at_rest_kms_key_arn, encryption_in_transit.in_cluster). ForceNewIfChange: a kafka_version downgrade; storage_mode changing to LOCAL. Severity: CRITICAL. Reason: all topics and retained messages are lost, and the bootstrap_brokers strings change for every producer and consumer.  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/kafka/cluster.go
- **[high] [AWS-14] aws_kinesis_stream and aws_sqs_queue: replacement loses in-flight data** — Trigger: kinesis replace_paths in name; sqs replace_paths in name, name_prefix, fifo_queue; or delete of either. Severity: HIGH (CRITICAL if no DLQ or replay source). Reason: records or messages in flight are lost, and the stream ARN / queue URL changes for producers, consumers, Lambda event source mappings and subscriptions. In-place: a lower message_retention_seconds (SQS) or retention_period (Kinesis) is MEDIUM; a removed redrive_policy is MEDIUM.  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/kinesis/stream.go, https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/sqs/queue.go
- **[high] [AWS-15] aws_kms_key: delete or replace schedules key deletion** — Trigger: delete, or replace_paths in custom_key_store_id, customer_master_key_spec, key_usage, multi_region, xks_key_id. Severity: CRITICAL. Reason: destroying the resource schedules deletion after deletion_window_in_days (7–30, default 30). Once the window passes, everything encrypted under the key is unrecoverable, and a replacement re-encrypts nothing. In-place:
- is_enabled true→false is CRITICAL (dependent data unreadable immediately);
- a policy change is HIGH;
- bypass_policy_lockout_safety_check=true is HIGH (docs: "increases the risk that the KMS key becomes unmanageable");
- enable_key_rotation true→false is MEDIUM;
- aws_kms_alias.target_key_id change is HIGH (new data goes to a different key).  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/kms/key.go, https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/kms_key.html.markdown
- **[high] [AWS-16] aws_secretsmanager_secret: immediate delete or ARN change** — Trigger: replace_paths in name, name_prefix, type; or delete. Severity: CRITICAL if delete with before.recovery_window_in_days==0 (docs: 0 forces deletion without recovery), otherwise HIGH. Reason: the secret ARN suffix changes on replacement and consumers break. Recreating with the same name can fail while the old secret is in its recovery window. aws_secretsmanager_secret_version.secret_string change is HIGH (credential rotation). The value is sensitive, so report it as changed without showing it.  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/secretsmanager/secret.go, https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/secretsmanager_secret.html.markdown
- **[high] [AWS-17] aws_route53_zone and aws_route53_record: replacement breaks DNS** — Trigger: zone replace_paths in name or delegation_set_id, or zone delete; record replace_paths in name or zone_id, or record delete. Severity: zone CRITICAL, because the new zone gets new name servers, breaking parent delegation; if force_destroy==true, records managed outside Terraform are deleted too. Record HIGH, because delete-then-create leaves a DNS gap, and TTL caching extends a wrong answer. A records/alias target change on an apex or production name is HIGH. A ttl-only change is LOW.  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/route53/zone.go, https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/route53/record.go, https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/route53_zone.html.markdown
- **[high] [AWS-18] aws_acm_certificate: domain or SAN change forces replacement** — Trigger: replace_paths in certificate_authority_arn, key_algorithm, validation_method, validation_option.*. For non-imported certificates, domain_name or subject_alternative_names changes are forced through diff.ForceNew in CustomizeDiff. Severity: HIGH, and CRITICAL if actions==["delete","create"] while the cert is attached to listeners or distributions. Reason: an in-use certificate cannot be deleted, so apply fails or TLS breaks; the provider docs' example uses create_before_destroy.  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/acm/certificate.go, https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/acm_certificate.html.markdown
- **[high] [AWS-19] aws_lb (ALB/NLB/GWLB): replacement changes dns_name** — Trigger: replace_paths in customer_owned_ipv4_pool, internal, load_balancer_type, name, name_prefix. Conditional (diff.ForceNew):
- NLB security_groups added where there were none, or removed entirely;
- NLB secondary_ips_auto_assigned_per_subnet decreased;
- subnets / subnet_mapping removed or changed (NLB/GWLB).
  Severity: CRITICAL if internal false (the replacement also makes it internet-facing), otherwise HIGH. Reason: the computed dns_name changes, so CNAME and alias records and partner allowlists break. Listeners and target attachments are recreated. In-place: enable_deletion_protection true→false is HIGH. aws_lb_target_group replace_paths in port, protocol, protocol_version, target_type, vpc_id, name, ip_address_type, target_control_port is HIGH (listener gap without create_before_destroy).  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/elbv2/load_balancer.go, https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/elbv2/target_group.go, https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/lb.html.markdown
- **[medium] [AWS-20] aws_cloudfront_distribution: rarely replaced; risk sits in in-place updates** — Trigger: the only static ForceNew attribute is staging. A replace or delete is HIGH (new *.cloudfront.net domain_name). In-place:
- enabled true→false is HIGH (outage);
- web_acl_id removed or changed is HIGH (WAF detached);
- aliases changed is HIGH;
- origin / default_cache_behavior target_origin_id changes are MEDIUM;
- viewer_certificate.minimum_protocol_version lowered is MEDIUM.
  Reason: CloudFront fronts production traffic; detaching WAF or disabling the distribution is immediate.  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/cloudfront/distribution.go
- **[high] [AWS-21] aws_vpc and aws_subnet: replacement cascades** — Trigger:
- aws_vpc replace_paths in cidr_block (also forced in CustomizeDiff), ipv4_ipam_pool_id, ipv4_netmask_length, instance_tenancy (conditional, diff.ForceNew);
- aws_subnet replace_paths in availability_zone, availability_zone_id, cidr_block, vpc_id, ipv6_native, ipv4_ipam_pool_id, ipv4_netmask_length, ipv6_ipam_pool_id, ipv6_netmask_length, outpost_arn; ipv6_cidr_block is conditional.
  Severity: CRITICAL. Reason: everything with an ENI in the subnet or VPC (RDS, EKS, ALB, instances, endpoints) must be replaced, or the delete hangs and fails. Count dependent resources in the same plan to show the cascade.  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/ec2/vpc_.go, https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/ec2/vpc_subnet.go
- **[high] [AWS-22] aws_iam_role replacement breaks trust and resource policies that reference it** — Trigger: replace_paths in name, name_prefix, path; or delete. Severity: CRITICAL if the role ARN appears in any resource-based or trust policy in the plan or state (S3, KMS, SQS policies, another role's assume_role_policy) or is used by an instance profile, ECS task or Lambda; otherwise HIGH. Reason, from AWS IAM docs: a role ARN in a Principal is stored as the role's unique principal ID, and "if you delete the role, then you break the relationship". The recreated role does not match. Related: aws_iam_policy replace_paths in name, name_prefix, path, description (description is ForceNew, a surprise) is MEDIUM, because attachments are detached and re-attached.  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/iam/role.go, https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/iam/policy.go, https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_principal.html
- **[high] [AWS-23] aws_cognito_user_pool replacement deletes every user** — Trigger: replace_paths in alias_attributes, username_attributes, username_configuration.case_sensitive; or delete. Severity: CRITICAL. Reason: all users, password hashes and MFA enrolments are lost, and passwords cannot be migrated out. Separately, any modification or removal of an existing `schema` element fails at apply. Docs: "Attributes can be added, but not modified or removed"; provider error "cannot modify or remove schema items". Flag that as HIGH (plan looks fine, apply fails).  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/cognitoidp/user_pool.go, https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/cognito_user_pool.html.markdown
- **[high] [AWS-24] aws_ecr_repository and aws_backup_vault: artifact or recovery-point loss** — Trigger:
- ecr replace_paths in name, encryption_configuration.encryption_type, encryption_configuration.kms_key; or delete;
- backup_vault replace_paths in name, kms_key_arn; or delete.
  Severity:
- CRITICAL when before.force_delete==true (ECR: deletes the repo "even if it contains images") or before.force_destroy==true (Backup: deletes all recovery points);
- otherwise HIGH, because apply fails on a non-empty repo or vault.
  Also: creating aws_backup_vault_lock_configuration is HIGH (compliance lock becomes immutable after changeable_for_days).  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/ecr/repository.go, https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/backup/vault.go, https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/backup_vault.html.markdown, https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/ecr_repository.html.markdown
- **[high] [AWS-25] aws_eks_cluster: replacement triggers (subnet_ids is not one of them)** — Trigger: replace_paths in name, role_arn (a surprise), bootstrap_self_managed_addons, access_config.bootstrap_cluster_creator_admin_permissions, kubernetes_network_config.{service_ipv4_cidr,ip_family}, outpost_config.*. Conditional:
- encryption_config removed (envelope encryption cannot be disabled);
- vpc_config.control_plane_egress_mode CUSTOMER_ROUTED→AWS_MANAGED;
- compute_config.node_role_arn (diff.ForceNew).
  Severity: CRITICAL. Reason: a new control plane means new endpoint, CA and OIDC issuer, so all workloads, IRSA trust policies and access entries are invalidated. vpc_config.subnet_ids and security_group_ids update in place via UpdateClusterConfig on v5.100.0 and v6, so they are MEDIUM, not a replace. In-place `version` bump is HIGH (irreversible control-plane upgrade). deletion_protection true→false (v6 attribute) is HIGH.  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/eks/cluster.go, https://github.com/hashicorp/terraform-provider-aws/blob/v5.100.0/internal/service/eks/cluster.go, https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/eks_cluster.html.markdown
- **[high] [AWS-26] aws_eks_node_group: replacement evicts pods** — Trigger: replace_paths in ami_type, capacity_type, cluster_name, disk_size, instance_types, launch_template.{id,name}, node_group_name, node_group_name_prefix, node_role_arn, remote_access.*, subnet_ids. Severity: HIGH when actions==["delete","create"] (capacity drops to zero first), MEDIUM when ["create","delete"]. Reason: every node is drained, and with delete-first ordering pods go Pending. Changing instance_types is a replace, not a rolling update.  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/eks/node_group.go
- **[high] [AWS-27] Compute and service replacements: ECS service, ASG, Lambda, security groups** — Trigger:
- aws_ecs_service replace_paths in name, cluster, launch_type, scheduling_strategy, iam_role: HIGH (tasks torn down);
- aws_autoscaling_group replace_paths in name, name_prefix, initial_lifecycle_hook.*: HIGH, or MEDIUM with create_before_destroy;
- aws_lambda_function replace_paths in function_name, package_type, tenancy_config: MEDIUM/HIGH (ARN changes; permissions and event-source mappings are recreated);
- aws_security_group replace_paths in name, name_prefix, description, vpc_id: HIGH. Docs: name change "forces new", and delete-first fails while the group is attached, so they recommend create_before_destroy;
- aws_security_group_rule: every field is ForceNew, so any edit is delete+create, MEDIUM (brief rule gap).  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/ecs/service.go, https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/autoscaling/group.go, https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/lambda/function.go, https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/ec2/vpc_security_group_rule.go, https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/security_group.html.markdown
- **[high] [AWS-U01] Deletion guard switched off** — Trigger: an update with before→after true→false on:
- aws_db_instance.deletion_protection, aws_rds_cluster.deletion_protection, aws_docdb_cluster.deletion_protection, aws_neptune_cluster.deletion_protection;
- aws_dynamodb_table.deletion_protection_enabled (and replica[].deletion_protection_enabled);
- aws_lb.enable_deletion_protection;
- aws_eks_cluster.deletion_protection (v6);
- aws_instance.disable_api_termination.
  Severity: HIGH; CRITICAL if the same plan or PR also deletes or replaces that address, or PLAN-13 fires. Reason: this is the usual first step before a destructive change. RDS docs: the DB "can't be deleted when this value is set to true".  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/db_instance.html.markdown, https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/dynamodb_table.html.markdown, https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/lb.html.markdown, https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/eks_cluster.html.markdown
- **[high] [AWS-U02] Final snapshot disabled or backups turned off** — Trigger: skip_final_snapshot false→true on aws_db_instance / aws_rds_cluster / aws_docdb_cluster / aws_neptune_cluster / aws_redshift_cluster; final_snapshot_identifier removed; delete_automated_backups false→true; aws_db_instance.backup_retention_period → 0. Severity: HIGH, escalated to CRITICAL when combined with a delete or replace in the same plan. Reason: no recovery point after destroy. AWS documents that changing backup retention from nonzero to 0, or 0 to nonzero, causes downtime, and 0 disables automated backups.  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/db_instance.html.markdown, https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ModifyInstance.Settings.html
- **[high] [AWS-U03] RDS in-place changes that cause downtime, combined with apply_immediately** — Trigger: an update on aws_db_instance touching instance_class, engine_version, db_subnet_group_name, identifier, port, license_model, network_type, storage_type (magnetic↔SSD), or ca_cert_identifier (engine-dependent). Severity: HIGH if after.apply_immediately==true (downtime now); MEDIUM if false (deferred to the maintenance window, a latent surprise). Add HIGH for an instance_class downsize or multi_az true→false (availability). For aws_rds_cluster.engine_version the docs say "Updating this argument results in an outage", which is HIGH. Reason: AWS's settings table marks these as "Downtime occurs".  
  Sources: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ModifyInstance.Settings.html, https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/db_instance.html.markdown, https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/rds_cluster.html.markdown
- **[high] [AWS-U04] RDS exposure, replica promotion, and credential changes** — Trigger and severity:
- publicly_accessible false→true on aws_db_instance / aws_rds_cluster / aws_redshift_cluster: CRITICAL (AWS applies it immediately);
- replicate_source_db or replicate_source_db_cluster removed: HIGH. Provider docs: removing it "will promote the database to a fully standalone database", so replication silently stops;
- master_password / password changed (path flagged in after_sensitive): HIGH, because applications holding the old credential fail;
- manage_master_user_password toggled: MEDIUM.  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/db_instance.html.markdown, https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ModifyInstance.Settings.html
- **[high] [AWS-U05] S3 public exposure** — Trigger:
- aws_s3_bucket_public_access_block (or aws_s3_account_public_access_block): any of block_public_acls, block_public_policy, ignore_public_acls, restrict_public_buckets going true→false, or the resource deleted;
- aws_s3_bucket_policy.policy gaining a statement with Effect Allow and Principal "_" or {"AWS":"_"} without a restrictive Condition;
- aws_s3_bucket_acl.acl in public-read, public-read-write, authenticated-read.
  Severity: CRITICAL. Reason, from AWS IAM docs: a wildcard principal with Allow "grants access to all users, including anonymous users (public access)".  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/s3_bucket_public_access_block.html.markdown, https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_principal.html
- **[medium] [AWS-U06] S3 controls that delete data or remove recoverability** — Trigger and severity:
- aws_s3_bucket_versioning.versioning_configuration.status Enabled→Suspended: HIGH;
- aws_s3_bucket_lifecycle_configuration gaining or shortening rule[].expiration (days/date) or noncurrent_version_expiration: HIGH, because objects are deleted on schedule;
- aws_s3_bucket.force_destroy false→true: HIGH, because it arms unrecoverable deletion;
- aws_s3_bucket_server_side_encryption_configuration deleted, or kms_master_key_id changed: MEDIUM;
- aws_s3_bucket_logging deleted: MEDIUM.
  Reason: these silently reduce recoverability or audit, even though no resource is destroyed.  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/s3_bucket_versioning.html.markdown, https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/s3_bucket.html.markdown
- **[medium] [AWS-U07] Security-group ingress opened to the internet** — Trigger: a new or changed ingress with 0.0.0.0/0 or ::/0, where:
- aws_security_group: ingress[].cidr_blocks / ipv6_cidr_blocks with from_port, to_port, protocol;
- aws_security_group_rule: type=="ingress" with cidr_blocks / ipv6_cidr_blocks;
- aws_vpc_security_group_ingress_rule: cidr_ipv4 / cidr_ipv6 with ip_protocol, from_port, to_port.
  Severity:
- CRITICAL when protocol is "-1" (all) or the port range covers an admin or data port: 22, 3389, 3306, 5432, 1433, 1521, 6379, 11211, 9200, 9300, 27017, 2379, 6443, 10250;
- HIGH for other ports;
- LOW when the range is exactly 80 or 443.
  The port list is a heuristic, not sourced. Reason: direct internet exposure of management or database ports.  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/vpc_security_group_ingress_rule.html.markdown, https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/security_group.html.markdown
- **[medium] [AWS-U08] IAM over-privilege and new trust** — Trigger: parse and normalize the JSON policy in aws_iam_policy.policy, aws_iam_role_policy.policy, aws_iam_user_policy, aws_iam_group_policy, and in resource policies (aws_s3_bucket_policy, aws_sqs_queue_policy, aws_sns_topic_policy, aws_kms_key.policy, aws_ecr_repository_policy). Severity:
- CRITICAL: a new Allow statement with Action "_" (or "<svc>:_") AND Resource "*";
- HIGH: Allow with NotAction or NotResource; iam:PassRole or sts:AssumeRole on Resource "*";
- CRITICAL: aws_iam_role.assume_role_policy gains Principal "*", a new external account, or a Federated OIDC principal (e.g. token.actions.githubusercontent.com) without a sub/aud Condition;
- CRITICAL: aws_iam_role_policy_attachment / aws_iam_user_policy_attachment / aws_iam_group_policy_attachment with policy_arn ending in AdministratorAccess, PowerUserAccess or IAMFullAccess;
- MEDIUM: other new statements.
  Reason: privilege escalation or cross-account trust. AWS docs say a wildcard principal in a trust policy is to be strongly avoided.  
  Sources: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_principal.html
- **[medium] [AWS-U09] Audit and detection switched off** — Trigger: aws_cloudtrail.enable_logging true→false, is_multi_region_trail true→false, or delete; aws_flow_log delete; aws_lb.access_logs[0].enabled true→false; aws_config_configuration_recorder_status.is_enabled true→false; aws_guardduty_detector.enable true→false; aws_cloudwatch_log_group.retention_in_days decreased, or delete. Severity: HIGH for CloudTrail, GuardDuty and Config; MEDIUM for flow, access and log-group retention. Reason: loss of forensic trail. These are commonly turned off to cut costs and often go unnoticed. The resource and attribute names are standard but were not re-verified in this pass.  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/cloudtrail/trail.go
- **[medium] [AWS-U10] Capacity scaled to zero or failover disabled** — Trigger:
- aws_autoscaling_group min_size / desired_capacity / max_size → 0;
- aws_eks_node_group.scaling_config.{min_size,desired_size} → 0;
- aws_ecs_service.desired_count → 0;
- aws_appautoscaling_target.min_capacity → 0;
- aws_elasticache_replication_group automatic_failover_enabled or multi_az_enabled true→false;
- aws_db_instance.multi_az true→false.
  Severity: HIGH. Reason: an availability drop with no resource destroyed.  
  Sources: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ModifyInstance.Settings.html
- **[medium] [AWS-U11] DynamoDB and EKS settings that change in place but break consumers** — Trigger and severity:
- aws_dynamodb_table point_in_time_recovery.enabled true→false: HIGH;
- stream_enabled or stream_view_type changed: HIGH (stream ARN changes, so Lambda event-source mappings and Kinesis adapters break);
- a replica removed: HIGH (that region's replica table is deleted);
- ttl enabled or attribute_name changed: MEDIUM (items start expiring);
- aws_eks_cluster vpc_config.endpoint_public_access true with public_access_cidrs containing 0.0.0.0/0: HIGH (docs: EKS defaults public_access_cidrs to 0.0.0.0/0);
- aws_eks_access_policy_association with AmazonEKSClusterAdminPolicy: HIGH.  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/dynamodb_table.html.markdown, https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/eks_cluster.html.markdown
- **[high] [AWS-U12] aws_instance in-place changes that stop and start the instance** — Trigger: an update (not a replace) on instance_type, or on user_data / user_data_base64 when user_data_replace_on_change is false. Severity: MEDIUM (HIGH for a singleton without an ASG). Reason: provider docs say instance_type updates "will trigger a stop/start", and user_data updates trigger a stop/start by default, which is an outage. Instance-store data is lost, and the public IP changes unless an EIP is attached.  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/instance.html.markdown
- **[high] [AZ-01] azurerm_mssql_server and azurerm_mssql_database: attributes that force replacement** — Trigger:
- mssql_server: replace_paths in name, version, administrator_login, location, resource_group_name (commonschema.Location() / ResourceGroupName() are ForceNew helpers);
- mssql_database: name, server_id, create_mode, collation, creation_source_database_id, ledger_enabled, secondary_type; conditionally sku_name HS*→non-HS ("hyperscale can not be changed to another sku") and enclave_type removal.
  Severity: CRITICAL. Reason: a server replace drops every database on it, and changing collation means a new empty database.  
  Sources: https://github.com/hashicorp/terraform-provider-azurerm/blob/main/internal/services/mssql/resources/mssql_server/r_schema.go, https://github.com/hashicorp/terraform-provider-azurerm/blob/main/internal/services/mssql/resources/mssql_database/r_schema.go
- **[high] [AZ-02] azurerm_postgresql_flexible_server and azurerm_mysql_flexible_server: attributes that force replacement** — Trigger:
- postgres: replace_paths in name, storage_type, delegated_subnet_id, point_in_time_restore_time_in_utc, source_server_id, geo_redundant_backup_enabled, customer_managed_key, cluster, cluster.default_database_name, location, resource_group_name;
- mysql: name, administrator_login, create_mode, delegated_subnet_id, geo_redundant_backup_enabled, point_in_time_restore_time_in_utc, private_dns_zone_id, source_server_id, location, resource_group_name; and storage.size_gb DECREASE (ForceNewIfChange new < old, a surprise).
  Severity: CRITICAL. Reason: the server and its data are recreated. Shrinking MySQL storage or toggling geo-redundant backup looks harmless but is a replace.  
  Sources: https://github.com/hashicorp/terraform-provider-azurerm/blob/main/internal/services/postgres/resources/postgresql_flexible_server/r_schema.go, https://github.com/hashicorp/terraform-provider-azurerm/blob/main/internal/services/mysql/resources/mysql_flexible_server/r_schema.go
- **[high] [AZ-03] azurerm_storage_account: replacement triggers and in-place exposure** — Trigger: replace_paths in name, account_tier, is_hns_enabled, nfsv3_enabled, dns_endpoint_type, queue_encryption_key_type, table_encryption_key_type, infrastructure_encryption_enabled, immutability_policy, provisioned_billing_model_version, location, resource_group_name. Conditional: account_replication_type moving between {LRS,GRS,RAGRS} and {ZRS,GZRS,RAGZRS}, except the supported zonal-migration pairs. A replace is CRITICAL (all blobs, files, queues and tables are lost).
  In-place HIGH:
- allow_nested_items_to_be_public →true;
- shared_access_key_enabled →true;
- https_traffic_only_enabled →false;
- min_tls_version lowered;
- network_rules.default_action →"Allow";
- public_network_access →"Enabled" (v5 main uses `public_network_access`; v4 used public_network_access_enabled);
- blob_properties.delete_retention_policy / container_delete_retention_policy removed;
- blob_properties.versioning_enabled →false.  
  Sources: https://github.com/hashicorp/terraform-provider-azurerm/blob/main/internal/services/storage/storage_account_resource.go
- **[high] [AZ-04] azurerm_key_vault: delete purges by default** — Trigger: delete or replace (replace_paths in name, location, resource_group_name). Severity: CRITICAL unless before.purge_protection_enabled==true. Reason: the provider features block key_vault.purge_soft_delete_on_destroy "Defaults to true", so destroy permanently purges the vault. purge_soft_deleted_keys_on_destroy and purge_soft_deleted_secrets_on_destroy also default to true for azurerm_key_vault_key and azurerm_key_vault_secret. In-place HIGH:
- public_network_access_enabled →true;
- network_acls.default_action →"Allow";
- rbac_authorization_enabled flipped (the access model changes wholesale);
- soft_delete_retention_days lowered (MEDIUM).  
  Sources: https://github.com/hashicorp/terraform-provider-azurerm/blob/main/internal/services/keyvault/resources/key_vault/r_schema.go, https://github.com/hashicorp/terraform-provider-azurerm/blob/main/website/docs/guides/features-block.html.markdown
- **[high] [AZ-05] azurerm_kubernetes_cluster and node pools: replacement triggers** — Trigger for the cluster: replace_paths in name, dns_prefix, dns_prefix_private_cluster, disk_encryption_set_id, kubelet_identity.{client_id,object_id,user_assigned_identity_id}, linux_profile.admin_username, linux_profile.ssh_key.key_data (a surprise), network_profile.{network_mode,dns_service_ip,service_cidr,service_cidrs,load_balancer_sku,ip_versions,...}, node_resource_group, private_cluster_enabled, private_dns_zone_id, role_based_access_control_enabled, windows_profile.admin_username, location, resource_group_name, edge_zone. Conditional:
- oidc_issuer_enabled true→false;
- service_principal.client_id migrating from msi;
- network_policy, network_plugin_mode, network_data_plane, pod_cidr(s), api_server_access_profile.subnet_id;
- default_node_pool.name, unless temporary_name_for_rotation is in use.
  Trigger for node_pool: name, kubernetes_cluster_id, os_type, priority, eviction_policy, spot_max_price, proximity_placement_group_id, node_public_ip_prefix_id, host_group_id, capacity_reservation_group_id, gpu_instance, gpu_driver, windows_profile; conditionally os_sku.
  Severity: cluster CRITICAL, node pool HIGH. Reason: a new control plane and identities; workloads are evicted.  
  Sources: https://github.com/hashicorp/terraform-provider-azurerm/blob/main/internal/services/containers/resources/kubernetes_cluster/r_schema.go, https://github.com/hashicorp/terraform-provider-azurerm/blob/main/internal/services/containers/resources/kubernetes_cluster_node_pool/r_schema.go
- **[high] [AZ-06] azurerm_cosmosdb_account replacement, and resource group deletes** — Trigger: cosmosdb_account replace_paths in name, kind, create_mode, free_tier_enabled, key_vault_key_id, restore.*, resource_group_name. Conditional:
- backup.type Continuous→Periodic;
- analytical_storage_enabled true→false;
- capabilities removal (ForceNewIf).
  Severity: CRITICAL (all containers and data). azurerm_resource_group delete is CRITICAL (cascade). The features.resource_group.prevent_deletion_if_contains_resources default is true, so apply fails if non-Terraform resources remain; Terraform-managed resources in it are still destroyed by the plan.  
  Sources: https://github.com/hashicorp/terraform-provider-azurerm/blob/main/internal/services/cosmos/cosmosdb_account_resource.go, https://github.com/hashicorp/terraform-provider-azurerm/blob/main/website/docs/guides/features-block.html.markdown
- **[high] [GCP-01] google_sql_database_instance: replacement triggers and guards** — Trigger: replace_paths in name, region, project, encryption_key_name, settings.collation, replica_configuration.*. Conditional: master_instance_name or replica_configuration.cascadable_replica, unless this is a switchover. Severity: CRITICAL. Reason: the instance and its data are recreated, and the docs say a used name "cannot be reused for up to one week", so a same-name replace also fails. database_version is NOT ForceNew; an in-place major upgrade is HIGH (downtime). deletion_protection (Terraform-side, Default true) true→false is HIGH. settings.deletion_protection_enabled (API-side) true→false is HIGH. A delete or replace whose before.deletion_protection==true will fail at apply: flag it, but do not escalate further.  
  Sources: https://github.com/hashicorp/terraform-provider-google/blob/main/google/services/sql/resource_sql_database_instance.go, https://github.com/hashicorp/terraform-provider-google/blob/main/website/docs/r/sql_database_instance.html.markdown
- **[high] [GCP-02] google_storage_bucket: replacement triggers and exposure** — Trigger: replace_paths in name, location, project, enable_object_retention, custom_placement_config.data_locations, hierarchical_namespace / hierarchical_namespace.enabled. Conditional: retention_policy.is_locked. Severity: CRITICAL if force_destroy==true (Default false; docs: deletes all objects), otherwise HIGH (apply fails on a non-empty bucket). In-place:
- force_destroy false→true: HIGH;
- versioning.enabled →false: HIGH;
- a new lifecycle_rule with action.type "Delete": HIGH;
- public_access_prevention "enforced"→"inherited": HIGH;
- google_storage_bucket_iam_member or iam_binding with allUsers / allAuthenticatedUsers: CRITICAL.  
  Sources: https://github.com/hashicorp/terraform-provider-google/blob/main/google/services/storage/resource_storage_bucket.go
- **[high] [GCP-03] google_container_cluster and google_container_node_pool: replacement triggers** — Trigger for the cluster: replace_paths in name, location, project, network, subnetwork, cluster_ipv4_cidr, ip_allocation_policy.* (cluster/services CIDR blocks and secondary range names), networking_mode, private_cluster_config.{master_ipv4_cidr_block,private_endpoint_subnetwork}, default_max_pods_per_node, datapath_provider, enable_autopilot, enable_kubernetes_alpha, enable_tpu, initial_node_count, node_pool (inline pools), description (a surprise), confidential_nodes, master_auth.client_certificate_config, user_managed_keys_config._. ForceNewIfChange: enable_l4_ilb_subsetting and enable_fqdn_network_policy being disabled. A cluster replace is CRITICAL. deletion_protection (Default true) true→false is HIGH.
  Trigger for node_pool: name, name_prefix, cluster, location, project, initial_node_count, max_pods_per_node, placement_policy, queued_provisioning, best_effort_provisioning, network_config._ (plus node_config fields from a shared helper, not extracted). A node pool replace is HIGH.  
  Sources: https://github.com/hashicorp/terraform-provider-google/blob/main/google/services/container/resource_container_cluster.go, https://github.com/hashicorp/terraform-provider-google/blob/main/google/services/container/resource_container_node_pool.go
- **[medium] [GCP-04] Cloud SQL in-place exposure and availability changes** — Trigger:
- settings.ip_configuration.ipv4_enabled true with authorized_networks[].value 0.0.0.0/0: CRITICAL;
- settings.backup_configuration.enabled →false: HIGH;
- settings.backup_configuration.point_in_time_recovery_enabled →false: MEDIUM;
- backup_retention_settings.retained_backups lowered: MEDIUM;
- settings.availability_type REGIONAL→ZONAL: HIGH;
- settings.tier change: MEDIUM (restart).
  Reason: public database exposure, or loss of recoverability or HA.  
  Sources: https://github.com/hashicorp/terraform-provider-google/blob/main/google/services/sql/resource_sql_database_instance.go
- **[medium] [NOISE-01] Tag-only and tags_all-only updates are noise, with functional-tag exceptions** — Trigger: actions ["update"] where every changed leaf path starts with "tags" or "tags_all" (and, for azurerm and google, "tags" / "labels" / "effective_labels" / "terraform_labels"). Severity: NOISE; collapse into one line, "N resources: tags only". If all changes are tags_all with no `tags` change, attribute it to a provider default_tags change. Escalate to MEDIUM when a changed key is functional:
- kubernetes.io/role/elb, kubernetes.io/role/internal-elb, kubernetes.io/cluster/* (EKS load balancer subnet discovery);
- karpenter.sh/discovery;
- keys referenced by aws_backup_selection.selection_tag / condition;
- keys referenced by aws:ResourceTag conditions in any IAM policy in the plan (ABAC);
- "Patch Group".
  Also NOISE: the provider docs say managing tags with both aws_vpc and aws_ec2_tag causes "a perpetual difference".  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/guides/resource-tagging.html.markdown, https://docs.aws.amazon.com/eks/latest/userguide/network-load-balancing.html
- **[high] [NOISE-02] aws_ecs_task_definition revision churn** — Trigger: aws_ecs_task_definition replace. It is always a replace because container_definitions, cpu, memory, family, task_role_arn, execution_role_arn, network_mode, volume.* and more are ForceNew; each "change" registers a new revision. Severity: NOISE if before.container_definitions and after.container_definitions are equal after normalization (parse JSON, drop default or empty fields such as empty arrays and essential:true, sort environment by name). Otherwise LOW, plus the image-tag change in the summary. The follow-on aws_ecs_service.task_definition update is MEDIUM (rolling deploy). Reason: replace is the normal revision mechanism; the old revision is deregistered unless skip_destroy==true.  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/ecs/task_definition.go, https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/ecs_task_definition.html.markdown
- **[medium] [NOISE-03] aws_lambda_function source_code_hash churn** — Trigger: an update where the only known changed leaf is source_code_hash, with last_modified, version, qualified_arn, qualified_invoke_arn, code_sha256 etc. only in after_unknown. Severity: LOW (code deploy). Treat as NOISE when no PR-diff file under the function's source path changed, which points to a non-deterministic zip build. Reason: provider docs call source_code_hash a "synthetic argument tracked only by the AWS provider".  
  Sources: https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/lambda_function.html.markdown
- **[medium] [NOISE-04] Policy JSON that is equal after normalization** — Trigger: an update whose only changed leaf is a policy-JSON string: policy, assume_role_policy, access_policies, or a resource policy, and the data.aws_iam_policy_document rendering that feeds it. Normalize both sides: parse JSON, sort object keys, wrap a single string Action/Resource/Principal value into a one-element array, sort arrays, drop empty Sid. If they are then equal, the change is NOISE. Otherwise run AWS-U08. Reason: whitespace and ordering diffs from jsonencode versus AWS-returned documents are the most common false positive in IAM review.  
  Sources: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_principal.html
- **[medium] [NOISE-05] Computed-only, read-only, outputs-only, and inline-rule flip-flop changes** — Trigger and severity:
- update where every changed leaf is in after_unknown and none traces to a replaced resource (PLAN-14): LOW;
- data-source actions ["read"] with read_because_config_unknown or read_because_dependency_pending: NOISE, unless the data value feeds a ForceNew attribute downstream (then PLAN-03 or PLAN-14 applies);
- output_changes present with no non-no-op resource_changes: LOW, raised to MEDIUM if an output is consumed through terraform_remote_state or is sensitive;
- aws_security_group with inline ingress/egress alongside aws_vpc_security_group_*_rule resources on the same group: NOISE, annotated "conflicting management" (the docs warn against combining them).  
  Sources: https://developer.hashicorp.com/terraform/internals/json-format, https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/security_group.html.markdown
- **[high] [SEC-01] The plan JSON contains sensitive values in plaintext and must be redacted before the LLM or comments see it** — Verified locally: a variable with sensitive=true appeared verbatim in change.after, with after_sensitive {"input": true}. Rule: before passing to the Claude agent or posting PR comments, replace every leaf marked true in before_sensitive or after_sensitive with a placeholder plus a changed/unchanged boolean. Materiality rules may still compare the raw values in-process, e.g. a password-change detector. Severity: n/a (an engine requirement). Reason: avoids leaking secrets into PR comments and LLM context.  
  Sources: Local experiment: Terraform v1.10.5, terraform_data, terraform show -json, https://developer.hashicorp.com/terraform/internals/json-format

## Design implications

- Store the rules as versioned data (YAML or JSON), not code. Each rule holds: provider, resource type, provider-version range, path pattern (supporting * and set-element wildcards), a predicate over before/after/after_unknown/before_sensitive, actions/action_reason filters, severity, impact class (data-loss | outage | exposure | audit | cost | noise), the reviewer-facing reason, and a source URL. The ForceNew tables differ between AWS provider v5.100.0 and v6 (s3 object_lock_enabled, aws_instance cpu_core_count, aws_rds_cluster publicly_accessible), so pick the rule set from the .terraform.lock.hcl provider version.
- Use replace_paths as the source of truth for what forced a replacement, and use the ForceNew tables only to explain it and to predict outcomes (e.g. a value that is unknown on an attribute that forces replacement). Provider replacement logic is often conditional (customdiff.ForceNewIf, diff.ForceNew in CustomizeDiff, framework RequiresReplaceIf), so a static ForceNew list alone gives both false positives and false negatives.
- replace_paths steps can be strings, integers, or JSON-encoded set-element values (encodePath marshals any cty.IndexStep key). The lineage walker must handle object-valued steps by matching the set element rather than indexing into it.
- Lineage resolution: replace_paths[0][0] → configuration.<module path>.resources[address].expressions[attr] → {references} or constant_value. For a var.X reference, go to the parent module_calls[name].expressions[X].references, then repeat up to root, then map to the changed PR-diff line or tfvars key. If the walk ends at a data source, drift, or the provider lock file, mark the change NOT-PR-CAUSED and escalate it (PLAN-03).
- The plan JSON configuration has no lifecycle block (jsonconfig has no prevent_destroy, create_before_destroy or ignore_changes fields), so parse the HCL in the PR head and base (hcl/v2 or a TypeScript HCL parser) to detect prevent_destroy removal and replace_triggered_by sources. Infer create_before_destroy from actions ordering instead (["create","delete"]).
- Group changes before ranking: by module_address (module removed or re-indexed), by resource type and name (count/for_each re-index), and tag-only or tags_all-only changes into one collapsed line. Severity of a group is the maximum of its members. This lets the bot say, for example, '1 critical, 3 high, 212 noise' for a 400-line plan.
- Score each change on two axes: severity (from the rules) and attribution confidence (PR-caused with a full trace, partially traced, or untraced). Untraced Tier-A replacements should sort above traced ones, since that is where recall matters most.
- Precision/recall harness: record the bot's top-K list per PR and the reviewer's confirm or dismiss per item (e.g. PR comment reactions or a checkbox). Separately capture the 'missed' signal: post-merge incidents or reverts, plus items reviewers flag that the bot did not. Track per-rule precision so noisy rules can be demoted automatically.
- Redact sensitive leaves (before_sensitive and after_sensitive) before any LLM call or comment. Raw values may only be compared in-process (e.g. a 'password changed' boolean).
- Parse actions and action_reason defensively. Treat an unknown action string or reason as 'unspecified' rather than failing, because forget, [forget,create], [create,forget] and new reasons are newer than the public json-format docs and third-party libraries (terraform-json issue #125).
- Give the Claude agent read-only tools such as getChange(address), getConfigExpression(module, address, attr), getModuleCallInput(module, var), getDiffHunk(file, line) and getRule(id). It should confirm or adjust ranking for cases the rules cannot judge, e.g. whether a policy diff is semantically broader or whether a tag key is functional. It must not invent severities without citing a rule or evidence.

## Open questions

- OpenTofu parity is not verified (OpenTofu is not installed). Do `tofu show -json` plans emit the same action_reason strings, forget, [forget,create] and replace_paths encoding? Needs an OpenTofu run with the same terraform_data experiment.
- GKE node_config fields that force replacement are defined in a shared schema helper (node_config.go) and were not extracted, so which google_container_node_pool.node_config changes (machine_type, disk_size_gb, image_type, oauth_scopes, service_account) replace the pool in google v8 is unverified.
- The azurerm rules were verified on the main branch (about v5.15.0, new resources/<name>/r_schema.go layout), not on v4.x. Field names differ between majors (e.g. storage account public_network_access in v5 vs public_network_access_enabled in v4). Teams pinned to azurerm v4 need their rules re-extracted.
- Some in-place 'material' attribute names were taken from docs or common usage and not re-verified in source this pass: CloudTrail is_multi_region_trail, aws_guardduty_detector.enable, aws_config_configuration_recorder_status.is_enabled, Cloud SQL authorized_networks shape, and google_storage_bucket public_access_prevention values.
- The security-group sensitive-port list, the mass-destroy thresholds (5 resources / 20%), and the functional tag-key list are heuristics, not sourced. They should be configurable per organization and tuned against reviewer feedback.
- Environment weighting: should the same change be ranked higher for a production workspace or directory? This needs a signal such as workspace name, backend key, or path convention.
- Does aws_db_instance.identifier rename always change `address` in the plan, i.e. does it appear in after_unknown so lineage can show the endpoint impact, or is it only visible after apply? Verify with a real AWS plan.
- Is S3 SSE-S3 default encryption (on since 2023) relied on to rate deleting aws_s3_bucket_server_side_encryption_configuration as MEDIUM rather than HIGH? This was not re-verified from AWS docs this pass.
- How should modules that wrap stateful resources be detected when the plan only shows module_address, e.g. terraform-aws-modules/rds? Should rule matching also key on module source plus input name, to catch changes like `create_db_instance = false` before they show up as deletes?
