CREATE TABLE "customer_notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"send_started_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_notifications_subject_key" UNIQUE("tenant_id","kind","subject_id"),
	CONSTRAINT "customer_notifications_kind_check" CHECK (kind IN ('PAYMENT_REJECTED', 'PAYMENT_EXPIRED', 'ORDER_EXPIRED', 'SERVICE_ACTION_SUCCEEDED', 'SERVICE_ACTION_FAILED', 'SERVICE_PROVISION_DELAYED')),
	CONSTRAINT "customer_notifications_state_check" CHECK (state IN ('PENDING', 'DELIVERED', 'UNCONFIRMED', 'FAILED', 'SUPERSEDED')),
	CONSTRAINT "customer_notifications_resolved_check" CHECK ((state <> 'PENDING') = (resolved_at IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_notifications_due_idx" ON "customer_notifications" USING btree ("next_attempt_at") WHERE state = 'PENDING';