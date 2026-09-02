CREATE TABLE "notification_released_claims" (
	"tenant_id" uuid NOT NULL,
	"notification_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"released_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "notification_released_claims_pk" PRIMARY KEY("tenant_id","notification_id","attempt_number"),
	CONSTRAINT "notification_released_claims_number_check" CHECK (attempt_number >= 1)
);
--> statement-breakpoint
ALTER TABLE "notification_released_claims" ADD CONSTRAINT "notification_released_claims_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_released_claims" ADD CONSTRAINT "notification_released_claims_tenant_notification_fk" FOREIGN KEY ("tenant_id","notification_id") REFERENCES "public"."notifications"("tenant_id","id") ON DELETE no action ON UPDATE no action;