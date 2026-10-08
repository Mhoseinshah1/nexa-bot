CREATE TABLE "legacy_cutover_approval_revocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"approval_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"revoked_by_admin_id" uuid NOT NULL,
	"revoked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "legacy_cutover_approval_revocations_approval_key" UNIQUE("tenant_id","approval_id"),
	CONSTRAINT "legacy_cutover_approval_revocations_reason_check" CHECK (char_length(reason) BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE TABLE "legacy_cutover_approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source_fingerprint" text NOT NULL,
	"panel_map_fingerprint" text NOT NULL,
	"inventory_fingerprint" text NOT NULL,
	"products_fingerprint" text NOT NULL,
	"invoice_archive_fingerprint" text NOT NULL,
	"freeze_proof_sha256" text NOT NULL,
	"final_dump_sha256" text NOT NULL,
	"prior_source_fingerprint" text,
	"synthetic" boolean NOT NULL,
	"reason" text NOT NULL,
	"approved_by_admin_id" uuid NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	CONSTRAINT "legacy_cutover_approvals_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "legacy_cutover_approvals_kind_check" CHECK (kind IN ('CUTOVER', 'RERUN_OVER_PRIOR_IMPORT')),
	CONSTRAINT "legacy_cutover_approvals_hashes_check" CHECK (source_fingerprint ~ '^[0-9a-f]{64}$' AND panel_map_fingerprint ~ '^[0-9a-f]{64}$' AND inventory_fingerprint ~ '^[0-9a-f]{64}$' AND products_fingerprint ~ '^[0-9a-f]{64}$' AND invoice_archive_fingerprint ~ '^[0-9a-f]{64}$' AND freeze_proof_sha256 ~ '^[0-9a-f]{64}$' AND final_dump_sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "legacy_cutover_approvals_prior_check" CHECK (CASE kind WHEN 'CUTOVER' THEN prior_source_fingerprint IS NULL ELSE prior_source_fingerprint ~ '^[0-9a-f]{64}$' AND prior_source_fingerprint <> source_fingerprint END),
	CONSTRAINT "legacy_cutover_approvals_reason_check" CHECK (char_length(reason) BETWEEN 1 AND 500)
);
--> statement-breakpoint
ALTER TABLE "legacy_cutover_approval_revocations" ADD CONSTRAINT "legacy_cutover_approval_revocations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_cutover_approval_revocations" ADD CONSTRAINT "legacy_cutover_approval_revocations_approval_fk" FOREIGN KEY ("tenant_id","approval_id") REFERENCES "public"."legacy_cutover_approvals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_cutover_approval_revocations" ADD CONSTRAINT "legacy_cutover_approval_revocations_tenant_admin_fk" FOREIGN KEY ("tenant_id","revoked_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_cutover_approvals" ADD CONSTRAINT "legacy_cutover_approvals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_cutover_approvals" ADD CONSTRAINT "legacy_cutover_approvals_tenant_admin_fk" FOREIGN KEY ("tenant_id","approved_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "legacy_cutover_approvals_tenant_source_idx" ON "legacy_cutover_approvals" USING btree ("tenant_id","source_fingerprint","id");