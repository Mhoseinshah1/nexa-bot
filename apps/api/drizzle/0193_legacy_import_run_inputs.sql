CREATE TABLE "legacy_import_run_inputs" (
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"source_engine" text NOT NULL,
	"source_schema_hash" text NOT NULL,
	"panel_mapping_fingerprint" text NOT NULL,
	"wallet_currency" text NOT NULL,
	"pre_import_wallet_total_minor" bigint NOT NULL,
	"pre_import_customers" integer NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "legacy_import_run_inputs_pk" PRIMARY KEY("tenant_id","run_id"),
	CONSTRAINT "legacy_import_run_inputs_engine_check" CHECK (source_engine IN ('MYSQL', 'MARIADB', 'SYNTHETIC_FIXTURE')),
	CONSTRAINT "legacy_import_run_inputs_hashes_check" CHECK (source_schema_hash ~ '^[0-9a-f]{64}$' AND panel_mapping_fingerprint ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "legacy_import_run_inputs_currency_check" CHECK (wallet_currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "legacy_import_run_inputs_customers_check" CHECK (pre_import_customers >= 0)
);
--> statement-breakpoint
ALTER TABLE "legacy_import_run_inputs" ADD CONSTRAINT "legacy_import_run_inputs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_import_run_inputs" ADD CONSTRAINT "legacy_import_run_inputs_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."legacy_import_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;