-- Package FX (round P) — the central exchange rate and the Stars route priced by it
-- (`docs/fx-audit.md`).
--
-- Additive: two new tables, nullable snapshot columns and one NOT NULL column with a
-- default on `gateway_invoices`, one widened CHECK, and a widened guard trigger. The
-- release before this one ignores the new columns and prices a Stars attempt by the
-- route's fixed rate; see `docs/deployment.md` for what to check before rolling back.
CREATE TABLE "fx_quotes" (
	"tenant_id" uuid NOT NULL,
	"base_asset" text NOT NULL,
	"quote_currency" text NOT NULL,
	"rate_mantissa" bigint,
	"rate_scale" integer,
	"source" text,
	"source_at" timestamp with time zone,
	"fetched_at" timestamp with time zone,
	"quote_id" text,
	"policy_version" integer,
	"refresh_claimed_until" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_quotes_pk" PRIMARY KEY("tenant_id","base_asset","quote_currency"),
	CONSTRAINT "fx_quotes_base_asset_check" CHECK (base_asset IN ('USDT')),
	CONSTRAINT "fx_quotes_quote_currency_check" CHECK (quote_currency IN ('IRT', 'IRR')),
	CONSTRAINT "fx_quotes_source_check" CHECK (source IS NULL OR source IN ('NOBITEX', 'WALLEX')),
	CONSTRAINT "fx_quotes_quote_check" CHECK ((quote_id IS NULL) = (rate_mantissa IS NULL)
          AND (quote_id IS NULL) = (rate_scale IS NULL)
          AND (quote_id IS NULL) = (source IS NULL)
          AND (quote_id IS NULL) = (fetched_at IS NULL)
          AND (quote_id IS NULL) = (policy_version IS NULL)
          AND (rate_mantissa IS NULL OR rate_mantissa > 0)
          AND (rate_scale IS NULL OR rate_scale BETWEEN 0 AND 8)
          AND (quote_id IS NULL OR length(quote_id) BETWEEN 1 AND 96)
          AND (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 64))
);
--> statement-breakpoint
CREATE TABLE "fx_source_states" (
	"tenant_id" uuid NOT NULL,
	"source" text NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"last_failure_code" text,
	"retry_after" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_source_states_pk" PRIMARY KEY("tenant_id","source"),
	CONSTRAINT "fx_source_states_source_check" CHECK (source IN ('NOBITEX', 'WALLEX')),
	CONSTRAINT "fx_source_states_failures_check" CHECK (consecutive_failures >= 0),
	CONSTRAINT "fx_source_states_failure_code_check" CHECK (last_failure_code IS NULL OR length(last_failure_code) BETWEEN 1 AND 64)
);
--> statement-breakpoint
ALTER TABLE "gateway_invoices" DROP CONSTRAINT "gateway_invoices_stars_snapshot_check";--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD COLUMN "conversion_policy" text DEFAULT 'SAME_UNIT' NOT NULL;--> statement-breakpoint
-- Backfill BEFORE the snapshot CHECK below is added: every attempt the previous release
-- opened with a rate was priced by it (Package A), and the CHECK requires the policy and
-- the rate to agree. The snapshot guard trigger permits this because no frozen column
-- changes. Stated in the file rather than left to the reader: `pnpm db:check` runs
-- migrations on an EMPTY database and would never see the row this ordering exists for.
UPDATE "gateway_invoices" SET "conversion_policy" = 'FIXED_RATE' WHERE "conversion_rate_minor" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD COLUMN "fx_quote_id" text;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD COLUMN "fx_source" text;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD COLUMN "fx_base_asset" text;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD COLUMN "fx_quote_currency" text;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD COLUMN "fx_rate_mantissa" bigint;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD COLUMN "fx_rate_scale" integer;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD COLUMN "fx_source_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD COLUMN "fx_fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD COLUMN "fx_quote_state" text;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD COLUMN "fx_policy_version" integer;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD COLUMN "fx_unit_ratio_mantissa" bigint;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD COLUMN "fx_unit_ratio_scale" integer;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD COLUMN "fx_effective_rate_numerator" bigint;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD COLUMN "fx_effective_rate_denominator" bigint;--> statement-breakpoint
ALTER TABLE "fx_quotes" ADD CONSTRAINT "fx_quotes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_source_states" ADD CONSTRAINT "fx_source_states_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_conversion_policy_check" CHECK (conversion_policy IN ('SAME_UNIT', 'FIXED_RATE', 'CENTRAL_FX'));--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_fx_source_check" CHECK (fx_source IS NULL OR fx_source IN ('NOBITEX', 'WALLEX'));--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_fx_base_asset_check" CHECK (fx_base_asset IS NULL OR fx_base_asset IN ('USDT'));--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_fx_quote_currency_check" CHECK (fx_quote_currency IS NULL OR fx_quote_currency IN ('IRT', 'IRR'));--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_fx_quote_state_check" CHECK (fx_quote_state IS NULL OR fx_quote_state IN ('FRESH', 'STALE_ALLOWED'));--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_fx_snapshot_check" CHECK ((conversion_policy = 'FIXED_RATE') = (conversion_rate_minor IS NOT NULL)
          AND (conversion_policy = 'CENTRAL_FX') = (fx_quote_id IS NOT NULL)
          AND (fx_quote_id IS NULL) = (fx_source IS NULL)
          AND (fx_quote_id IS NULL) = (fx_base_asset IS NULL)
          AND (fx_quote_id IS NULL) = (fx_quote_currency IS NULL)
          AND (fx_quote_id IS NULL) = (fx_rate_mantissa IS NULL)
          AND (fx_quote_id IS NULL) = (fx_rate_scale IS NULL)
          AND (fx_quote_id IS NULL) = (fx_fetched_at IS NULL)
          AND (fx_quote_id IS NULL) = (fx_quote_state IS NULL)
          AND (fx_quote_id IS NULL) = (fx_policy_version IS NULL)
          AND (fx_quote_id IS NULL) = (fx_unit_ratio_mantissa IS NULL)
          AND (fx_quote_id IS NULL) = (fx_unit_ratio_scale IS NULL)
          AND (fx_quote_id IS NULL) = (fx_effective_rate_numerator IS NULL)
          AND (fx_quote_id IS NULL) = (fx_effective_rate_denominator IS NULL)
          AND (fx_rate_mantissa IS NULL OR fx_rate_mantissa > 0)
          AND (fx_rate_scale IS NULL OR fx_rate_scale BETWEEN 0 AND 8)
          AND (fx_unit_ratio_mantissa IS NULL OR fx_unit_ratio_mantissa > 0)
          AND (fx_unit_ratio_scale IS NULL OR fx_unit_ratio_scale BETWEEN 0 AND 4)
          AND (fx_effective_rate_numerator IS NULL OR fx_effective_rate_numerator > 0)
          AND (fx_effective_rate_denominator IS NULL OR fx_effective_rate_denominator > 0)
          AND (fx_quote_id IS NULL OR length(fx_quote_id) BETWEEN 1 AND 96));--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_stars_snapshot_check" CHECK (provider <> 'TELEGRAM_STARS' OR (bot_instance_id IS NOT NULL AND conversion_policy IN ('FIXED_RATE', 'CENTRAL_FX') AND provider_unit = 'XTR'));--> statement-breakpoint

-- The attempt's snapshot is frozen, now including HOW it was priced (Package A's guard,
-- widened): the policy, the quote it used, the ratio and the effective figure per unit
-- are what explain a Star figure later, and an invoice that could be recomputed from a
-- newer quote is a customer charged a number they were never shown.
CREATE OR REPLACE FUNCTION nexa_gateway_invoices_snapshot_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.provider_order_id IS DISTINCT FROM OLD.provider_order_id
     OR NEW.provider_unit IS DISTINCT FROM OLD.provider_unit
     OR NEW.sent_amount IS DISTINCT FROM OLD.sent_amount
     OR NEW.conversion_rate_minor IS DISTINCT FROM OLD.conversion_rate_minor
     OR NEW.conversion_policy IS DISTINCT FROM OLD.conversion_policy
     OR NEW.fx_quote_id IS DISTINCT FROM OLD.fx_quote_id
     OR NEW.fx_source IS DISTINCT FROM OLD.fx_source
     OR NEW.fx_base_asset IS DISTINCT FROM OLD.fx_base_asset
     OR NEW.fx_quote_currency IS DISTINCT FROM OLD.fx_quote_currency
     OR NEW.fx_rate_mantissa IS DISTINCT FROM OLD.fx_rate_mantissa
     OR NEW.fx_rate_scale IS DISTINCT FROM OLD.fx_rate_scale
     OR NEW.fx_source_at IS DISTINCT FROM OLD.fx_source_at
     OR NEW.fx_fetched_at IS DISTINCT FROM OLD.fx_fetched_at
     OR NEW.fx_quote_state IS DISTINCT FROM OLD.fx_quote_state
     OR NEW.fx_policy_version IS DISTINCT FROM OLD.fx_policy_version
     OR NEW.fx_unit_ratio_mantissa IS DISTINCT FROM OLD.fx_unit_ratio_mantissa
     OR NEW.fx_unit_ratio_scale IS DISTINCT FROM OLD.fx_unit_ratio_scale
     OR NEW.fx_effective_rate_numerator IS DISTINCT FROM OLD.fx_effective_rate_numerator
     OR NEW.fx_effective_rate_denominator IS DISTINCT FROM OLD.fx_effective_rate_denominator
     OR NEW.bot_instance_id IS DISTINCT FROM OLD.bot_instance_id
     OR (OLD.provider_charge_id IS NOT NULL
         AND NEW.provider_charge_id IS DISTINCT FROM OLD.provider_charge_id)
  THEN
    RAISE EXCEPTION
      'gateway_invoices snapshot is immutable: provider, order id, unit, amount, rate, policy, FX snapshot and bot never change, and a charge id is written once.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS nexa_gateway_invoices_snapshot_guard ON gateway_invoices;--> statement-breakpoint
CREATE TRIGGER nexa_gateway_invoices_snapshot_guard
  BEFORE UPDATE ON gateway_invoices
  FOR EACH ROW EXECUTE FUNCTION nexa_gateway_invoices_snapshot_guard();
