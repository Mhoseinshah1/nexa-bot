CREATE TABLE "reseller_client_services" (
	"tenant_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reseller_client_services_pkey" PRIMARY KEY("tenant_id","service_id")
);
--> statement-breakpoint
CREATE TABLE "reseller_clients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"contact" text,
	"note" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "reseller_clients_tenant_id_owner_key" UNIQUE("tenant_id","id","customer_id"),
	CONSTRAINT "reseller_clients_text_check" CHECK (char_length(name) BETWEEN 1 AND 80
          AND (contact IS NULL OR char_length(contact) <= 80)
          AND (note IS NULL OR char_length(note) <= 500))
);
--> statement-breakpoint
CREATE TABLE "reseller_purchase_batch_orders" (
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"order_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"applied_at" timestamp with time zone,
	CONSTRAINT "reseller_purchase_batch_orders_pkey" PRIMARY KEY("tenant_id","batch_id","position"),
	CONSTRAINT "reseller_purchase_batch_orders_position_check" CHECK (position BETWEEN 0 AND 49)
);
--> statement-breakpoint
CREATE TABLE "reseller_purchase_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"product_id" uuid,
	"custom_panel_id" uuid,
	"custom_volume_units" bigint,
	"custom_days" integer,
	"title" text NOT NULL,
	"quantity" integer NOT NULL,
	"username_mode" text NOT NULL,
	"custom_username" text,
	"client_id" uuid,
	"note" text,
	"created_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "reseller_purchase_batches_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "reseller_purchase_batches_quantity_check" CHECK (quantity BETWEEN 1 AND 50 AND (custom_username IS NULL OR quantity = 1)),
	CONSTRAINT "reseller_purchase_batches_mode_check" CHECK (username_mode IN ('AUTOMATIC', 'CUSTOM')),
	CONSTRAINT "reseller_purchase_batches_plan_check" CHECK ((product_id IS NOT NULL AND custom_panel_id IS NULL AND custom_volume_units IS NULL
           AND custom_days IS NULL)
          OR (product_id IS NULL AND custom_panel_id IS NOT NULL
              AND custom_volume_units IS NOT NULL AND custom_days IS NOT NULL)),
	CONSTRAINT "reseller_purchase_batches_text_check" CHECK ((note IS NULL OR char_length(note) <= 500) AND char_length(title) <= 200)
);
--> statement-breakpoint
CREATE TABLE "reseller_tier_targets" (
	"tenant_id" uuid NOT NULL,
	"tier_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"target_count" integer,
	"target_amount_minor" bigint,
	"target_currency" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reseller_tier_targets_pkey" PRIMARY KEY("tenant_id","tier_id"),
	CONSTRAINT "reseller_tier_targets_kind_check" CHECK (kind IN ('COUNT', 'AMOUNT')),
	CONSTRAINT "reseller_tier_targets_shape_check" CHECK ((kind = 'COUNT' AND target_count IS NOT NULL AND target_count > 0
           AND target_amount_minor IS NULL AND target_currency IS NULL)
          OR (kind = 'AMOUNT' AND target_count IS NULL AND target_amount_minor IS NOT NULL
              AND target_amount_minor > 0 AND target_currency IS NOT NULL
              AND target_currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')))
);
--> statement-breakpoint
CREATE TABLE "reseller_web_daily_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"day" date NOT NULL,
	"facts" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reseller_web_daily_reports_kind_check" CHECK (kind IN ('EXPIRING_DIGEST', 'DAILY_SALES'))
);
--> statement-breakpoint
ALTER TABLE "customer_notifications" DROP CONSTRAINT "customer_notifications_kind_check";--> statement-breakpoint
ALTER TABLE "service_auto_renew_preferences" DROP CONSTRAINT "service_auto_renew_preferences_source_check";--> statement-breakpoint
ALTER TABLE "service_auto_renew_preferences" ADD COLUMN "renew_product_id" uuid;--> statement-breakpoint
ALTER TABLE "trial_grants" ADD COLUMN "reseller_trial" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reseller_client_services" ADD CONSTRAINT "reseller_client_services_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_client_services" ADD CONSTRAINT "reseller_client_services_client_fk" FOREIGN KEY ("tenant_id","client_id","customer_id") REFERENCES "public"."reseller_clients"("tenant_id","id","customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_client_services" ADD CONSTRAINT "reseller_client_services_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_clients" ADD CONSTRAINT "reseller_clients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_clients" ADD CONSTRAINT "reseller_clients_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_purchase_batch_orders" ADD CONSTRAINT "reseller_purchase_batch_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_purchase_batch_orders" ADD CONSTRAINT "reseller_purchase_batch_orders_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."reseller_purchase_batches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_purchase_batch_orders" ADD CONSTRAINT "reseller_purchase_batch_orders_order_fk" FOREIGN KEY ("tenant_id","order_id","customer_id") REFERENCES "public"."orders"("tenant_id","id","customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_purchase_batches" ADD CONSTRAINT "reseller_purchase_batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_purchase_batches" ADD CONSTRAINT "reseller_purchase_batches_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_tier_targets" ADD CONSTRAINT "reseller_tier_targets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_tier_targets" ADD CONSTRAINT "reseller_tier_targets_tier_fk" FOREIGN KEY ("tenant_id","tier_id") REFERENCES "public"."reseller_tiers"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_web_daily_reports" ADD CONSTRAINT "reseller_web_daily_reports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_web_daily_reports" ADD CONSTRAINT "reseller_web_daily_reports_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reseller_client_services_client_idx" ON "reseller_client_services" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE INDEX "reseller_clients_owner_idx" ON "reseller_clients" USING btree ("tenant_id","customer_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reseller_purchase_batch_orders_order_key" ON "reseller_purchase_batch_orders" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reseller_purchase_batches_key" ON "reseller_purchase_batches" USING btree ("tenant_id","customer_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "reseller_purchase_batches_owner_idx" ON "reseller_purchase_batches" USING btree ("tenant_id","customer_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reseller_web_daily_reports_day_key" ON "reseller_web_daily_reports" USING btree ("tenant_id","customer_id","kind","day");--> statement-breakpoint
ALTER TABLE "service_auto_renew_preferences" ADD CONSTRAINT "service_auto_renew_preferences_product_fk" FOREIGN KEY ("tenant_id","renew_product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_kind_check" CHECK (kind IN ('PAYMENT_REJECTED', 'PAYMENT_EXPIRED', 'ORDER_EXPIRED', 'SERVICE_ACTION_SUCCEEDED', 'SERVICE_ACTION_FAILED', 'SERVICE_PROVISION_DELAYED', 'PAYMENT_TRANSFER_RECORDED', 'ORDER_CANCELLED', 'WALLET_TOPUP_CREDITED', 'ORDER_REFUNDED_TO_WALLET', 'SERVICE_EXPIRY_FIRST', 'SERVICE_EXPIRY_SECOND', 'SERVICE_EXPIRED', 'SERVICE_USAGE_FIRST', 'SERVICE_USAGE_SECOND', 'SERVICE_USAGE_FINAL', 'TRIAL_NOT_DELIVERED', 'RECEIPT_CREDITED_TO_WALLET', 'WALLET_TOPUP_GIFT_CREDITED', 'GATEWAY_LATE_PAYMENT_CREDITED', 'REFUND_COMPLETED', 'GATEWAY_PAYMENT_FAILED', 'SERVICE_REFUND_REQUEST_REGISTERED', 'SERVICE_REFUND_REQUEST_APPROVED', 'SERVICE_REFUND_REQUEST_REJECTED', 'SERVICE_TRANSFER_RECEIVED', 'TICKET_REPLY', 'SERVICE_EXPIRY_EARLY', 'SERVICE_EXPIRY_DAY', 'WALLET_LOW_BALANCE', 'PAYMENT_PENDING_REMINDER', 'ORDER_PENDING_REMINDER', 'TICKET_REPLY_ATTACHMENT', 'SERVICE_RENEWED', 'RESELLER_MINIMUM_REMINDER', 'RESELLER_MINIMUM_ACHIEVED', 'WALLET_MASS_CREDITED', 'SERVICE_GIFT_APPLIED', 'DIRECT_MESSAGE', 'DIRECT_MESSAGE_MEDIA', 'INCIDENT_NOTICE', 'WALLET_ADMIN_CREDITED', 'WALLET_ADMIN_DEBITED', 'ACCOUNT_UNBLOCKED', 'SERVICE_TRAFFIC_ADDED', 'SERVICE_TIME_ADDED', 'SERVICE_AUTO_RENEW_FUNDS_SHORT', 'SERVICE_AUTO_RENEW_PRICE_CHANGED', 'RESELLER_EXPIRED', 'SERVICE_AUTO_DELETE_WARNING', 'RESELLER_REQUEST_MESSAGE', 'RESELLER_REQUEST_DECISION', 'RESELLER_WEB_NEW_DEVICE', 'RESELLER_WEB_EXPIRING_DIGEST', 'RESELLER_WEB_DAILY_SALES')) NOT VALID;--> statement-breakpoint
ALTER TABLE "customer_notifications" VALIDATE CONSTRAINT "customer_notifications_kind_check";--> statement-breakpoint
ALTER TABLE "service_auto_renew_preferences" ADD CONSTRAINT "service_auto_renew_preferences_plan_check" CHECK (renew_product_id IS NULL OR enabled);--> statement-breakpoint
ALTER TABLE "service_auto_renew_preferences" ADD CONSTRAINT "service_auto_renew_preferences_source_check" CHECK (source IN ('TELEGRAM', 'MINI_APP', 'TRANSFER', 'RESELLER_WEB'));