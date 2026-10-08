CREATE TABLE "legacy_service_candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invoice_key" text NOT NULL,
	"run_id" uuid NOT NULL,
	"source_fingerprint" text NOT NULL,
	"synthetic" boolean NOT NULL,
	"invoice_checksum" text NOT NULL,
	"outcome" text NOT NULL,
	"blocker" text,
	"evidence" jsonb NOT NULL,
	"evidence_hash" text NOT NULL,
	"panel_code" text,
	"product_code" text,
	"archive_id" uuid,
	"service_id" uuid,
	"review_state" text NOT NULL,
	"approved_panel_id" uuid,
	"approved_checksum" text,
	"approved_outcome" text,
	"last_approval_refusal" text,
	"decision_reason" text,
	"decided_by_admin_id" uuid,
	"decided_at" timestamp with time zone,
	"observed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"first_decided_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "legacy_service_candidates_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "legacy_service_candidates_tenant_invoice_key" UNIQUE("tenant_id","invoice_key"),
	CONSTRAINT "legacy_service_candidates_outcome_check" CHECK (outcome IN ('ADOPTED', 'ALREADY_ADOPTED', 'ADOPTION_ELIGIBLE', 'INVOICE_KEY_INVALID', 'TEST_INVOICE_SKIPPED', 'TEST_PANEL_SKIPPED', 'INVALID_SOURCE_ROW', 'ORPHAN', 'CUSTOMER_NOT_IMPORTED', 'INVALID_USERNAME', 'INVENTORY_INCOMPLETE', 'NO_PANEL', 'PANEL_UNMAPPED', 'PROVIDER_MISSING', 'AMBIGUOUS_PANEL', 'USERNAME_CASE_COLLISION', 'AMBIGUOUS_OWNERSHIP', 'UNSUPPORTED_SHAPE', 'PRODUCT_UNRESOLVED', 'SUBSCRIPTION_REF_BLOCKED', 'PROVIDER_READ_FAILED', 'REVIEW_CLOSED')),
	CONSTRAINT "legacy_service_candidates_review_state_check" CHECK (review_state IN ('OPEN', 'ACKNOWLEDGED', 'KEPT_AS_HISTORY', 'ADOPT_APPROVED', 'ADOPTING', 'ADOPTED')),
	CONSTRAINT "legacy_service_candidates_adopted_check" CHECK (((service_id IS NOT NULL) = (outcome IN ('ADOPTED', 'ALREADY_ADOPTED'))) AND ((review_state = 'ADOPTED') = (outcome IN ('ADOPTED', 'ALREADY_ADOPTED')))),
	CONSTRAINT "legacy_service_candidates_approval_check" CHECK (((approved_checksum IS NOT NULL) = (review_state IN ('ADOPT_APPROVED', 'ADOPTING'))) AND ((approved_outcome IS NOT NULL) = (approved_checksum IS NOT NULL)) AND (approved_panel_id IS NULL OR approved_checksum IS NOT NULL) AND (approved_outcome IS NULL OR approved_outcome IN ('ADOPTED', 'ALREADY_ADOPTED', 'ADOPTION_ELIGIBLE', 'INVOICE_KEY_INVALID', 'TEST_INVOICE_SKIPPED', 'TEST_PANEL_SKIPPED', 'INVALID_SOURCE_ROW', 'ORPHAN', 'CUSTOMER_NOT_IMPORTED', 'INVALID_USERNAME', 'INVENTORY_INCOMPLETE', 'NO_PANEL', 'PANEL_UNMAPPED', 'PROVIDER_MISSING', 'AMBIGUOUS_PANEL', 'USERNAME_CASE_COLLISION', 'AMBIGUOUS_OWNERSHIP', 'UNSUPPORTED_SHAPE', 'PRODUCT_UNRESOLVED', 'SUBSCRIPTION_REF_BLOCKED', 'PROVIDER_READ_FAILED', 'REVIEW_CLOSED'))),
	CONSTRAINT "legacy_service_candidates_decision_check" CHECK ((review_state NOT IN ('ACKNOWLEDGED', 'KEPT_AS_HISTORY', 'ADOPT_APPROVED', 'ADOPTING') OR (decided_at IS NOT NULL AND decided_by_admin_id IS NOT NULL AND decision_reason IS NOT NULL)) AND (decision_reason IS NULL OR char_length(decision_reason) BETWEEN 1 AND 500) AND version >= 1),
	CONSTRAINT "legacy_service_candidates_shape_check" CHECK (char_length(invoice_key) BETWEEN 1 AND 1000 AND (panel_code IS NULL OR (panel_code <> '' AND panel_code = btrim(panel_code) AND char_length(panel_code) <= 1000)) AND (product_code IS NULL OR (product_code <> '' AND product_code = btrim(product_code) AND char_length(product_code) <= 1000)) AND jsonb_typeof(evidence) = 'object' AND (blocker IS NULL OR blocker ~ '^[A-Z_]{1,64}$') AND (last_approval_refusal IS NULL OR last_approval_refusal ~ '^[A-Z_]{1,64}$')),
	CONSTRAINT "legacy_service_candidates_hashes_check" CHECK (source_fingerprint ~ '^[0-9a-f]{64}$' AND invoice_checksum ~ '^[0-9a-f]{64}$' AND evidence_hash ~ '^[0-9a-f]{64}$' AND (approved_checksum IS NULL OR approved_checksum ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
ALTER TABLE "legacy_service_candidates" ADD CONSTRAINT "legacy_service_candidates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_service_candidates" ADD CONSTRAINT "legacy_service_candidates_tenant_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."legacy_import_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_service_candidates" ADD CONSTRAINT "legacy_service_candidates_tenant_archive_fk" FOREIGN KEY ("tenant_id","archive_id") REFERENCES "public"."legacy_invoice_archive"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_service_candidates" ADD CONSTRAINT "legacy_service_candidates_tenant_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_service_candidates" ADD CONSTRAINT "legacy_service_candidates_tenant_panel_fk" FOREIGN KEY ("tenant_id","approved_panel_id") REFERENCES "public"."panels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_service_candidates" ADD CONSTRAINT "legacy_service_candidates_tenant_admin_fk" FOREIGN KEY ("tenant_id","decided_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "legacy_service_candidates_outcome_idx" ON "legacy_service_candidates" USING btree ("tenant_id","outcome","id");--> statement-breakpoint
CREATE INDEX "legacy_service_candidates_review_idx" ON "legacy_service_candidates" USING btree ("tenant_id","review_state","id");--> statement-breakpoint
CREATE INDEX "legacy_service_candidates_panel_idx" ON "legacy_service_candidates" USING btree ("tenant_id","panel_code","id");--> statement-breakpoint
CREATE INDEX "legacy_service_candidates_product_idx" ON "legacy_service_candidates" USING btree ("tenant_id","product_code","id");