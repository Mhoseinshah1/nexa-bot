ALTER TABLE "payments" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "resolved_by_admin_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "resolution_note" text;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_resolved_by_admin_id_admins_id_fk" FOREIGN KEY ("resolved_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_pending_expiry_idx" ON "payments" USING btree ("tenant_id","expires_at") WHERE state = 'PENDING';--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_resolved_check" CHECK ((state IN ('FAILED', 'CANCELLED', 'EXPIRED')) = (resolved_at IS NOT NULL));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_resolution_reviewer_check" CHECK (resolved_by_admin_id IS NULL OR state = 'FAILED');--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_resolution_note_check" CHECK (resolution_note IS NULL OR resolved_at IS NOT NULL);