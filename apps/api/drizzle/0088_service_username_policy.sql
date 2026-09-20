CREATE TABLE "service_username_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"namespace_key" text NOT NULL,
	"username" text NOT NULL,
	"panel_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"funded_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_username_reservations_mode_check" CHECK (mode IN ('CUSTOM', 'RANDOM'))
);
--> statement-breakpoint
ALTER TABLE "panels" ADD COLUMN "allow_custom_username" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "panels" ADD COLUMN "allow_random_username" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "panels" ADD COLUMN "username_template" text;--> statement-breakpoint
ALTER TABLE "service_username_reservations" ADD CONSTRAINT "service_username_reservations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_username_reservations" ADD CONSTRAINT "service_username_reservations_tenant_panel_fk" FOREIGN KEY ("tenant_id","panel_id") REFERENCES "public"."panels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_username_reservations" ADD CONSTRAINT "service_username_reservations_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "service_username_reservations_name_key" ON "service_username_reservations" USING btree ("namespace_key","username");--> statement-breakpoint
CREATE UNIQUE INDEX "service_username_reservations_order_key" ON "service_username_reservations" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "service_username_reservations_expiry_idx" ON "service_username_reservations" USING btree ("funded_at","expires_at");--> statement-breakpoint
ALTER TABLE "panels" ADD CONSTRAINT "panels_username_policy_check" CHECK ("panels"."allow_custom_username" OR "panels"."allow_random_username");