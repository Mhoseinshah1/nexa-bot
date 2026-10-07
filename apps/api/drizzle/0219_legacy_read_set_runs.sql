CREATE TABLE "legacy_read_set_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"read_set" text NOT NULL,
	"read_set_version" integer NOT NULL,
	"fingerprint_version" text NOT NULL,
	"read_set_fingerprint" text NOT NULL,
	"source_fingerprint" text NOT NULL,
	"source_schema_hash" text NOT NULL,
	"source_engine" text NOT NULL,
	"synthetic" boolean NOT NULL,
	"table_count" integer NOT NULL,
	"row_count" bigint NOT NULL,
	"code_version" text,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "legacy_read_set_runs_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "legacy_read_set_runs_observation_key" UNIQUE("tenant_id","read_set","read_set_version","read_set_fingerprint","source_fingerprint"),
	CONSTRAINT "legacy_read_set_runs_read_set_check" CHECK (read_set IN ('inventory')),
	CONSTRAINT "legacy_read_set_runs_version_check" CHECK (read_set_version BETWEEN 1 AND 9999 AND fingerprint_version = 'legacy-read-set:' || read_set || ':v' || read_set_version::text),
	CONSTRAINT "legacy_read_set_runs_hashes_check" CHECK (read_set_fingerprint ~ '^[0-9a-f]{64}$' AND source_fingerprint ~ '^[0-9a-f]{64}$' AND source_schema_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "legacy_read_set_runs_engine_check" CHECK (source_engine IN ('MYSQL', 'MARIADB', 'SYNTHETIC_FIXTURE')),
	CONSTRAINT "legacy_read_set_runs_counts_check" CHECK (table_count >= 0 AND row_count >= 0),
	CONSTRAINT "legacy_read_set_runs_code_version_check" CHECK (code_version IS NULL OR code_version ~ '^[A-Za-z0-9._+-]{1,64}$')
);
--> statement-breakpoint
ALTER TABLE "legacy_read_set_runs" ADD CONSTRAINT "legacy_read_set_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "legacy_read_set_runs_tenant_recorded_idx" ON "legacy_read_set_runs" USING btree ("tenant_id","recorded_at");