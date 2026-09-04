ALTER TABLE "panel_health" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "panel_health" ADD COLUMN "next_probe_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "panel_health_next_probe_idx" ON "panel_health" USING btree ("next_probe_at");--> statement-breakpoint
CREATE INDEX "panels_monitor_active_idx" ON "panels" USING btree ("tenant_id","id") WHERE status = 'ACTIVE';