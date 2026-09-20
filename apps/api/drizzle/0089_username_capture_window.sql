CREATE TABLE "username_captures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	CONSTRAINT "username_captures_close_reason_check" CHECK (close_reason IS NULL OR close_reason IN ('RECEIVED', 'SUPERSEDED', 'EXPIRED')),
	CONSTRAINT "username_captures_closed_check" CHECK ((closed_at IS NULL) = (close_reason IS NULL)),
	CONSTRAINT "username_captures_expiry_check" CHECK (expires_at > opened_at)
);
--> statement-breakpoint
ALTER TABLE "username_captures" ADD CONSTRAINT "username_captures_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "username_captures" ADD CONSTRAINT "username_captures_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "username_captures" ADD CONSTRAINT "username_captures_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "username_captures" ADD CONSTRAINT "username_captures_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "username_captures_open_key" ON "username_captures" USING btree ("tenant_id","bot_instance_id","customer_id") WHERE closed_at IS NULL;--> statement-breakpoint
CREATE INDEX "username_captures_due_idx" ON "username_captures" USING btree ("tenant_id","expires_at") WHERE closed_at IS NULL;