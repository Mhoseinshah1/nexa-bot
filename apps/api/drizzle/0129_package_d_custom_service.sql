-- Package D — the custom service (docs/package-d-custom-service-audit.md).
--
-- A customer buys a location, a volume and a number of days, priced by the operator's
-- range rules, through an order whose purpose is CUSTOM_SERVICE and which names NO
-- product. Three new tables (locations, price rules, the order's frozen terms), and two
-- relaxations: orders.product_id and services.product_id become nullable, pinned by
-- orders_product_purpose_check and by the service trigger below to exactly the custom
-- purpose. Rollback: see the audit's §10 — the release before this one reads every row
-- it could before, and cannot render a custom order once one exists.
CREATE TABLE "custom_service_locations" (
	"tenant_id" uuid NOT NULL,
	"panel_id" uuid NOT NULL,
	"label" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_service_locations_pk" PRIMARY KEY("tenant_id","panel_id"),
	CONSTRAINT "custom_service_locations_label_check" CHECK (length(btrim(label)) BETWEEN 1 AND 64)
);
--> statement-breakpoint
CREATE TABLE "custom_service_price_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"dimension" text NOT NULL,
	"label" text,
	"min_units" bigint NOT NULL,
	"max_units" bigint NOT NULL,
	"unit_price_amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"customer_id" uuid,
	"reseller_tier_id" uuid,
	"panel_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_service_price_rules_dimension_check" CHECK (dimension IN ('VOLUME', 'TIME')),
	CONSTRAINT "custom_service_price_rules_currency_check" CHECK (currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "custom_service_price_rules_range_check" CHECK (min_units >= 1 AND max_units >= min_units),
	CONSTRAINT "custom_service_price_rules_price_check" CHECK (unit_price_amount > 0),
	CONSTRAINT "custom_service_price_rules_specificity_check" CHECK (customer_id IS NULL OR reseller_tier_id IS NULL),
	CONSTRAINT "custom_service_price_rules_label_check" CHECK (label IS NULL OR length(btrim(label)) BETWEEN 1 AND 64)
);
--> statement-breakpoint
CREATE TABLE "order_custom_service_terms" (
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"panel_id" uuid NOT NULL,
	"location_label" text NOT NULL,
	"volume_units" bigint NOT NULL,
	"traffic_bytes" bigint NOT NULL,
	"duration_days" integer NOT NULL,
	"volume_rule_id" uuid NOT NULL,
	"volume_rule_level" text NOT NULL,
	"price_per_gb_amount" bigint NOT NULL,
	"volume_amount" bigint NOT NULL,
	"time_rule_id" uuid NOT NULL,
	"time_rule_level" text NOT NULL,
	"price_per_day_amount" bigint NOT NULL,
	"time_amount" bigint NOT NULL,
	"base_amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_custom_service_terms_pk" PRIMARY KEY("tenant_id","order_id"),
	CONSTRAINT "order_custom_service_terms_currency_check" CHECK (currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "order_custom_service_terms_volume_level_check" CHECK (volume_rule_level IN ('CUSTOMER_PANEL', 'CUSTOMER_ALL_PANELS', 'TIER_PANEL', 'TIER_ALL_PANELS')),
	CONSTRAINT "order_custom_service_terms_time_level_check" CHECK (time_rule_level IN ('CUSTOMER_PANEL', 'CUSTOMER_ALL_PANELS', 'TIER_PANEL', 'TIER_ALL_PANELS')),
	CONSTRAINT "order_custom_service_terms_positive_check" CHECK (volume_units > 0 AND traffic_bytes > 0 AND duration_days > 0
          AND price_per_gb_amount > 0 AND price_per_day_amount > 0),
	CONSTRAINT "order_custom_service_terms_volume_amount_check" CHECK (volume_amount = (volume_units * price_per_gb_amount + 50) / 100),
	CONSTRAINT "order_custom_service_terms_time_amount_check" CHECK (time_amount = duration_days * price_per_day_amount),
	CONSTRAINT "order_custom_service_terms_base_amount_check" CHECK (base_amount = volume_amount + time_amount)
);
--> statement-breakpoint
ALTER TABLE "cashback_rules" DROP CONSTRAINT "cashback_rules_applies_to_check";--> statement-breakpoint
ALTER TABLE "customer_text_captures" DROP CONSTRAINT "customer_text_captures_purpose_check";--> statement-breakpoint
ALTER TABLE "customer_text_captures" DROP CONSTRAINT "customer_text_captures_subject_check";--> statement-breakpoint
ALTER TABLE "discounts" DROP CONSTRAINT "discounts_applies_to_check";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_purpose_check";--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "product_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ALTER COLUMN "product_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_text_captures" ADD COLUMN "custom_volume_units" bigint;--> statement-breakpoint
ALTER TABLE "custom_service_locations" ADD CONSTRAINT "custom_service_locations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_service_locations" ADD CONSTRAINT "custom_service_locations_panel_fk" FOREIGN KEY ("tenant_id","panel_id") REFERENCES "public"."panels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_service_price_rules" ADD CONSTRAINT "custom_service_price_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_service_price_rules" ADD CONSTRAINT "custom_service_price_rules_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_service_price_rules" ADD CONSTRAINT "custom_service_price_rules_tier_fk" FOREIGN KEY ("tenant_id","reseller_tier_id") REFERENCES "public"."reseller_tiers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_service_price_rules" ADD CONSTRAINT "custom_service_price_rules_panel_fk" FOREIGN KEY ("tenant_id","panel_id") REFERENCES "public"."panels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_custom_service_terms" ADD CONSTRAINT "order_custom_service_terms_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_custom_service_terms" ADD CONSTRAINT "order_custom_service_terms_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_service_price_rules_tenant_id_key" ON "custom_service_price_rules" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "custom_service_price_rules_tenant_dimension_idx" ON "custom_service_price_rules" USING btree ("tenant_id","dimension","enabled");--> statement-breakpoint
ALTER TABLE "cashback_rules" ADD CONSTRAINT "cashback_rules_applies_to_check" CHECK (cardinality(applies_to) > 0 AND applies_to <@ ARRAY['NEW_SERVICE', 'RENEW', 'ADD_TRAFFIC', 'ADD_TIME', 'CUSTOM_SERVICE']::text[]);--> statement-breakpoint
ALTER TABLE "customer_text_captures" ADD CONSTRAINT "customer_text_captures_custom_volume_check" CHECK ((purpose = 'CUSTOM_SERVICE_DAYS') = (custom_volume_units IS NOT NULL)
          AND (custom_volume_units IS NULL OR custom_volume_units > 0));--> statement-breakpoint
ALTER TABLE "customer_text_captures" ADD CONSTRAINT "customer_text_captures_purpose_check" CHECK (purpose IN ('TOPUP_AMOUNT', 'SERVICE_SEARCH', 'SERVICE_NOTE', 'SERVICE_REFUND_REASON', 'CUSTOM_SERVICE_VOLUME', 'CUSTOM_SERVICE_DAYS'));--> statement-breakpoint
ALTER TABLE "customer_text_captures" ADD CONSTRAINT "customer_text_captures_subject_check" CHECK ((purpose IN ('SERVICE_NOTE', 'SERVICE_REFUND_REASON', 'CUSTOM_SERVICE_VOLUME', 'CUSTOM_SERVICE_DAYS')) = (subject_id IS NOT NULL));--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_applies_to_check" CHECK (cardinality(applies_to) > 0 AND applies_to <@ ARRAY['NEW_SERVICE', 'RENEW', 'ADD_TRAFFIC', 'ADD_TIME', 'CUSTOM_SERVICE']::text[]);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_product_purpose_check" CHECK ((product_id IS NULL) = (purpose = 'CUSTOM_SERVICE'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_custom_service_line_check" CHECK (purpose <> 'CUSTOM_SERVICE'
          OR (line_traffic_bytes > 0 AND line_duration_days > 0 AND line_quantity = 1));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_purpose_check" CHECK (purpose IN ('NEW_SERVICE', 'RENEW', 'ADD_TRAFFIC', 'ADD_TIME', 'TRIAL', 'CUSTOM_SERVICE'));--> statement-breakpoint
-- A service belongs to an order that CREATES one, and names a product exactly when that
-- order did. 0102 admitted NEW_SERVICE and TRIAL; CUSTOM_SERVICE is the third creating
-- purpose, and the only one whose service carries no product. Still the positive list:
-- a purpose added later without a thought is refused rather than allowed.
CREATE OR REPLACE FUNCTION nexa_service_requires_purchase_order() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  order_purpose text;
BEGIN
  SELECT purpose INTO order_purpose
    FROM orders
   WHERE tenant_id = NEW.tenant_id AND id = NEW.order_id;
  IF order_purpose IS NOT NULL AND order_purpose NOT IN ('NEW_SERVICE', 'TRIAL', 'CUSTOM_SERVICE') THEN
    RAISE EXCEPTION
      'order % is a % and cannot produce a service', NEW.order_id, order_purpose
      USING ERRCODE = 'raise_exception';
  END IF;
  IF order_purpose IS NOT NULL AND (NEW.product_id IS NULL) <> (order_purpose = 'CUSTOM_SERVICE') THEN
    RAISE EXCEPTION
      'a service of a % order must name a product exactly when the order does', order_purpose
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
-- The terms a custom order was priced by are written once, in the draft's transaction, and
-- never changed: editing or deleting a rule later must not rewrite what a customer was
-- quoted and paid (brief D6). The rule ids are copies, not foreign keys, for the same reason.
CREATE FUNCTION nexa_order_custom_service_terms_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'order_custom_service_terms for order % are frozen', OLD.order_id
    USING ERRCODE = 'raise_exception';
END;
$$;--> statement-breakpoint
CREATE TRIGGER nexa_order_custom_service_terms_frozen
  BEFORE UPDATE OR DELETE ON order_custom_service_terms
  FOR EACH ROW EXECUTE FUNCTION nexa_order_custom_service_terms_frozen();
