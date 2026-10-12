CREATE TABLE "legacy_history_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"nxpkg_import_id" uuid NOT NULL,
	"package_import_id" text NOT NULL,
	"record_type" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"legacy_user_id" text,
	"customer_id" uuid,
	"occurred_at" timestamp with time zone,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "legacy_history_records_idempotency_key" UNIQUE("tenant_id","package_import_id","idempotency_key"),
	CONSTRAINT "legacy_history_records_type_check" CHECK (record_type IN ('payment', 'wallet_transaction', 'wallet_history_check', 'wallet_difference', 'service_operation', 'service_cancellation_request', 'manual_config_inventory', 'service_ownership', 'panel_registry', 'panel_target', 'panel_mapping_template', 'category_catalogue', 'product_mapping_proposal', 'agent_profile', 'agent_price_level', 'agent_invoice', 'agent_log', 'agent_usage', 'agent_request', 'agent_state', 'discount', 'discount_usage', 'referral', 'wheel_result', 'ad_campaign', 'program_setting', 'support_department', 'support_message', 'ticket', 'ticket_message', 'archive_row', 'configuration_row')),
	CONSTRAINT "legacy_history_records_shape_check" CHECK (idempotency_key LIKE 'legacy:%' AND char_length(idempotency_key) BETWEEN 8 AND 512 AND char_length(package_import_id) BETWEEN 1 AND 200 AND (legacy_user_id IS NULL OR char_length(legacy_user_id) BETWEEN 1 AND 64) AND jsonb_typeof(payload) = 'object')
);
--> statement-breakpoint
CREATE TABLE "legacy_nxpkg_imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"status" text NOT NULL,
	"file_name" text NOT NULL,
	"file_path" text NOT NULL,
	"file_sha256" text NOT NULL,
	"file_bytes" bigint NOT NULL,
	"package_import_id" text,
	"package_source_fingerprint" text,
	"package_schema_version" text,
	"converter_version" text,
	"manifest_summary" jsonb,
	"key_ciphertext" text,
	"key_key_id" text,
	"key_kind" text,
	"decisions_file_path" text,
	"decisions_summary" jsonb,
	"panel_bindings" jsonb,
	"verify_report" jsonb,
	"dry_run_report" jsonb,
	"dry_run_sha256" text,
	"approved_dry_run_sha256" text,
	"apply_report" jsonb,
	"dry_run_legacy_run_id" uuid,
	"apply_legacy_run_id" uuid,
	"backup_run_id" uuid,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"requested_by_admin_id" uuid NOT NULL,
	"approved_by_admin_id" uuid,
	"approved_at" timestamp with time zone,
	"claimed_by" text,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "legacy_nxpkg_imports_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "legacy_nxpkg_imports_status_check" CHECK (status IN ('UPLOADED', 'VERIFYING', 'VERIFIED', 'VERIFY_FAILED', 'DRY_RUN_REQUESTED', 'DRY_RUN_RUNNING', 'DRY_RUN_DONE', 'DRY_RUN_FAILED', 'APPROVED', 'APPLYING', 'COMPLETED', 'COMPLETED_WITH_DISCREPANCY', 'FAILED', 'CANCELLED')),
	CONSTRAINT "legacy_nxpkg_imports_error_code_check" CHECK ((error_code IS NULL OR error_code IN ('NXPKG_CONTAINER_INVALID', 'NXPKG_WRONG_KEY', 'NXPKG_TAMPERED', 'NXPKG_UNSUPPORTED_VERSION', 'NXPKG_NOT_READY', 'NXPKG_SOURCE_SNAPSHOT_MISSING', 'NXPKG_MONEY_UNIT', 'NXPKG_LIVE_FLAG', 'PANEL_TARGET_MISMATCH', 'FRESH_TARGET_NOT_EMPTY', 'PACKAGE_CHANGED', 'DRY_RUN_MISMATCH', 'DECISIONS_INVALID', 'IMPORT_FAILED', 'CANCELLED')) AND ((status IN ('VERIFY_FAILED', 'DRY_RUN_FAILED', 'FAILED', 'CANCELLED')) = (error_code IS NOT NULL))),
	CONSTRAINT "legacy_nxpkg_imports_key_check" CHECK ((key_kind IS NULL OR key_kind IN ('KEY_FILE', 'PASSPHRASE')) AND ((key_ciphertext IS NULL) = (key_key_id IS NULL)) AND (key_ciphertext IS NULL OR key_kind IS NOT NULL)),
	CONSTRAINT "legacy_nxpkg_imports_hashes_check" CHECK (file_sha256 ~ '^[0-9a-f]{64}$' AND (dry_run_sha256 IS NULL OR dry_run_sha256 ~ '^[0-9a-f]{64}$') AND (approved_dry_run_sha256 IS NULL OR approved_dry_run_sha256 ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "legacy_nxpkg_imports_approval_check" CHECK (((approved_dry_run_sha256 IS NULL) = (approved_at IS NULL)) AND ((approved_at IS NULL) = (approved_by_admin_id IS NULL)) AND (status NOT IN ('APPROVED', 'APPLYING', 'COMPLETED', 'COMPLETED_WITH_DISCREPANCY') OR approved_at IS NOT NULL)),
	CONSTRAINT "legacy_nxpkg_imports_lifecycle_check" CHECK ((finished_at IS NOT NULL) = (status IN ('VERIFY_FAILED', 'DRY_RUN_FAILED', 'COMPLETED', 'COMPLETED_WITH_DISCREPANCY', 'FAILED', 'CANCELLED'))),
	CONSTRAINT "legacy_nxpkg_imports_lease_check" CHECK ((claimed_by IS NULL) = (lease_until IS NULL) AND (claimed_by IS NULL OR char_length(claimed_by) BETWEEN 1 AND 200)),
	CONSTRAINT "legacy_nxpkg_imports_shape_check" CHECK (char_length(file_name) BETWEEN 1 AND 255 AND char_length(file_path) BETWEEN 1 AND 4096 AND file_bytes > 0 AND (decisions_file_path IS NULL OR char_length(decisions_file_path) BETWEEN 1 AND 4096) AND (package_import_id IS NULL OR char_length(package_import_id) BETWEEN 1 AND 200) AND (package_source_fingerprint IS NULL OR char_length(package_source_fingerprint) BETWEEN 1 AND 200) AND (package_schema_version IS NULL OR char_length(package_schema_version) BETWEEN 1 AND 64) AND (converter_version IS NULL OR char_length(converter_version) BETWEEN 1 AND 64) AND jsonb_typeof(progress) = 'object')
);
--> statement-breakpoint
ALTER TABLE "legacy_history_records" ADD CONSTRAINT "legacy_history_records_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_history_records" ADD CONSTRAINT "legacy_history_records_tenant_import_fk" FOREIGN KEY ("tenant_id","nxpkg_import_id") REFERENCES "public"."legacy_nxpkg_imports"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_history_records" ADD CONSTRAINT "legacy_history_records_tenant_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_nxpkg_imports" ADD CONSTRAINT "legacy_nxpkg_imports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_nxpkg_imports" ADD CONSTRAINT "legacy_nxpkg_imports_tenant_requested_by_fk" FOREIGN KEY ("tenant_id","requested_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_nxpkg_imports" ADD CONSTRAINT "legacy_nxpkg_imports_tenant_approved_by_fk" FOREIGN KEY ("tenant_id","approved_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_nxpkg_imports" ADD CONSTRAINT "legacy_nxpkg_imports_tenant_dry_run_fk" FOREIGN KEY ("tenant_id","dry_run_legacy_run_id") REFERENCES "public"."legacy_import_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_nxpkg_imports" ADD CONSTRAINT "legacy_nxpkg_imports_tenant_apply_run_fk" FOREIGN KEY ("tenant_id","apply_legacy_run_id") REFERENCES "public"."legacy_import_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "legacy_history_records_customer_idx" ON "legacy_history_records" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "legacy_history_records_legacy_user_idx" ON "legacy_history_records" USING btree ("tenant_id","legacy_user_id");--> statement-breakpoint
CREATE INDEX "legacy_history_records_type_idx" ON "legacy_history_records" USING btree ("tenant_id","record_type");--> statement-breakpoint
CREATE INDEX "legacy_history_records_import_idx" ON "legacy_history_records" USING btree ("tenant_id","nxpkg_import_id");--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_nxpkg_imports_one_active_idx" ON "legacy_nxpkg_imports" USING btree ("tenant_id") WHERE NOT (status IN ('VERIFY_FAILED', 'DRY_RUN_FAILED', 'COMPLETED', 'COMPLETED_WITH_DISCREPANCY', 'FAILED', 'CANCELLED'));--> statement-breakpoint
CREATE INDEX "legacy_nxpkg_imports_poll_idx" ON "legacy_nxpkg_imports" USING btree ("status","lease_until");--> statement-breakpoint
CREATE INDEX "legacy_nxpkg_imports_tenant_created_idx" ON "legacy_nxpkg_imports" USING btree ("tenant_id","created_at");