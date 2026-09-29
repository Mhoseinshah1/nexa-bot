CREATE TABLE "wallet_threshold_alerts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"threshold_amount" bigint NOT NULL,
	"crossing_entry_id" uuid NOT NULL,
	"crossed_at" timestamp with time zone NOT NULL,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_threshold_alerts_crossing_key" UNIQUE("tenant_id","crossing_entry_id"),
	CONSTRAINT "wallet_threshold_alerts_currency_check" CHECK (currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "wallet_threshold_alerts_threshold_check" CHECK (threshold_amount > 0)
);
--> statement-breakpoint
ALTER TABLE "customer_notifications" DROP CONSTRAINT "customer_notifications_kind_check";--> statement-breakpoint
ALTER TABLE "service_reminders" DROP CONSTRAINT "service_reminders_kind_check";--> statement-breakpoint
ALTER TABLE "wallet_threshold_alerts" ADD CONSTRAINT "wallet_threshold_alerts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_threshold_alerts" ADD CONSTRAINT "wallet_threshold_alerts_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_threshold_alerts" ADD CONSTRAINT "wallet_threshold_alerts_crossing_entry_fk" FOREIGN KEY ("tenant_id","crossing_entry_id") REFERENCES "public"."wallet_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wallet_threshold_alerts_wallet_idx" ON "wallet_threshold_alerts" USING btree ("tenant_id","customer_id","currency","crossed_at");--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_kind_check" CHECK (kind IN ('PAYMENT_REJECTED', 'PAYMENT_EXPIRED', 'ORDER_EXPIRED', 'SERVICE_ACTION_SUCCEEDED', 'SERVICE_ACTION_FAILED', 'SERVICE_PROVISION_DELAYED', 'PAYMENT_TRANSFER_RECORDED', 'ORDER_CANCELLED', 'WALLET_TOPUP_CREDITED', 'ORDER_REFUNDED_TO_WALLET', 'SERVICE_EXPIRY_FIRST', 'SERVICE_EXPIRY_SECOND', 'SERVICE_EXPIRED', 'SERVICE_USAGE_FIRST', 'SERVICE_USAGE_SECOND', 'SERVICE_USAGE_FINAL', 'TRIAL_NOT_DELIVERED', 'RECEIPT_CREDITED_TO_WALLET', 'WALLET_TOPUP_GIFT_CREDITED', 'REFUND_COMPLETED', 'GATEWAY_PAYMENT_FAILED', 'SERVICE_REFUND_REQUEST_REGISTERED', 'SERVICE_REFUND_REQUEST_APPROVED', 'SERVICE_REFUND_REQUEST_REJECTED', 'SERVICE_TRANSFER_RECEIVED', 'TICKET_REPLY', 'SERVICE_EXPIRY_EARLY', 'SERVICE_EXPIRY_DAY', 'WALLET_LOW_BALANCE', 'PAYMENT_PENDING_REMINDER', 'ORDER_PENDING_REMINDER'));--> statement-breakpoint
ALTER TABLE "service_reminders" ADD CONSTRAINT "service_reminders_kind_check" CHECK (kind IN ('EXPIRY_FIRST', 'EXPIRY_SECOND', 'EXPIRED', 'USAGE_FIRST', 'USAGE_SECOND', 'USAGE_FINAL', 'EXPIRY_EARLY', 'EXPIRY_DAY'));