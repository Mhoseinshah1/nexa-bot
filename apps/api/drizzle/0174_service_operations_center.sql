ALTER TABLE "bulk_operations" DROP CONSTRAINT "bulk_operations_kind_check";--> statement-breakpoint
ALTER TABLE "bulk_operations" DROP CONSTRAINT "bulk_operations_grant_check";--> statement-breakpoint
ALTER TABLE "bulk_operations" ADD COLUMN "retry_of_id" uuid;--> statement-breakpoint
ALTER TABLE "bulk_operations" ADD CONSTRAINT "bulk_operations_retry_of_fk" FOREIGN KEY ("tenant_id","retry_of_id") REFERENCES "public"."bulk_operations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bulk_operations_retry_of_idx" ON "bulk_operations" USING btree ("tenant_id","retry_of_id") WHERE retry_of_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "bulk_operations" ADD CONSTRAINT "bulk_operations_kind_check" CHECK (kind IN ('WALLET_CREDIT', 'SERVICE_TRAFFIC', 'SERVICE_TIME', 'SERVICE_SUSPEND', 'SERVICE_RESUME'));--> statement-breakpoint
ALTER TABLE "bulk_operations" ADD CONSTRAINT "bulk_operations_grant_check" CHECK (CASE kind
            WHEN 'WALLET_CREDIT' THEN amount_minor IS NOT NULL AND amount_minor > 0
                 AND currency IS NOT NULL AND traffic_bytes IS NULL AND duration_days IS NULL
            WHEN 'SERVICE_TRAFFIC' THEN traffic_bytes IS NOT NULL AND traffic_bytes > 0
                 AND amount_minor IS NULL AND currency IS NULL AND duration_days IS NULL
            WHEN 'SERVICE_TIME' THEN duration_days IS NOT NULL AND duration_days > 0
                 AND amount_minor IS NULL AND currency IS NULL AND traffic_bytes IS NULL
            WHEN 'SERVICE_SUSPEND' THEN amount_minor IS NULL AND currency IS NULL
                 AND traffic_bytes IS NULL AND duration_days IS NULL AND NOT notify
            WHEN 'SERVICE_RESUME' THEN amount_minor IS NULL AND currency IS NULL
                 AND traffic_bytes IS NULL AND duration_days IS NULL AND NOT notify
            ELSE false
          END);