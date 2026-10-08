CREATE TABLE "legacy_wallet_debts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"legacy_user_id" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"source_fingerprint" text NOT NULL,
	"row_checksum" text NOT NULL,
	"run_id" uuid NOT NULL,
	"synthetic" boolean NOT NULL,
	"state" text NOT NULL,
	"decision_reason" text,
	"decided_by_admin_id" uuid,
	"decided_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "legacy_wallet_debts_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "legacy_wallet_debts_tenant_customer_key" UNIQUE("tenant_id","customer_id"),
	CONSTRAINT "legacy_wallet_debts_tenant_legacy_user_key" UNIQUE("tenant_id","legacy_user_id"),
	CONSTRAINT "legacy_wallet_debts_state_check" CHECK (state IN ('PENDING_REVIEW', 'ACKNOWLEDGED', 'WAIVED')),
	CONSTRAINT "legacy_wallet_debts_amount_check" CHECK (amount_minor > 0 AND currency = 'IRT'),
	CONSTRAINT "legacy_wallet_debts_identity_check" CHECK (legacy_user_id ~ '^[1-9][0-9]{0,19}$' AND source_fingerprint ~ '^[0-9a-f]{64}$' AND row_checksum ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "legacy_wallet_debts_decision_check" CHECK ((state = 'PENDING_REVIEW' OR (decided_at IS NOT NULL AND decided_by_admin_id IS NOT NULL)) AND (decision_reason IS NULL OR char_length(decision_reason) BETWEEN 1 AND 500) AND version >= 1)
);
--> statement-breakpoint
ALTER TABLE "legacy_wallet_debts" ADD CONSTRAINT "legacy_wallet_debts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_wallet_debts" ADD CONSTRAINT "legacy_wallet_debts_tenant_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_wallet_debts" ADD CONSTRAINT "legacy_wallet_debts_tenant_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."legacy_import_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_wallet_debts" ADD CONSTRAINT "legacy_wallet_debts_tenant_admin_fk" FOREIGN KEY ("tenant_id","decided_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "legacy_wallet_debts_tenant_state_idx" ON "legacy_wallet_debts" USING btree ("tenant_id","state","id");