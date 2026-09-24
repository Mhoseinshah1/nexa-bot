CREATE TABLE "admin_amount_captures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	"admin_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"amount_minor" bigint,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	CONSTRAINT "admin_amount_captures_close_reason_check" CHECK (close_reason IS NULL OR close_reason IN ('CONFIRMED', 'CANCELLED', 'SUPERSEDED', 'EXPIRED')),
	CONSTRAINT "admin_amount_captures_closed_check" CHECK ((closed_at IS NULL) = (close_reason IS NULL)),
	CONSTRAINT "admin_amount_captures_expiry_check" CHECK (expires_at > opened_at),
	CONSTRAINT "admin_amount_captures_amount_check" CHECK (amount_minor IS NULL OR amount_minor > 0),
	CONSTRAINT "admin_amount_captures_confirmed_check" CHECK (close_reason IS DISTINCT FROM 'CONFIRMED' OR amount_minor IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "admin_amount_captures" ADD CONSTRAINT "admin_amount_captures_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_amount_captures" ADD CONSTRAINT "admin_amount_captures_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_amount_captures" ADD CONSTRAINT "admin_amount_captures_admin_fk" FOREIGN KEY ("tenant_id","admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_amount_captures" ADD CONSTRAINT "admin_amount_captures_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_amount_captures_open_key" ON "admin_amount_captures" USING btree ("tenant_id","bot_instance_id","admin_id") WHERE closed_at IS NULL;