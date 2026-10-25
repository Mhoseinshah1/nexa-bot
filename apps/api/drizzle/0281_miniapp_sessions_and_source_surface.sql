CREATE TABLE "miniapp_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"telegram_user_id" text NOT NULL,
	"init_data_hash" text NOT NULL,
	"token_hash" text NOT NULL,
	"auth_date" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "miniapp_sessions_init_hash_check" CHECK (init_data_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "miniapp_sessions_token_hash_check" CHECK (token_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "miniapp_sessions_window_check" CHECK (expires_at > created_at)
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "source_surface" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "source_surface" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "source_surface" text;--> statement-breakpoint
ALTER TABLE "miniapp_sessions" ADD CONSTRAINT "miniapp_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "miniapp_sessions" ADD CONSTRAINT "miniapp_sessions_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "miniapp_sessions" ADD CONSTRAINT "miniapp_sessions_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "miniapp_sessions_launch_key" ON "miniapp_sessions" USING btree ("tenant_id","bot_instance_id","init_data_hash");--> statement-breakpoint
CREATE INDEX "miniapp_sessions_tenant_customer_idx" ON "miniapp_sessions" USING btree ("tenant_id","customer_id","created_at");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_source_surface_check" CHECK (source_surface IS NULL OR source_surface IN ('TELEGRAM', 'WEB', 'WORKER', 'SCHEDULER', 'API', 'MINI_APP'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_source_surface_check" CHECK (source_surface IS NULL OR source_surface IN ('TELEGRAM', 'WEB', 'WORKER', 'SCHEDULER', 'API', 'MINI_APP'));--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_source_surface_check" CHECK (source_surface IS NULL OR source_surface IN ('TELEGRAM', 'WEB', 'WORKER', 'SCHEDULER', 'API', 'MINI_APP'));