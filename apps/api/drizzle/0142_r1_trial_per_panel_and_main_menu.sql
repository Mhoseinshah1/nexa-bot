CREATE TABLE "panel_trial_configs" (
	"tenant_id" uuid NOT NULL,
	"panel_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"traffic_bytes" bigint NOT NULL,
	"duration_hours" integer NOT NULL,
	"label" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "panel_trial_configs_pk" PRIMARY KEY("tenant_id","panel_id"),
	CONSTRAINT "panel_trial_configs_traffic_check" CHECK (traffic_bytes > 0 AND traffic_bytes <= 107374182400),
	CONSTRAINT "panel_trial_configs_hours_check" CHECK (duration_hours >= 1 AND duration_hours <= 720),
	CONSTRAINT "panel_trial_configs_label_check" CHECK (label IS NULL OR length(btrim(label)) BETWEEN 1 AND 64),
	CONSTRAINT "panel_trial_configs_revision_check" CHECK (revision >= 1)
);
--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_product_purpose_check";--> statement-breakpoint
ALTER TABLE "trial_grants" ALTER COLUMN "product_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "line_duration_hours" integer;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "is_trial" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "panel_trial_configs" ADD CONSTRAINT "panel_trial_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panel_trial_configs" ADD CONSTRAINT "panel_trial_configs_panel_fk" FOREIGN KEY ("tenant_id","panel_id") REFERENCES "public"."panels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "panel_trial_configs_enabled_idx" ON "panel_trial_configs" USING btree ("tenant_id") WHERE enabled;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_trial_hours_check" CHECK (line_duration_hours IS NULL OR (purpose = 'TRIAL' AND line_duration_hours BETWEEN 1 AND 720));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_product_purpose_check" CHECK (purpose = 'TRIAL' OR (product_id IS NULL) = (purpose = 'CUSTOM_SERVICE'));--> statement-breakpoint
-- R1, hand-written: what drizzle-kit does not model.
--
-- 1. A service is a trial exactly when the order that created it is one, decided by the
-- database. `nexa_service_requires_purchase_order` (0050, 0102, 0129) already reads the
-- creating order's purpose on INSERT; it now also SETS `is_trial` from it, whatever the
-- writer passed — so the release before this one, which inserts without the column, still
-- marks the trials it creates during a rolling update.
--
-- Its product rule was "a service names a product exactly when its order is not a custom
-- service". A trial order names a product when the release before R1 issued it and none
-- since, so the rule becomes what it always meant: the service names a product exactly
-- when its ORDER does.
CREATE OR REPLACE FUNCTION nexa_service_requires_purchase_order() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  order_purpose text;
  order_product uuid;
BEGIN
  SELECT purpose, product_id INTO order_purpose, order_product
    FROM orders
   WHERE tenant_id = NEW.tenant_id AND id = NEW.order_id;
  IF order_purpose IS NOT NULL AND order_purpose NOT IN ('NEW_SERVICE', 'TRIAL', 'CUSTOM_SERVICE') THEN
    RAISE EXCEPTION
      'order % is a % and cannot produce a service', NEW.order_id, order_purpose
      USING ERRCODE = 'raise_exception';
  END IF;
  IF order_purpose IS NOT NULL AND (NEW.product_id IS NULL) <> (order_product IS NULL) THEN
    RAISE EXCEPTION
      'a service of a % order must name a product exactly when the order does', order_purpose
      USING ERRCODE = 'raise_exception';
  END IF;
  NEW.is_trial := COALESCE(order_purpose = 'TRIAL', false);
  RETURN NEW;
END;
$$;--> statement-breakpoint
-- 2. Every existing trial service, marked. Before the freeze below, which would refuse it.
UPDATE services s
   SET is_trial = true
  FROM orders o
 WHERE o.tenant_id = s.tenant_id AND o.id = s.order_id AND o.purpose = 'TRIAL'
   AND s.is_trial = false;--> statement-breakpoint
-- 3. And never changed afterwards: a trial does not become a purchase, or the reverse.
CREATE FUNCTION nexa_services_trial_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'services.is_trial is decided by the creating order and cannot change (service %)', OLD.id
    USING ERRCODE = 'check_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER nexa_services_trial_frozen
  BEFORE UPDATE OF is_trial ON services
  FOR EACH ROW
  WHEN (OLD.is_trial IS DISTINCT FROM NEW.is_trial)
  EXECUTE FUNCTION nexa_services_trial_frozen();--> statement-breakpoint
-- 4. A trial's hours are part of its line, frozen at confirmation with the rest (0085's
-- guard, with `line_duration_hours` added and nothing else changed).
CREATE OR REPLACE FUNCTION nexa_orders_snapshot_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.confirmed_at IS NOT NULL AND (
       NEW.product_id IS DISTINCT FROM OLD.product_id
    OR NEW.panel_id IS DISTINCT FROM OLD.panel_id
    OR NEW.line_title IS DISTINCT FROM OLD.line_title
    OR NEW.line_duration_days IS DISTINCT FROM OLD.line_duration_days
    OR NEW.line_duration_hours IS DISTINCT FROM OLD.line_duration_hours
    OR NEW.line_traffic_bytes IS DISTINCT FROM OLD.line_traffic_bytes
    OR NEW.line_device_limit IS DISTINCT FROM OLD.line_device_limit
    OR NEW.line_unit_price_amount IS DISTINCT FROM OLD.line_unit_price_amount
    OR NEW.line_quantity IS DISTINCT FROM OLD.line_quantity
    OR NEW.subtotal_amount IS DISTINCT FROM OLD.subtotal_amount
    OR NEW.discount_amount IS DISTINCT FROM OLD.discount_amount
    OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.quote IS DISTINCT FROM OLD.quote
    OR NEW.discount_code IS DISTINCT FROM OLD.discount_code
    OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
    OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
  ) THEN
    RAISE EXCEPTION
      'a confirmed order''s line, totals, quote and customer are immutable; only its lifecycle may change.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
-- 5. The retired `trial.product_id`, carried forward ONCE: a tenant that had configured a
-- trial product gets that product's panel configured with the product's traffic and
-- duration (days x 24 hours, at most 720), enabled exactly when the product was ACTIVE —
-- the one state the old claim accepted. The `trials` flag is untouched, so a tenant whose
-- trial was on stays on and one whose trial was off stays off.
--
-- Not carried: a product with unlimited traffic or duration (zero), which a per-panel trial
-- cannot express and which no free trial should be — that tenant's trial becomes
-- unconfigured, and a customer is told there is none until an operator sets it on a panel;
-- and a product with no panel. A traffic figure above the trial ceiling is clamped to it.
-- The id is cast only once it is known to be a uuid, inside a CASE, so a hand-written value
-- can never abort the migration.
INSERT INTO panel_trial_configs
  (tenant_id, panel_id, enabled, traffic_bytes, duration_hours, label, revision, created_at, updated_at)
SELECT sv.tenant_id,
       p.panel_id,
       p.status = 'ACTIVE',
       LEAST(p.traffic_bytes, 107374182400),
       LEAST(p.duration_days * 24, 720),
       NULL,
       1,
       now(),
       now()
  FROM setting_values sv
  JOIN products p
    ON p.tenant_id = sv.tenant_id
   AND p.id = CASE
                WHEN jsonb_typeof(sv.value) = 'string'
                 AND (sv.value #>> '{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN (sv.value #>> '{}')::uuid
              END
  JOIN panels pn ON pn.tenant_id = sv.tenant_id AND pn.id = p.panel_id
 WHERE sv.setting_key = 'trial.product_id'
   AND p.traffic_bytes > 0
   AND p.duration_days > 0
ON CONFLICT (tenant_id, panel_id) DO NOTHING;
