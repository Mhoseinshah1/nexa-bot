CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"telegram_user_id" text NOT NULL,
	"username" text,
	"first_name" text,
	"last_name" text,
	"language_code" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"first_bot_instance_id" uuid,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"blocked_at" timestamp with time zone,
	"blocked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "customers_status_check" CHECK (status IN ('ACTIVE', 'BLOCKED')),
	CONSTRAINT "customers_blocked_at_check" CHECK ((status = 'BLOCKED') = (blocked_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "discount_redemptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"discount_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discount_redemptions_currency_check" CHECK (currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "discount_redemptions_amount_check" CHECK (amount > 0)
);
--> statement-breakpoint
CREATE TABLE "discounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'INACTIVE' NOT NULL,
	"value" bigint NOT NULL,
	"currency" text,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"total_redemptions_limit" integer,
	"per_customer_limit" integer,
	"minimum_subtotal_amount" bigint,
	"redemption_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discounts_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "discounts_type_check" CHECK (type IN ('PERCENTAGE', 'FIXED_AMOUNT')),
	CONSTRAINT "discounts_status_check" CHECK (status IN ('ACTIVE', 'INACTIVE')),
	CONSTRAINT "discounts_currency_check" CHECK (currency IS NULL OR currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "discounts_value_check" CHECK (value > 0),
	CONSTRAINT "discounts_percentage_check" CHECK (type <> 'PERCENTAGE' OR (value <= 100 AND currency IS NULL)),
	CONSTRAINT "discounts_fixed_check" CHECK (type <> 'FIXED_AMOUNT' OR currency IS NOT NULL),
	CONSTRAINT "discounts_window_check" CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at),
	CONSTRAINT "discounts_limits_check" CHECK ((total_redemptions_limit IS NULL OR total_redemptions_limit > 0) AND (per_customer_limit IS NULL OR per_customer_limit > 0)),
	CONSTRAINT "discounts_count_check" CHECK (redemption_count >= 0),
	CONSTRAINT "discounts_code_shape_check" CHECK (code ~ '^[A-Z0-9_-]{3,40}$')
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"state" text DEFAULT 'DRAFT' NOT NULL,
	"product_id" uuid NOT NULL,
	"panel_id" uuid NOT NULL,
	"line_title" text NOT NULL,
	"line_duration_days" integer NOT NULL,
	"line_traffic_bytes" bigint NOT NULL,
	"line_device_limit" integer,
	"line_unit_price_amount" bigint NOT NULL,
	"line_quantity" integer DEFAULT 1 NOT NULL,
	"subtotal_amount" bigint NOT NULL,
	"discount_amount" bigint DEFAULT 0 NOT NULL,
	"total_amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"quote" jsonb NOT NULL,
	"discount_code" text,
	"expires_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "orders_state_check" CHECK (state IN ('DRAFT', 'AWAITING_PAYMENT', 'PAID', 'CANCELLED', 'EXPIRED', 'REFUNDED')),
	CONSTRAINT "orders_currency_check" CHECK (currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "orders_amounts_check" CHECK (subtotal_amount >= 0 AND discount_amount >= 0 AND total_amount >= 0),
	CONSTRAINT "orders_total_consistent_check" CHECK (total_amount = subtotal_amount - discount_amount),
	CONSTRAINT "orders_discount_bounded_check" CHECK (discount_amount <= subtotal_amount),
	CONSTRAINT "orders_quantity_check" CHECK (line_quantity >= 1),
	CONSTRAINT "orders_settled_at_check" CHECK ((state = 'PAID' OR state = 'REFUNDED') = (settled_at IS NOT NULL)),
	CONSTRAINT "orders_refunded_at_check" CHECK ((state = 'REFUNDED') = (refunded_at IS NOT NULL)),
	CONSTRAINT "orders_cancelled_at_check" CHECK ((state = 'CANCELLED') = (cancelled_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"order_id" uuid,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"method" text NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"reference" text NOT NULL,
	"evidence_kind" text,
	"evidence_note" text,
	"external_reference" text,
	"confirmed_at" timestamp with time zone,
	"confirmed_by_admin_id" uuid,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payments_state_check" CHECK (state IN ('PENDING', 'CONFIRMED', 'FAILED', 'CANCELLED', 'EXPIRED', 'UNKNOWN')),
	CONSTRAINT "payments_method_check" CHECK (method IN ('WALLET', 'MANUAL_TRANSFER', 'GATEWAY')),
	CONSTRAINT "payments_currency_check" CHECK (currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "payments_evidence_kind_check" CHECK (evidence_kind IS NULL OR evidence_kind IN ('OPERATOR_REVIEW', 'WALLET_DEBIT', 'GATEWAY_CALLBACK', 'RECONCILIATION')),
	CONSTRAINT "payments_amount_check" CHECK (amount > 0),
	CONSTRAINT "payments_confirmed_check" CHECK ((state = 'CONFIRMED') = (confirmed_at IS NOT NULL AND evidence_kind IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'INACTIVE' NOT NULL,
	"audience" text DEFAULT 'EVERYONE' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"panel_id" uuid,
	"duration_days" integer NOT NULL,
	"traffic_bytes" bigint NOT NULL,
	"device_limit" integer,
	"price_amount" bigint,
	"price_currency" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "products_status_check" CHECK (status IN ('ACTIVE', 'INACTIVE')),
	CONSTRAINT "products_audience_check" CHECK (audience IN ('EVERYONE', 'RESELLERS_ONLY', 'HIDDEN')),
	CONSTRAINT "products_price_currency_check" CHECK (price_currency IS NULL OR price_currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "products_price_pair_check" CHECK ((price_amount IS NULL) = (price_currency IS NULL)),
	CONSTRAINT "products_price_positive_check" CHECK (price_amount IS NULL OR price_amount > 0),
	CONSTRAINT "products_duration_check" CHECK (duration_days >= 0 AND duration_days <= 3650),
	CONSTRAINT "products_traffic_check" CHECK (traffic_bytes >= 0),
	CONSTRAINT "products_device_limit_check" CHECK (device_limit IS NULL OR device_limit > 0)
);
--> statement-breakpoint
CREATE TABLE "provisioning_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"operation_id" text NOT NULL,
	"service_id" uuid NOT NULL,
	"order_id" uuid,
	"panel_id" uuid NOT NULL,
	"type" text NOT NULL,
	"state" text DEFAULT 'PLANNED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_by" text,
	"lease_until" timestamp with time zone,
	"call_started_at" timestamp with time zone,
	"provider_reference" text,
	"failure_kind" text,
	"failure_message" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provisioning_operations_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "provisioning_operations_state_check" CHECK (state IN ('PLANNED', 'IN_FLIGHT', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'ABANDONED')),
	CONSTRAINT "provisioning_operations_type_check" CHECK (type IN ('PROVISION', 'RENEW', 'ADD_TRAFFIC', 'ADD_TIME', 'SUSPEND', 'RESUME', 'TERMINATE', 'SYNC_USAGE', 'ROTATE_SUBSCRIPTION', 'RECONCILE')),
	CONSTRAINT "provisioning_operations_failure_kind_check" CHECK (failure_kind IS NULL OR failure_kind IN ('AUTHENTICATION_FAILED', 'AUTHENTICATION_REQUIRES_INTERACTION', 'UNREACHABLE', 'TIMEOUT', 'TLS_FAILED', 'BLOCKED_TARGET', 'RATE_LIMITED', 'MALFORMED_RESPONSE', 'PROVIDER_ERROR', 'UNSUPPORTED_CAPABILITY')),
	CONSTRAINT "provisioning_operations_operation_id_check" CHECK (operation_id ~ '^[0-9a-f]{16}$'),
	CONSTRAINT "provisioning_operations_attempts_check" CHECK (attempts >= 0 AND attempts <= 100),
	CONSTRAINT "provisioning_operations_claim_check" CHECK ((claimed_by IS NULL) = (lease_until IS NULL)),
	CONSTRAINT "provisioning_operations_completed_check" CHECK ((state IN ('SUCCEEDED', 'FAILED', 'ABANDONED')) = (completed_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "referrals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"referrer_id" uuid NOT NULL,
	"referee_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"reward_entry_id" uuid,
	"rewarded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referrals_trigger_check" CHECK (trigger IN ('ON_SIGNUP', 'ON_FIRST_PAID_ORDER')),
	CONSTRAINT "referrals_not_self_check" CHECK (referrer_id <> referee_id),
	CONSTRAINT "referrals_reward_pair_check" CHECK ((reward_entry_id IS NULL) = (rewarded_at IS NULL))
);
--> statement-breakpoint
CREATE TABLE "resellers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"pricing_mode" text DEFAULT 'LIST_PRICE' NOT NULL,
	"discount_percentage" integer,
	"credit_limit_amount" bigint DEFAULT 0 NOT NULL,
	"credit_limit_currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resellers_status_check" CHECK (status IN ('ACTIVE', 'SUSPENDED')),
	CONSTRAINT "resellers_pricing_mode_check" CHECK (pricing_mode IN ('LIST_PRICE', 'PERCENTAGE_DISCOUNT')),
	CONSTRAINT "resellers_credit_currency_check" CHECK (credit_limit_currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "resellers_credit_limit_check" CHECK (credit_limit_amount >= 0),
	CONSTRAINT "resellers_discount_mode_check" CHECK ((pricing_mode = 'PERCENTAGE_DISCOUNT') = (discount_percentage IS NOT NULL)),
	CONSTRAINT "resellers_discount_range_check" CHECK (discount_percentage IS NULL OR (discount_percentage >= 1 AND discount_percentage <= 100))
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"panel_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"state" text DEFAULT 'PENDING_PROVISION' NOT NULL,
	"provider_username" text NOT NULL,
	"provider_user_id" text,
	"subscription_url" text,
	"expires_at" timestamp with time zone,
	"traffic_limit_bytes" bigint NOT NULL,
	"traffic_used_bytes" bigint DEFAULT 0 NOT NULL,
	"usage_synced_at" timestamp with time zone,
	"provisioned_at" timestamp with time zone,
	"terminated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "services_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "services_state_check" CHECK (state IN ('PENDING_PROVISION', 'ACTIVE', 'SUSPENDED', 'EXPIRED', 'TERMINATED', 'UNRECONCILED')),
	CONSTRAINT "services_traffic_check" CHECK (traffic_limit_bytes >= 0 AND traffic_used_bytes >= 0),
	CONSTRAINT "services_provisioned_at_check" CHECK ((state = 'PENDING_PROVISION' OR state = 'UNRECONCILED') = (provisioned_at IS NULL)),
	CONSTRAINT "services_terminated_at_check" CHECK ((state = 'TERMINATED') = (terminated_at IS NOT NULL)),
	CONSTRAINT "services_usage_synced_check" CHECK (traffic_used_bytes = 0 OR usage_synced_at IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "trial_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"service_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"reason" text NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"reference" text NOT NULL,
	"reverses_entry_id" uuid,
	"order_id" uuid,
	"payment_id" uuid,
	"actor_admin_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_entries_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "wallet_entries_direction_check" CHECK (direction IN ('CREDIT', 'DEBIT')),
	CONSTRAINT "wallet_entries_reason_check" CHECK (reason IN ('TOPUP_GATEWAY', 'TOPUP_RECEIPT', 'TOPUP_STARS', 'TOPUP_CRYPTO', 'PURCHASE', 'PURCHASE_REVERSAL', 'REFUND', 'CASHBACK_GATEWAY', 'CASHBACK_TOPUP', 'CASHBACK_RENEWAL', 'REFERRAL_COMMISSION', 'REFERRAL_COMMISSION_REVERSAL', 'REFERRAL_SIGNUP_GIFT', 'START_GIFT', 'LOTTERY_WIN', 'LUCK_WHEEL_WIN', 'ADMIN_CREDIT', 'ADMIN_DEBIT', 'MASS_CREDIT', 'MASS_DEBIT', 'RESELLER_SETTLEMENT', 'RESELLER_MEMBERSHIP_FEE', 'CHARGEBACK', 'CORRECTION', 'OTHER')),
	CONSTRAINT "wallet_entries_currency_check" CHECK (currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "wallet_entries_amount_check" CHECK (amount > 0)
);
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_first_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("first_bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_discount_fk" FOREIGN KEY ("tenant_id","discount_id") REFERENCES "public"."discounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_confirmed_by_admin_id_admins_id_fk" FOREIGN KEY ("confirmed_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_panel_id_panels_id_fk" FOREIGN KEY ("panel_id") REFERENCES "public"."panels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provisioning_operations" ADD CONSTRAINT "provisioning_operations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provisioning_operations" ADD CONSTRAINT "provisioning_operations_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provisioning_operations" ADD CONSTRAINT "provisioning_operations_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_fk" FOREIGN KEY ("tenant_id","referrer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referee_fk" FOREIGN KEY ("tenant_id","referee_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resellers" ADD CONSTRAINT "resellers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resellers" ADD CONSTRAINT "resellers_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_panel_fk" FOREIGN KEY ("tenant_id","panel_id") REFERENCES "public"."panels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trial_grants" ADD CONSTRAINT "trial_grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trial_grants" ADD CONSTRAINT "trial_grants_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_actor_admin_id_admins_id_fk" FOREIGN KEY ("actor_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_tenant_telegram_key" ON "customers" USING btree ("tenant_id","telegram_user_id");--> statement-breakpoint
CREATE INDEX "customers_tenant_created_idx" ON "customers" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "customers_tenant_username_idx" ON "customers" USING btree ("tenant_id",lower(username));--> statement-breakpoint
CREATE UNIQUE INDEX "discount_redemptions_order_key" ON "discount_redemptions" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "discount_redemptions_discount_customer_idx" ON "discount_redemptions" USING btree ("discount_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "discounts_tenant_code_key" ON "discounts" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "discounts_tenant_created_idx" ON "discounts" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "orders_tenant_created_idx" ON "orders" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "orders_tenant_state_idx" ON "orders" USING btree ("tenant_id","state");--> statement-breakpoint
CREATE INDEX "orders_customer_created_idx" ON "orders" USING btree ("customer_id","created_at","id");--> statement-breakpoint
CREATE INDEX "orders_expiry_idx" ON "orders" USING btree ("expires_at") WHERE state = 'AWAITING_PAYMENT';--> statement-breakpoint
CREATE UNIQUE INDEX "payments_tenant_reference_key" ON "payments" USING btree ("tenant_id","reference");--> statement-breakpoint
CREATE INDEX "payments_tenant_created_idx" ON "payments" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "payments_tenant_state_idx" ON "payments" USING btree ("tenant_id","state");--> statement-breakpoint
CREATE INDEX "payments_customer_created_idx" ON "payments" USING btree ("customer_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_order_confirmed_key" ON "payments" USING btree ("order_id") WHERE state = 'CONFIRMED' AND order_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payments_unknown_idx" ON "payments" USING btree ("tenant_id","created_at") WHERE state = 'UNKNOWN';--> statement-breakpoint
CREATE INDEX "products_tenant_status_idx" ON "products" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "products_tenant_sort_idx" ON "products" USING btree ("tenant_id","sort_order","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "provisioning_operations_tenant_operation_key" ON "provisioning_operations" USING btree ("tenant_id","operation_id");--> statement-breakpoint
CREATE INDEX "provisioning_operations_due_idx" ON "provisioning_operations" USING btree ("created_at") WHERE state = 'PLANNED';--> statement-breakpoint
CREATE INDEX "provisioning_operations_lease_idx" ON "provisioning_operations" USING btree ("lease_until") WHERE state = 'IN_FLIGHT';--> statement-breakpoint
CREATE INDEX "provisioning_operations_service_idx" ON "provisioning_operations" USING btree ("service_id","created_at","id");--> statement-breakpoint
CREATE INDEX "provisioning_operations_unknown_idx" ON "provisioning_operations" USING btree ("tenant_id","created_at") WHERE state = 'UNKNOWN';--> statement-breakpoint
CREATE UNIQUE INDEX "referrals_referee_key" ON "referrals" USING btree ("tenant_id","referee_id");--> statement-breakpoint
CREATE INDEX "referrals_referrer_idx" ON "referrals" USING btree ("referrer_id","created_at","id");--> statement-breakpoint
CREATE INDEX "referrals_unrewarded_idx" ON "referrals" USING btree ("tenant_id","created_at") WHERE rewarded_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "resellers_customer_key" ON "resellers" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "resellers_tenant_created_idx" ON "resellers" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "services_panel_provider_username_key" ON "services" USING btree ("panel_id","provider_username");--> statement-breakpoint
CREATE INDEX "services_tenant_created_idx" ON "services" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "services_tenant_state_idx" ON "services" USING btree ("tenant_id","state");--> statement-breakpoint
CREATE INDEX "services_customer_created_idx" ON "services" USING btree ("customer_id","created_at","id");--> statement-breakpoint
CREATE INDEX "services_expiry_idx" ON "services" USING btree ("expires_at") WHERE state = 'ACTIVE' OR state = 'SUSPENDED';--> statement-breakpoint
CREATE INDEX "services_unreconciled_idx" ON "services" USING btree ("tenant_id","created_at") WHERE state = 'UNRECONCILED';--> statement-breakpoint
CREATE UNIQUE INDEX "trial_grants_customer_key" ON "trial_grants" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "trial_grants_tenant_created_idx" ON "trial_grants" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_entries_tenant_reference_key" ON "wallet_entries" USING btree ("tenant_id","reference");--> statement-breakpoint
CREATE INDEX "wallet_entries_customer_created_idx" ON "wallet_entries" USING btree ("customer_id","created_at","id");--> statement-breakpoint
CREATE INDEX "wallet_entries_tenant_created_idx" ON "wallet_entries" USING btree ("tenant_id","created_at","id");