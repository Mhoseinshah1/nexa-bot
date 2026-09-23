CREATE TABLE "cashback_reversals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_cashback_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"refund_id" uuid NOT NULL,
	"due_amount" bigint NOT NULL,
	"recovered_amount" bigint NOT NULL,
	"unrecovered_amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"wallet_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cashback_reversals_currency_check" CHECK (currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "cashback_reversals_amounts_check" CHECK (due_amount > 0 AND recovered_amount >= 0 AND unrecovered_amount >= 0 AND due_amount = recovered_amount + unrecovered_amount),
	CONSTRAINT "cashback_reversals_entry_check" CHECK ((wallet_entry_id IS NOT NULL) = (recovered_amount > 0))
);
--> statement-breakpoint
CREATE TABLE "cashback_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"label" text NOT NULL,
	"status" text DEFAULT 'INACTIVE' NOT NULL,
	"percent" integer NOT NULL,
	"applies_to" text[] NOT NULL,
	"product_id" uuid,
	"category_id" uuid,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cashback_rules_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "cashback_rules_status_check" CHECK (status IN ('ACTIVE', 'INACTIVE')),
	CONSTRAINT "cashback_rules_percent_check" CHECK (percent BETWEEN 1 AND 100),
	CONSTRAINT "cashback_rules_label_check" CHECK (char_length(label) BETWEEN 1 AND 80),
	CONSTRAINT "cashback_rules_applies_to_check" CHECK (cardinality(applies_to) > 0 AND applies_to <@ ARRAY['NEW_SERVICE', 'RENEW', 'ADD_TRAFFIC', 'ADD_TIME']::text[]),
	CONSTRAINT "cashback_rules_scope_check" CHECK (product_id IS NULL OR category_id IS NULL),
	CONSTRAINT "cashback_rules_window_check" CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at)
);
--> statement-breakpoint
CREATE TABLE "discount_code_captures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	CONSTRAINT "discount_code_captures_close_reason_check" CHECK (close_reason IS NULL OR close_reason IN ('RECEIVED', 'SUPERSEDED', 'EXPIRED')),
	CONSTRAINT "discount_code_captures_closed_check" CHECK ((closed_at IS NULL) = (close_reason IS NULL)),
	CONSTRAINT "discount_code_captures_expiry_check" CHECK (expires_at > opened_at)
);
--> statement-breakpoint
CREATE TABLE "order_cashback" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"rule_label" text NOT NULL,
	"percent" integer NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"earned_amount" bigint,
	"earned_entry_id" uuid,
	"earned_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_cashback_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "order_cashback_state_check" CHECK (state IN ('PENDING', 'EARNED', 'VOID')),
	CONSTRAINT "order_cashback_currency_check" CHECK (currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "order_cashback_amount_check" CHECK (amount > 0),
	CONSTRAINT "order_cashback_percent_check" CHECK (percent BETWEEN 1 AND 100),
	CONSTRAINT "order_cashback_earned_check" CHECK ((state = 'EARNED') = (earned_at IS NOT NULL) AND (state = 'EARNED') = (earned_amount IS NOT NULL) AND (earned_amount IS NULL OR (earned_amount >= 0 AND earned_amount <= amount))),
	CONSTRAINT "order_cashback_entry_check" CHECK ((earned_entry_id IS NOT NULL) = (earned_amount IS NOT NULL AND earned_amount > 0)),
	CONSTRAINT "order_cashback_void_check" CHECK ((state = 'VOID') = (voided_at IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "wallet_entries" DROP CONSTRAINT "wallet_entries_reason_check";--> statement-breakpoint
DROP INDEX "discount_redemptions_order_key";--> statement-breakpoint
ALTER TABLE "discounts" ALTER COLUMN "code" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "discounts" ADD COLUMN "kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "discounts" ADD COLUMN "label" text NOT NULL;--> statement-breakpoint
ALTER TABLE "discounts" ADD COLUMN "applies_to" text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "discounts" ADD COLUMN "product_id" uuid;--> statement-breakpoint
ALTER TABLE "discounts" ADD COLUMN "category_id" uuid;--> statement-breakpoint
ALTER TABLE "discounts" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "discounts" ADD COLUMN "first_purchase_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "discounts" ADD COLUMN "priority" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "discounts" ADD COLUMN "stackable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cashback_reversals" ADD CONSTRAINT "cashback_reversals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cashback_reversals" ADD CONSTRAINT "cashback_reversals_cashback_fk" FOREIGN KEY ("tenant_id","order_cashback_id") REFERENCES "public"."order_cashback"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cashback_reversals" ADD CONSTRAINT "cashback_reversals_order_fk" FOREIGN KEY ("tenant_id","order_id","customer_id") REFERENCES "public"."orders"("tenant_id","id","customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cashback_reversals" ADD CONSTRAINT "cashback_reversals_refund_fk" FOREIGN KEY ("tenant_id","refund_id") REFERENCES "public"."refunds"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cashback_reversals" ADD CONSTRAINT "cashback_reversals_entry_fk" FOREIGN KEY ("tenant_id","wallet_entry_id") REFERENCES "public"."wallet_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cashback_rules" ADD CONSTRAINT "cashback_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cashback_rules" ADD CONSTRAINT "cashback_rules_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cashback_rules" ADD CONSTRAINT "cashback_rules_category_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "public"."product_categories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_code_captures" ADD CONSTRAINT "discount_code_captures_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_code_captures" ADD CONSTRAINT "discount_code_captures_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_code_captures" ADD CONSTRAINT "discount_code_captures_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_code_captures" ADD CONSTRAINT "discount_code_captures_order_fk" FOREIGN KEY ("tenant_id","order_id","customer_id") REFERENCES "public"."orders"("tenant_id","id","customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_cashback" ADD CONSTRAINT "order_cashback_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_cashback" ADD CONSTRAINT "order_cashback_order_fk" FOREIGN KEY ("tenant_id","order_id","customer_id") REFERENCES "public"."orders"("tenant_id","id","customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_cashback" ADD CONSTRAINT "order_cashback_rule_fk" FOREIGN KEY ("tenant_id","rule_id") REFERENCES "public"."cashback_rules"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_cashback" ADD CONSTRAINT "order_cashback_earned_entry_fk" FOREIGN KEY ("tenant_id","earned_entry_id") REFERENCES "public"."wallet_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cashback_reversals_tenant_refund_key" ON "cashback_reversals" USING btree ("tenant_id","refund_id");--> statement-breakpoint
CREATE INDEX "cashback_reversals_cashback_idx" ON "cashback_reversals" USING btree ("tenant_id","order_cashback_id");--> statement-breakpoint
CREATE INDEX "cashback_rules_tenant_created_idx" ON "cashback_rules" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "cashback_rules_tenant_status_idx" ON "cashback_rules" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "discount_code_captures_open_key" ON "discount_code_captures" USING btree ("tenant_id","bot_instance_id","customer_id") WHERE closed_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "order_cashback_tenant_order_key" ON "order_cashback" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "order_cashback_pending_idx" ON "order_cashback" USING btree ("tenant_id","created_at","id") WHERE state = 'PENDING';--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_category_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "public"."product_categories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discount_redemptions_order_discount_key" ON "discount_redemptions" USING btree ("tenant_id","order_id","discount_id");--> statement-breakpoint
CREATE INDEX "discounts_tenant_live_idx" ON "discounts" USING btree ("tenant_id","kind","status");--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_kind_check" CHECK (kind IN ('CODE', 'AUTOMATIC'));--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_code_kind_check" CHECK ((kind = 'CODE') = (code IS NOT NULL));--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_minimum_check" CHECK (minimum_subtotal_amount IS NULL OR minimum_subtotal_amount >= 0);--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_label_check" CHECK (char_length(label) BETWEEN 1 AND 80);--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_applies_to_check" CHECK (cardinality(applies_to) > 0 AND applies_to <@ ARRAY['NEW_SERVICE', 'RENEW', 'ADD_TRAFFIC', 'ADD_TIME']::text[]);--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_scope_check" CHECK (product_id IS NULL OR category_id IS NULL);--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_first_purchase_check" CHECK (NOT first_purchase_only OR applies_to = ARRAY['NEW_SERVICE']::text[]);--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_priority_check" CHECK (priority BETWEEN 0 AND 1000);--> statement-breakpoint
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_reason_check" CHECK (reason IN ('TOPUP_GATEWAY', 'TOPUP_RECEIPT', 'TOPUP_STARS', 'TOPUP_CRYPTO', 'PURCHASE', 'PURCHASE_REVERSAL', 'REFUND', 'CASHBACK_GATEWAY', 'CASHBACK_TOPUP', 'CASHBACK_RENEWAL', 'CASHBACK_PURCHASE', 'CASHBACK_REVERSAL', 'REFERRAL_COMMISSION', 'REFERRAL_COMMISSION_REVERSAL', 'REFERRAL_SIGNUP_GIFT', 'START_GIFT', 'LOTTERY_WIN', 'LUCK_WHEEL_WIN', 'ADMIN_CREDIT', 'ADMIN_DEBIT', 'MASS_CREDIT', 'MASS_DEBIT', 'RESELLER_SETTLEMENT', 'RESELLER_MEMBERSHIP_FEE', 'CHARGEBACK', 'CORRECTION', 'OTHER'));