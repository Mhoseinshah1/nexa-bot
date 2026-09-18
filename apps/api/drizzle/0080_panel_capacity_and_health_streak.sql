CREATE TABLE "panel_capacity_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"panel_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "panel_health" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "panels" ADD COLUMN "max_services" integer;--> statement-breakpoint
ALTER TABLE "panel_capacity_reservations" ADD CONSTRAINT "panel_capacity_reservations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panel_capacity_reservations" ADD CONSTRAINT "panel_capacity_reservations_tenant_panel_fk" FOREIGN KEY ("tenant_id","panel_id") REFERENCES "public"."panels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panel_capacity_reservations" ADD CONSTRAINT "panel_capacity_reservations_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "panel_capacity_reservations_order_key" ON "panel_capacity_reservations" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "panel_capacity_reservations_panel_idx" ON "panel_capacity_reservations" USING btree ("tenant_id","panel_id","expires_at");--> statement-breakpoint
ALTER TABLE "panels" ADD CONSTRAINT "panels_max_services_check" CHECK (max_services IS NULL OR max_services > 0);