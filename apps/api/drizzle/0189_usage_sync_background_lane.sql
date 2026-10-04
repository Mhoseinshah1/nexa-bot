DROP INDEX "provisioning_operations_due_idx";--> statement-breakpoint
ALTER TABLE "provisioning_operations" ADD COLUMN "background" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "provisioning_operations_open_background_sync_key" ON "provisioning_operations" USING btree ("tenant_id","service_id") WHERE background AND state IN ('PLANNED', 'IN_FLIGHT');--> statement-breakpoint
CREATE INDEX "provisioning_operations_due_idx" ON "provisioning_operations" USING btree ("tenant_id","background","next_attempt_at" NULLS FIRST,"created_at") WHERE state = 'PLANNED';--> statement-breakpoint
ALTER TABLE "provisioning_operations" ADD CONSTRAINT "provisioning_operations_background_check" CHECK (NOT background OR (type = 'SYNC_USAGE' AND requested_by_customer_id IS NULL));