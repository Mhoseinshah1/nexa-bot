CREATE TABLE "legacy_invoice_archive" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"invoice_key" text NOT NULL,
	"revision" integer NOT NULL,
	"revision_reason" text NOT NULL,
	"key_shape_evidenced" boolean NOT NULL,
	"raw_row" jsonb NOT NULL,
	"row_checksum" text NOT NULL,
	"archive_checksum" text NOT NULL,
	"classification" text NOT NULL,
	"live" boolean NOT NULL,
	"status" text,
	"is_test" boolean,
	"legacy_user_id" text,
	"owner_present" boolean NOT NULL,
	"username" text,
	"panel_code" text,
	"product_code" text,
	"product_ref" text NOT NULL,
	"product_name" text,
	"price_raw" text,
	"price_minor" bigint,
	"price_currency" text,
	"price_note" text,
	"sold_at_raw" text,
	"sold_at" timestamp with time zone,
	"sold_at_note" text,
	"read_set_fingerprint" text NOT NULL,
	"source_fingerprint" text NOT NULL,
	"normalization_version" text NOT NULL,
	"archived_at" timestamp with time zone NOT NULL,
	CONSTRAINT "legacy_invoice_archive_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "legacy_invoice_archive_revision_key" UNIQUE("tenant_id","invoice_key","revision"),
	CONSTRAINT "legacy_invoice_archive_class_check" CHECK ((classification IN ('KEY_SHAPE_UNRECOGNISED', 'TEST', 'TEST_FLAG_INVALID', 'ORPHAN_OWNER', 'NOT_LIVE', 'NO_PANEL', 'LIVE_CANDIDATE')) AND classification = CASE WHEN NOT key_shape_evidenced THEN 'KEY_SHAPE_UNRECOGNISED' WHEN is_test IS TRUE THEN 'TEST' WHEN is_test IS NULL THEN 'TEST_FLAG_INVALID' WHEN NOT owner_present THEN 'ORPHAN_OWNER' WHEN NOT live THEN 'NOT_LIVE' WHEN panel_code IS NULL THEN 'NO_PANEL' ELSE 'LIVE_CANDIDATE' END),
	CONSTRAINT "legacy_invoice_archive_revision_check" CHECK (revision >= 1 AND (revision_reason IN ('FIRST_SEEN', 'ROW_CHANGED', 'CONTEXT_CHANGED')) AND ((revision = 1) = (revision_reason = 'FIRST_SEEN'))),
	CONSTRAINT "legacy_invoice_archive_product_check" CHECK ((product_ref IN ('NONE', 'NAMED', 'NOT_IN_PRODUCT_TABLE')) AND ((product_code IS NULL) = (product_ref = 'NONE'))),
	CONSTRAINT "legacy_invoice_archive_price_check" CHECK (((price_minor IS NULL) = (price_currency IS NULL)) AND ((price_minor IS NULL) = (price_note IS NOT NULL)) AND (price_currency IS NULL OR price_currency = 'IRT') AND (price_minor IS NULL OR price_minor >= 0) AND (price_note IS NULL OR price_note IN ('ABSENT', 'EMPTY', 'NOT_A_NUMBER', 'OUT_OF_RANGE', 'FORMAT_UNKNOWN'))),
	CONSTRAINT "legacy_invoice_archive_sold_at_check" CHECK (((sold_at IS NULL) = (sold_at_note IS NOT NULL)) AND (sold_at_note IS NULL OR sold_at_note IN ('ABSENT', 'EMPTY', 'NOT_A_NUMBER', 'OUT_OF_RANGE', 'FORMAT_UNKNOWN'))),
	CONSTRAINT "legacy_invoice_archive_shape_check" CHECK (jsonb_typeof(raw_row) = 'object' AND char_length(invoice_key) <= 1000 AND (panel_code IS NULL OR (panel_code <> '' AND panel_code = btrim(panel_code))) AND (product_code IS NULL OR (product_code <> '' AND product_code = btrim(product_code)))),
	CONSTRAINT "legacy_invoice_archive_hashes_check" CHECK (row_checksum ~ '^[0-9a-f]{64}$' AND archive_checksum ~ '^[0-9a-f]{64}$' AND read_set_fingerprint ~ '^[0-9a-f]{64}$' AND source_fingerprint ~ '^[0-9a-f]{64}$' AND normalization_version ~ '^legacy-invoice-archive:v[1-9][0-9]{0,3}$')
);
--> statement-breakpoint
CREATE TABLE "legacy_invoice_archive_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"state" text NOT NULL,
	"failure_code" text,
	"read_set_version" integer NOT NULL,
	"read_set_fingerprint" text NOT NULL,
	"source_fingerprint" text NOT NULL,
	"source_schema_hash" text NOT NULL,
	"source_engine" text NOT NULL,
	"synthetic" boolean NOT NULL,
	"source_invoice_rows" bigint,
	"source_user_rows" bigint,
	"source_product_rows" bigint,
	"promoted_through" text,
	"promoted_rows" bigint DEFAULT 0 NOT NULL,
	"inserted_new" bigint DEFAULT 0 NOT NULL,
	"inserted_revision" bigint DEFAULT 0 NOT NULL,
	"unchanged" bigint DEFAULT 0 NOT NULL,
	"missing_in_snapshot" bigint,
	"archive_invoices_after" bigint,
	"code_version" text,
	"started_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "legacy_invoice_archive_runs_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "legacy_invoice_archive_runs_state_check" CHECK (state IN ('STAGING', 'VERIFIED', 'COMPLETED', 'FAILED')),
	CONSTRAINT "legacy_invoice_archive_runs_failure_check" CHECK ((failure_code IS NULL OR failure_code IN ('SNAPSHOT_DIVERGED', 'ABANDONED', 'STAGED_COUNT_MISMATCH', 'SOURCE_KEY_DUPLICATED', 'CELL_UNREPRESENTABLE', 'INTERRUPTED')) AND ((state = 'FAILED') = (failure_code IS NOT NULL))),
	CONSTRAINT "legacy_invoice_archive_runs_lifecycle_check" CHECK (((verified_at IS NOT NULL) = (state IN ('VERIFIED', 'COMPLETED'))) AND ((finished_at IS NOT NULL) = (state IN ('COMPLETED', 'FAILED'))) AND ((source_invoice_rows IS NOT NULL) = (verified_at IS NOT NULL)) AND ((source_user_rows IS NOT NULL) = (verified_at IS NOT NULL)) AND ((source_product_rows IS NOT NULL) = (verified_at IS NOT NULL)) AND (state IN ('VERIFIED', 'COMPLETED') OR (promoted_rows = 0 AND promoted_through IS NULL))),
	CONSTRAINT "legacy_invoice_archive_runs_closure_check" CHECK (promoted_rows = inserted_new + inserted_revision + unchanged AND (source_invoice_rows IS NULL OR promoted_rows <= source_invoice_rows) AND ((state = 'COMPLETED') = (missing_in_snapshot IS NOT NULL)) AND ((state = 'COMPLETED') = (archive_invoices_after IS NOT NULL)) AND (state <> 'COMPLETED' OR (promoted_rows = source_invoice_rows AND archive_invoices_after = source_invoice_rows + missing_in_snapshot))),
	CONSTRAINT "legacy_invoice_archive_runs_counts_check" CHECK (read_set_version BETWEEN 1 AND 9999 AND inserted_new >= 0 AND inserted_revision >= 0 AND unchanged >= 0 AND (source_invoice_rows IS NULL OR source_invoice_rows >= 0) AND (source_user_rows IS NULL OR source_user_rows >= 0) AND (source_product_rows IS NULL OR source_product_rows >= 0) AND (missing_in_snapshot IS NULL OR missing_in_snapshot >= 0)),
	CONSTRAINT "legacy_invoice_archive_runs_hashes_check" CHECK (read_set_fingerprint ~ '^[0-9a-f]{64}$' AND source_fingerprint ~ '^[0-9a-f]{64}$' AND source_schema_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "legacy_invoice_archive_runs_engine_check" CHECK (source_engine IN ('MYSQL', 'MARIADB', 'SYNTHETIC_FIXTURE')),
	CONSTRAINT "legacy_invoice_archive_runs_code_version_check" CHECK (code_version IS NULL OR code_version ~ '^[A-Za-z0-9._+-]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "legacy_invoice_archive_staging" (
	"run_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_table" text NOT NULL,
	"source_key" text NOT NULL,
	"lookup" text,
	"cells" jsonb,
	"row_checksum" text,
	CONSTRAINT "legacy_invoice_archive_staging_pk" PRIMARY KEY("run_id","source_table","source_key"),
	CONSTRAINT "legacy_invoice_archive_staging_table_check" CHECK (source_table IN ('invoice', 'user', 'product') AND ((source_table = 'invoice') = (cells IS NOT NULL)) AND ((source_table = 'invoice') = (row_checksum IS NOT NULL)) AND (cells IS NULL OR jsonb_typeof(cells) = 'object') AND (row_checksum IS NULL OR row_checksum ~ '^[0-9a-f]{64}$') AND (source_table <> 'user' OR lookup = source_key))
);
--> statement-breakpoint
ALTER TABLE "legacy_read_set_runs" DROP CONSTRAINT "legacy_read_set_runs_read_set_check";--> statement-breakpoint
ALTER TABLE "legacy_invoice_archive" ADD CONSTRAINT "legacy_invoice_archive_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_invoice_archive" ADD CONSTRAINT "legacy_invoice_archive_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."legacy_invoice_archive_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_invoice_archive_runs" ADD CONSTRAINT "legacy_invoice_archive_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_invoice_archive_staging" ADD CONSTRAINT "legacy_invoice_archive_staging_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_invoice_archive_staging" ADD CONSTRAINT "legacy_invoice_archive_staging_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."legacy_invoice_archive_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "legacy_invoice_archive_run_idx" ON "legacy_invoice_archive" USING btree ("tenant_id","run_id");--> statement-breakpoint
CREATE INDEX "legacy_invoice_archive_key_prefix_idx" ON "legacy_invoice_archive" USING btree ("tenant_id",invoice_key text_pattern_ops);--> statement-breakpoint
CREATE INDEX "legacy_invoice_archive_user_idx" ON "legacy_invoice_archive" USING btree ("tenant_id","legacy_user_id","invoice_key");--> statement-breakpoint
CREATE INDEX "legacy_invoice_archive_username_idx" ON "legacy_invoice_archive" USING btree ("tenant_id",lower(username) text_pattern_ops);--> statement-breakpoint
CREATE INDEX "legacy_invoice_archive_status_idx" ON "legacy_invoice_archive" USING btree ("tenant_id","status","invoice_key");--> statement-breakpoint
CREATE INDEX "legacy_invoice_archive_panel_idx" ON "legacy_invoice_archive" USING btree ("tenant_id","panel_code","invoice_key");--> statement-breakpoint
CREATE INDEX "legacy_invoice_archive_product_idx" ON "legacy_invoice_archive" USING btree ("tenant_id","product_code","invoice_key");--> statement-breakpoint
CREATE INDEX "legacy_invoice_archive_class_idx" ON "legacy_invoice_archive" USING btree ("tenant_id","classification","invoice_key");--> statement-breakpoint
CREATE INDEX "legacy_invoice_archive_test_idx" ON "legacy_invoice_archive" USING btree ("tenant_id","is_test","invoice_key");--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_invoice_archive_runs_one_open_idx" ON "legacy_invoice_archive_runs" USING btree ("tenant_id") WHERE state IN ('STAGING', 'VERIFIED');--> statement-breakpoint
CREATE INDEX "legacy_invoice_archive_runs_tenant_started_idx" ON "legacy_invoice_archive_runs" USING btree ("tenant_id","started_at");--> statement-breakpoint
CREATE INDEX "legacy_invoice_archive_staging_lookup_idx" ON "legacy_invoice_archive_staging" USING btree ("run_id","source_table","lookup");--> statement-breakpoint
ALTER TABLE "legacy_read_set_runs" ADD CONSTRAINT "legacy_read_set_runs_read_set_check" CHECK (read_set IN ('inventory', 'products', 'invoice-archive'));