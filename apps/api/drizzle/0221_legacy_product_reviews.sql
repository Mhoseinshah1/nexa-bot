CREATE TABLE "legacy_product_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code_product" text NOT NULL,
	"legacy_product_id" text NOT NULL,
	"legacy_facts" jsonb NOT NULL,
	"facts_checksum" text NOT NULL,
	"source_conflict" text,
	"title" text,
	"traffic_bytes" bigint,
	"duration_days" integer,
	"historical_price_raw" text,
	"historical_price_minor" bigint,
	"historical_price_currency" text,
	"parse_notes" jsonb NOT NULL,
	"live_invoice_count" integer NOT NULL,
	"state" text NOT NULL,
	"prior_state" text,
	"approved_product_id" uuid,
	"approved_facts_checksum" text,
	"decision_reason" text,
	"decided_by_admin_id" uuid,
	"decided_at" timestamp with time zone,
	"read_fingerprint" text NOT NULL,
	"source_fingerprint" text NOT NULL,
	"missing_since_read_fingerprint" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "legacy_product_reviews_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "legacy_product_reviews_tenant_code_key" UNIQUE("tenant_id","code_product"),
	CONSTRAINT "legacy_product_reviews_state_check" CHECK (state IN ('PENDING_REVIEW', 'APPROVED_EXISTING', 'APPROVED_NEW', 'REJECTED', 'SOURCE_CHANGED')),
	CONSTRAINT "legacy_product_reviews_prior_state_check" CHECK ((prior_state IS NULL OR prior_state IN ('APPROVED_EXISTING', 'APPROVED_NEW', 'REJECTED')) AND ((state = 'SOURCE_CHANGED') = (prior_state IS NOT NULL))),
	CONSTRAINT "legacy_product_reviews_conflict_check" CHECK ((source_conflict IS NULL OR source_conflict IN ('CODE_DUPLICATED')) AND jsonb_typeof(legacy_facts) = 'array' AND jsonb_array_length(legacy_facts) >= 1 AND ((source_conflict IS NULL) = (jsonb_array_length(legacy_facts) = 1))),
	CONSTRAINT "legacy_product_reviews_approval_check" CHECK (((approved_product_id IS NULL) = (approved_facts_checksum IS NULL)) AND (state NOT IN ('APPROVED_EXISTING', 'APPROVED_NEW') OR approved_product_id IS NOT NULL) AND (state NOT IN ('PENDING_REVIEW', 'REJECTED') OR approved_product_id IS NULL)),
	CONSTRAINT "legacy_product_reviews_decision_check" CHECK ((state NOT IN ('APPROVED_EXISTING', 'APPROVED_NEW', 'REJECTED') OR (decided_at IS NOT NULL AND decided_by_admin_id IS NOT NULL)) AND (decision_reason IS NULL OR char_length(decision_reason) BETWEEN 1 AND 500)),
	CONSTRAINT "legacy_product_reviews_price_check" CHECK (((historical_price_minor IS NULL) = (historical_price_currency IS NULL)) AND (historical_price_currency IS NULL OR historical_price_currency = 'IRT') AND (historical_price_minor IS NULL OR historical_price_minor >= 0)),
	CONSTRAINT "legacy_product_reviews_code_check" CHECK (char_length(code_product) BETWEEN 1 AND 200 AND code_product !~ '[[:cntrl:]]' AND code_product = btrim(code_product)),
	CONSTRAINT "legacy_product_reviews_hashes_check" CHECK (facts_checksum ~ '^[0-9a-f]{64}$' AND (approved_facts_checksum IS NULL OR approved_facts_checksum ~ '^[0-9a-f]{64}$') AND read_fingerprint ~ '^[0-9a-f]{64}$' AND source_fingerprint ~ '^[0-9a-f]{64}$' AND (missing_since_read_fingerprint IS NULL OR missing_since_read_fingerprint ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "legacy_product_reviews_counts_check" CHECK ((traffic_bytes IS NULL OR traffic_bytes >= 0) AND (duration_days IS NULL OR duration_days >= 0) AND live_invoice_count >= 0 AND version >= 1 AND jsonb_typeof(parse_notes) = 'object')
);
--> statement-breakpoint
ALTER TABLE "legacy_read_set_runs" DROP CONSTRAINT "legacy_read_set_runs_read_set_check";--> statement-breakpoint
ALTER TABLE "legacy_product_reviews" ADD CONSTRAINT "legacy_product_reviews_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_product_reviews" ADD CONSTRAINT "legacy_product_reviews_tenant_product_fk" FOREIGN KEY ("tenant_id","approved_product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_product_reviews" ADD CONSTRAINT "legacy_product_reviews_tenant_admin_fk" FOREIGN KEY ("tenant_id","decided_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "legacy_product_reviews_tenant_state_idx" ON "legacy_product_reviews" USING btree ("tenant_id","state");--> statement-breakpoint
ALTER TABLE "legacy_read_set_runs" ADD CONSTRAINT "legacy_read_set_runs_read_set_check" CHECK (read_set IN ('inventory', 'products'));