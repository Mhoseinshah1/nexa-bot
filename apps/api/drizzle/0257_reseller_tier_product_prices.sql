CREATE TABLE "reseller_tier_product_prices" (
	"tenant_id" uuid NOT NULL,
	"tier_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"price_amount" bigint NOT NULL,
	"price_currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reseller_tier_product_prices_pkey" PRIMARY KEY("tenant_id","tier_id","product_id"),
	CONSTRAINT "reseller_tier_product_prices_currency_check" CHECK (price_currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "reseller_tier_product_prices_amount_check" CHECK (price_amount > 0)
);
--> statement-breakpoint
ALTER TABLE "order_reseller_terms" DROP CONSTRAINT "order_reseller_terms_percent_check";--> statement-breakpoint
ALTER TABLE "reseller_tiers" DROP CONSTRAINT "reseller_tiers_pricing_mode_check";--> statement-breakpoint
ALTER TABLE "order_reseller_terms" ADD COLUMN "fixed_price" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reseller_tiers" ADD COLUMN "unpriced_list_fallback" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reseller_tier_product_prices" ADD CONSTRAINT "reseller_tier_product_prices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_tier_product_prices" ADD CONSTRAINT "reseller_tier_product_prices_tier_fk" FOREIGN KEY ("tenant_id","tier_id") REFERENCES "public"."reseller_tiers"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_tier_product_prices" ADD CONSTRAINT "reseller_tier_product_prices_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reseller_tier_product_prices_product_idx" ON "reseller_tier_product_prices" USING btree ("tenant_id","product_id");--> statement-breakpoint
ALTER TABLE "order_reseller_terms" ADD CONSTRAINT "order_reseller_terms_fixed_price_check" CHECK (NOT fixed_price OR (layer = 'TIER' AND percent IS NULL AND cost_amount < list_amount AND cost_amount > 0));--> statement-breakpoint
ALTER TABLE "order_reseller_terms" ADD CONSTRAINT "order_reseller_terms_percent_check" CHECK ((percent IS NULL OR (percent >= 1 AND percent <= 100))
          AND (layer <> 'TIER' OR percent IS NOT NULL OR fixed_price)
          AND (layer <> 'LIST' OR (percent IS NULL AND cost_amount = list_amount)));--> statement-breakpoint
ALTER TABLE "reseller_tiers" ADD CONSTRAINT "reseller_tiers_pricing_mode_check" CHECK (pricing_mode IN ('LIST_PRICE', 'PERCENTAGE_DISCOUNT', 'FIXED_PRICE_TABLE'));