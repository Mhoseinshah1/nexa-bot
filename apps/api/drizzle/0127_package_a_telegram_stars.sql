-- Package A — Telegram Stars (`docs/package-a-telegram-stars-audit.md`).
--
-- Additive: one widened provider list on five tables, nullable columns, one partial unique
-- index over rows that have no value yet, and a guard trigger. The release before this one
-- reads a TELEGRAM_STARS row as a provider it has no adapter for and offers nothing; see
-- the audit, §3, for what to check before rolling back.
ALTER TABLE "gateway_invoices" DROP CONSTRAINT "gateway_invoices_provider_check";--> statement-breakpoint
ALTER TABLE "gateway_invoices" DROP CONSTRAINT "gateway_invoices_provider_unit_check";--> statement-breakpoint
ALTER TABLE "payment_gateway_call_budgets" DROP CONSTRAINT "payment_gateway_call_budgets_provider_check";--> statement-breakpoint
ALTER TABLE "payment_gateway_credentials" DROP CONSTRAINT "payment_gateway_credentials_provider_check";--> statement-breakpoint
ALTER TABLE "payment_gateways" DROP CONSTRAINT "payment_gateways_provider_check";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_gateway_provider_check";--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD COLUMN "conversion_rate_minor" bigint;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD COLUMN "bot_instance_id" uuid;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD COLUMN "provider_charge_id" text;--> statement-breakpoint
ALTER TABLE "payment_gateways" ADD COLUMN "provider_unit_rate_minor" bigint;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_invoices_charge_id_key" ON "gateway_invoices" USING btree ("tenant_id","provider","provider_charge_id") WHERE provider_charge_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_conversion_rate_check" CHECK (conversion_rate_minor IS NULL OR conversion_rate_minor > 0);--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_charge_id_length_check" CHECK (provider_charge_id IS NULL OR length(provider_charge_id) BETWEEN 1 AND 255);--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_stars_snapshot_check" CHECK (provider <> 'TELEGRAM_STARS' OR (bot_instance_id IS NOT NULL AND conversion_rate_minor IS NOT NULL AND provider_unit = 'XTR'));--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS'));--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_provider_unit_check" CHECK (provider_unit IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT', 'XTR'));--> statement-breakpoint
ALTER TABLE "payment_gateway_call_budgets" ADD CONSTRAINT "payment_gateway_call_budgets_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS'));--> statement-breakpoint
ALTER TABLE "payment_gateway_credentials" ADD CONSTRAINT "payment_gateway_credentials_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS'));--> statement-breakpoint
ALTER TABLE "payment_gateways" ADD CONSTRAINT "payment_gateways_provider_unit_rate_check" CHECK (provider_unit_rate_minor IS NULL OR provider_unit_rate_minor > 0);--> statement-breakpoint
ALTER TABLE "payment_gateways" ADD CONSTRAINT "payment_gateways_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_gateway_provider_check" CHECK (gateway_provider IS NULL OR gateway_provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS'));--> statement-breakpoint

-- The attempt's snapshot is frozen, and the charge id is written once. `sent_amount` is
-- the Stars the invoice asks for and `conversion_rate_minor` the rate it was computed
-- from: an attempt whose figure could be rewritten would be a customer charged a number
-- they were never shown, and a charge id that could be replaced would be one charge
-- settling two attempts.
CREATE OR REPLACE FUNCTION nexa_gateway_invoices_snapshot_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.provider_order_id IS DISTINCT FROM OLD.provider_order_id
     OR NEW.provider_unit IS DISTINCT FROM OLD.provider_unit
     OR NEW.sent_amount IS DISTINCT FROM OLD.sent_amount
     OR NEW.conversion_rate_minor IS DISTINCT FROM OLD.conversion_rate_minor
     OR NEW.bot_instance_id IS DISTINCT FROM OLD.bot_instance_id
     OR (OLD.provider_charge_id IS NOT NULL
         AND NEW.provider_charge_id IS DISTINCT FROM OLD.provider_charge_id)
  THEN
    RAISE EXCEPTION
      'gateway_invoices snapshot is immutable: provider, order id, unit, amount, rate and bot never change, and a charge id is written once.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS nexa_gateway_invoices_snapshot_guard ON gateway_invoices;--> statement-breakpoint
CREATE TRIGGER nexa_gateway_invoices_snapshot_guard
  BEFORE UPDATE ON gateway_invoices
  FOR EACH ROW EXECUTE FUNCTION nexa_gateway_invoices_snapshot_guard();
