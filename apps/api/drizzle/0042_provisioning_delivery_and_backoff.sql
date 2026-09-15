DROP INDEX "provisioning_operations_due_idx";--> statement-breakpoint
ALTER TABLE "provisioning_operations" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "delivery_state" text DEFAULT 'PENDING' NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "delivery_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "delivery_next_attempt_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "services_tenant_order_key" ON "services" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "services_delivery_due_idx" ON "services" USING btree ("delivery_next_attempt_at") WHERE delivery_state = 'PENDING';--> statement-breakpoint
CREATE INDEX "provisioning_operations_due_idx" ON "provisioning_operations" USING btree ("next_attempt_at","created_at") WHERE state = 'PLANNED';--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_delivery_state_check" CHECK (delivery_state IN ('PENDING', 'DELIVERED', 'UNCONFIRMED', 'FAILED'));--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_delivery_attempts_check" CHECK (delivery_attempts >= 0 AND delivery_attempts <= 100);--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_delivered_at_check" CHECK ((delivery_state = 'DELIVERED') = (delivered_at IS NOT NULL));