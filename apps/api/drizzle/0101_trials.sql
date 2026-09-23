ALTER TABLE "customer_notifications" DROP CONSTRAINT "customer_notifications_kind_check";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_purpose_check";--> statement-breakpoint
DROP INDEX "trial_grants_customer_key";--> statement-breakpoint
ALTER TABLE "trial_grants" ADD COLUMN "order_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "trial_grants" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trial_grants" ADD CONSTRAINT "trial_grants_order_fk" FOREIGN KEY ("tenant_id","order_id","customer_id") REFERENCES "public"."orders"("tenant_id","id","customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trial_grants_order_key" ON "trial_grants" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "trial_grants_customer_counting_idx" ON "trial_grants" USING btree ("tenant_id","customer_id") WHERE released_at IS NULL;--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_kind_check" CHECK (kind IN ('PAYMENT_REJECTED', 'PAYMENT_EXPIRED', 'ORDER_EXPIRED', 'SERVICE_ACTION_SUCCEEDED', 'SERVICE_ACTION_FAILED', 'SERVICE_PROVISION_DELAYED', 'PAYMENT_TRANSFER_RECORDED', 'ORDER_CANCELLED', 'WALLET_TOPUP_CREDITED', 'ORDER_REFUNDED_TO_WALLET', 'SERVICE_EXPIRY_FIRST', 'SERVICE_EXPIRY_SECOND', 'SERVICE_EXPIRED', 'SERVICE_USAGE_FIRST', 'SERVICE_USAGE_SECOND', 'SERVICE_USAGE_FINAL', 'TRIAL_NOT_DELIVERED'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_trial_is_free_check" CHECK (purpose <> 'TRIAL' OR total_amount = 0);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_purpose_check" CHECK (purpose IN ('NEW_SERVICE', 'RENEW', 'ADD_TRAFFIC', 'ADD_TIME', 'TRIAL'));