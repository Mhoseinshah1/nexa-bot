CREATE TABLE "service_reminders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"basis_expires_at" timestamp with time zone,
	"basis_traffic_limit_bytes" bigint,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_reminders_kind_check" CHECK (kind IN ('EXPIRING_3D', 'EXPIRING_1D', 'EXPIRED', 'USAGE_80', 'USAGE_95', 'USAGE_100')),
	CONSTRAINT "service_reminders_basis_check" CHECK (("service_reminders"."basis_expires_at" IS NULL) <> ("service_reminders"."basis_traffic_limit_bytes" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "customer_notifications" DROP CONSTRAINT "customer_notifications_kind_check";--> statement-breakpoint
ALTER TABLE "service_reminders" ADD CONSTRAINT "service_reminders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_reminders" ADD CONSTRAINT "service_reminders_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "service_reminders_kind_key" ON "service_reminders" USING btree ("tenant_id","service_id","kind");--> statement-breakpoint
CREATE INDEX "service_reminders_raised_idx" ON "service_reminders" USING btree ("tenant_id","raised_at");--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_kind_check" CHECK (kind IN ('PAYMENT_REJECTED', 'PAYMENT_EXPIRED', 'ORDER_EXPIRED', 'SERVICE_ACTION_SUCCEEDED', 'SERVICE_ACTION_FAILED', 'SERVICE_PROVISION_DELAYED', 'PAYMENT_TRANSFER_RECORDED', 'ORDER_CANCELLED', 'WALLET_TOPUP_CREDITED', 'ORDER_REFUNDED_TO_WALLET', 'SERVICE_EXPIRING_3D', 'SERVICE_EXPIRING_1D', 'SERVICE_EXPIRED', 'SERVICE_USAGE_80', 'SERVICE_USAGE_95', 'SERVICE_USAGE_100'));