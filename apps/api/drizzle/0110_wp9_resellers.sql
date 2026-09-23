CREATE TABLE "order_reseller_terms" (
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"reseller_customer_id" uuid NOT NULL,
	"tier_id" uuid NOT NULL,
	"tier_name" text NOT NULL,
	"layer" text NOT NULL,
	"percent" integer,
	"list_amount" bigint NOT NULL,
	"cost_amount" bigint NOT NULL,
	"promotion_amount" bigint NOT NULL,
	"sale_amount" bigint NOT NULL,
	"margin_amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"bot_instance_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_reseller_terms_pkey" PRIMARY KEY("tenant_id","order_id"),
	CONSTRAINT "order_reseller_terms_layer_check" CHECK (layer IN ('LIST', 'TIER', 'OVERRIDE')),
	CONSTRAINT "order_reseller_terms_currency_check" CHECK (currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "order_reseller_terms_amounts_check" CHECK (list_amount >= 0 AND cost_amount >= 0 AND promotion_amount >= 0 AND sale_amount >= 0
          AND cost_amount <= list_amount
          AND sale_amount = cost_amount - promotion_amount
          AND margin_amount = list_amount - cost_amount),
	CONSTRAINT "order_reseller_terms_percent_check" CHECK ((percent IS NULL OR (percent >= 1 AND percent <= 100))
          AND (layer <> 'TIER' OR percent IS NOT NULL)
          AND (layer <> 'LIST' OR (percent IS NULL AND cost_amount = list_amount)))
);
--> statement-breakpoint
CREATE TABLE "reseller_tier_grants" (
	"tenant_id" uuid NOT NULL,
	"tier_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reseller_tier_grants_pkey" PRIMARY KEY("tenant_id","tier_id","kind","subject"),
	CONSTRAINT "reseller_tier_grants_kind_check" CHECK (kind IN ('PRODUCT', 'CATEGORY', 'PANEL', 'BOT', 'OPERATION')),
	CONSTRAINT "reseller_tier_grants_subject_check" CHECK (subject = '*' OR (kind = 'OPERATION' AND subject IN ('NEW_SERVICE', 'RENEW', 'ADD_TRAFFIC', 'ADD_TIME')) OR (kind <> 'OPERATION' AND subject ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
);
--> statement-breakpoint
CREATE TABLE "reseller_tiers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"pricing_mode" text NOT NULL,
	"discount_percentage" integer,
	"credit_limit_amount" bigint DEFAULT 0 NOT NULL,
	"credit_limit_currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reseller_tiers_pricing_mode_check" CHECK (pricing_mode IN ('LIST_PRICE', 'PERCENTAGE_DISCOUNT')),
	CONSTRAINT "reseller_tiers_credit_currency_check" CHECK (credit_limit_currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "reseller_tiers_credit_limit_check" CHECK (credit_limit_amount >= 0),
	CONSTRAINT "reseller_tiers_discount_mode_check" CHECK ((pricing_mode = 'PERCENTAGE_DISCOUNT') = (discount_percentage IS NOT NULL)),
	CONSTRAINT "reseller_tiers_discount_range_check" CHECK (discount_percentage IS NULL OR (discount_percentage >= 1 AND discount_percentage <= 100))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "reseller_tiers_tenant_id_key" ON "reseller_tiers" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "resellers" DROP CONSTRAINT "resellers_pricing_mode_check";--> statement-breakpoint
ALTER TABLE "resellers" DROP CONSTRAINT "resellers_credit_currency_check";--> statement-breakpoint
ALTER TABLE "resellers" DROP CONSTRAINT "resellers_credit_limit_check";--> statement-breakpoint
ALTER TABLE "resellers" ALTER COLUMN "pricing_mode" SET DEFAULT 'TIER';--> statement-breakpoint
ALTER TABLE "resellers" ALTER COLUMN "credit_limit_amount" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "resellers" ALTER COLUMN "credit_limit_currency" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "resellers" ADD COLUMN "tier_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "order_reseller_terms" ADD CONSTRAINT "order_reseller_terms_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_reseller_terms" ADD CONSTRAINT "order_reseller_terms_order_fk" FOREIGN KEY ("tenant_id","order_id","reseller_customer_id") REFERENCES "public"."orders"("tenant_id","id","customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_reseller_terms" ADD CONSTRAINT "order_reseller_terms_tier_fk" FOREIGN KEY ("tenant_id","tier_id") REFERENCES "public"."reseller_tiers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_tier_grants" ADD CONSTRAINT "reseller_tier_grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_tier_grants" ADD CONSTRAINT "reseller_tier_grants_tier_fk" FOREIGN KEY ("tenant_id","tier_id") REFERENCES "public"."reseller_tiers"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_tiers" ADD CONSTRAINT "reseller_tiers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_reseller_terms_tenant_reseller_idx" ON "order_reseller_terms" USING btree ("tenant_id","reseller_customer_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reseller_tiers_tenant_name_key" ON "reseller_tiers" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE INDEX "reseller_tiers_tenant_created_idx" ON "reseller_tiers" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
ALTER TABLE "resellers" ADD CONSTRAINT "resellers_tier_fk" FOREIGN KEY ("tenant_id","tier_id") REFERENCES "public"."reseller_tiers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resellers_tenant_tier_idx" ON "resellers" USING btree ("tenant_id","tier_id");--> statement-breakpoint
ALTER TABLE "resellers" ADD CONSTRAINT "resellers_credit_pair_check" CHECK ((credit_limit_amount IS NULL) = (credit_limit_currency IS NULL));--> statement-breakpoint
ALTER TABLE "resellers" ADD CONSTRAINT "resellers_pricing_mode_check" CHECK (pricing_mode IN ('TIER', 'LIST_PRICE', 'PERCENTAGE_DISCOUNT'));--> statement-breakpoint
ALTER TABLE "resellers" ADD CONSTRAINT "resellers_credit_currency_check" CHECK (credit_limit_currency IS NULL OR credit_limit_currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT'));--> statement-breakpoint
ALTER TABLE "resellers" ADD CONSTRAINT "resellers_credit_limit_check" CHECK (credit_limit_amount IS NULL OR credit_limit_amount >= 0);