ALTER TABLE "legacy_import_map" DROP CONSTRAINT "legacy_import_map_reason_check";--> statement-breakpoint
ALTER TABLE "legacy_import_map" ADD COLUMN "review_state" text;--> statement-breakpoint
ALTER TABLE "legacy_import_map" ADD COLUMN "review_resolution_code" text;--> statement-breakpoint
ALTER TABLE "legacy_import_map" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "legacy_import_map" ADD COLUMN "reviewed_by_actor_type" text;--> statement-breakpoint
ALTER TABLE "legacy_import_map" ADD COLUMN "reviewed_by_actor_id" text;--> statement-breakpoint
ALTER TABLE "legacy_import_map" ADD COLUMN "review_reopened_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "legacy_import_map" ADD COLUMN "ref" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
-- ===== HAND-WRITTEN (not generated): backfill before the review CHECKs are added. =====
-- Rows written before 0192 have no review state. A MANUAL_REVIEW row enters the queue OPEN.
-- A MANUAL_REVIEW row whose reason is not a review reason (only a non-conforming writer
-- could have made one; the P7 importer was on HOLD) becomes FAILED with its reason kept, which
-- a rerun processes again (resumeDecision -> PROCESS) — never dropped, never guessed.
UPDATE "legacy_import_map" SET "status" = 'FAILED'
  WHERE "status" = 'MANUAL_REVIEW'
    AND "reason_code" NOT IN ('PROVIDER_MISSING', 'AMBIGUOUS_PANEL', 'USERNAME_CASE_COLLISION', 'PANEL_UNMAPPED', 'INVENTORY_INCOMPLETE', 'CUSTOMER_MISSING', 'PRODUCT_MAPPING_UNRESOLVED', 'SUBSCRIPTION_REF_BLOCKED', 'INVALID_PHONE', 'CONFLICTING_EXISTING_ENTITY', 'UNSUPPORTED_SHAPE', 'INVALID_SOURCE_ROW');--> statement-breakpoint
UPDATE "legacy_import_map" SET "review_state" = 'OPEN' WHERE "status" = 'MANUAL_REVIEW';--> statement-breakpoint
-- ===== END HAND-WRITTEN =====
CREATE INDEX "legacy_import_map_review_queue_idx" ON "legacy_import_map" USING btree ("tenant_id","review_state","legacy_table","legacy_id") WHERE status = 'MANUAL_REVIEW';--> statement-breakpoint
ALTER TABLE "legacy_import_map" ADD CONSTRAINT "legacy_import_map_tenant_ref_key" UNIQUE("tenant_id","ref");--> statement-breakpoint
ALTER TABLE "legacy_import_map" ADD CONSTRAINT "legacy_import_map_review_reason_check" CHECK (status <> 'MANUAL_REVIEW' OR reason_code IN ('PROVIDER_MISSING', 'AMBIGUOUS_PANEL', 'USERNAME_CASE_COLLISION', 'PANEL_UNMAPPED', 'INVENTORY_INCOMPLETE', 'CUSTOMER_MISSING', 'PRODUCT_MAPPING_UNRESOLVED', 'SUBSCRIPTION_REF_BLOCKED', 'INVALID_PHONE', 'CONFLICTING_EXISTING_ENTITY', 'UNSUPPORTED_SHAPE', 'INVALID_SOURCE_ROW'));--> statement-breakpoint
ALTER TABLE "legacy_import_map" ADD CONSTRAINT "legacy_import_map_review_state_check" CHECK (CASE status
            WHEN 'MANUAL_REVIEW' THEN review_state IS NOT NULL AND review_state IN ('OPEN', 'RESOLVED', 'DISMISSED')
            ELSE review_state IS NULL
          END);--> statement-breakpoint
ALTER TABLE "legacy_import_map" ADD CONSTRAINT "legacy_import_map_review_resolution_check" CHECK (CASE
            WHEN review_state IN ('RESOLVED', 'DISMISSED') THEN
              reviewed_at IS NOT NULL AND reviewed_by_actor_type IS NOT NULL
              AND reviewed_by_actor_id IS NOT NULL
              AND CASE review_state
                    WHEN 'RESOLVED' THEN review_resolution_code IN ('RETRY_AFTER_FIX', 'HANDLED_OUTSIDE_IMPORT')
                    ELSE review_resolution_code IN ('WILL_NOT_IMPORT', 'TEST_OR_INVALID_DATA', 'DUPLICATE_RECORD')
                  END
            ELSE review_resolution_code IS NULL AND reviewed_at IS NULL
              AND reviewed_by_actor_type IS NULL AND reviewed_by_actor_id IS NULL
          END);--> statement-breakpoint
ALTER TABLE "legacy_import_map" ADD CONSTRAINT "legacy_import_map_reviewed_by_actor_type_check" CHECK (reviewed_by_actor_type IS NULL OR reviewed_by_actor_type IN ('CUSTOMER', 'TELEGRAM_ADMIN', 'WEB_ADMIN', 'SYSTEM_JOB', 'API', 'PROVIDER_SYNC'));--> statement-breakpoint
ALTER TABLE "legacy_import_map" ADD CONSTRAINT "legacy_import_map_reviewed_by_actor_id_check" CHECK (reviewed_by_actor_id IS NULL OR reviewed_by_actor_id ~ '^[A-Za-z0-9._:-]{1,128}$');--> statement-breakpoint
ALTER TABLE "legacy_import_map" ADD CONSTRAINT "legacy_import_map_review_reopened_check" CHECK (review_reopened_count >= 0);--> statement-breakpoint
ALTER TABLE "legacy_import_map" ADD CONSTRAINT "legacy_import_map_reason_check" CHECK (reason_code IS NULL OR reason_code IN ('PROVIDER_MISSING', 'AMBIGUOUS_PANEL', 'PANEL_UNMAPPED', 'USERNAME_CASE_COLLISION', 'TEST_PANEL', 'HISTORY_NOT_IMPORTED', 'EXISTING_CUSTOMER', 'NEGATIVE_BALANCE', 'INVALID_SOURCE_ROW', 'PROVIDER_READ_FAILED', 'INTERNAL_ERROR', 'INVENTORY_INCOMPLETE', 'CUSTOMER_MISSING', 'PRODUCT_MAPPING_UNRESOLVED', 'SUBSCRIPTION_REF_BLOCKED', 'INVALID_PHONE', 'CONFLICTING_EXISTING_ENTITY', 'UNSUPPORTED_SHAPE'));