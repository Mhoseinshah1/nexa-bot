-- The custom gateway (`docs/protocols/custom-gateway.md`, Round 10 item C1).
--
-- Additive: the provider roster widened on six tables (0280's shape); `gateway_invoices_custom_check`
-- (a custom attempt is billed in RIAL with no conversion and no bot, its invoice id is the
-- `cg_` + 26 Crockford base32 Nexa generates, and it carries the customer's opaque number and the
-- bridge URL it was created against); `gateway_invoices_provider_user_id_check` widened to CUSTOM
-- (the customer's `customer_ref` reuses CentralPay's per-customer number); the route's bridge
-- (`payment_gateways.endpoint_base_url`, `webhook_ip_allowlist`, CUSTOM only) and the attempt's
-- frozen copy of the URL (`gateway_invoices.endpoint_base_url`, written once by the trigger at the
-- end). No money data, no Persian text, no balance, no row written, and no credential column: the
-- route's ONE secret uses the API-key column and AEAD purpose that already exist. The route starts
-- DISABLED like every keyed one (`ensureDefaults`).
--
-- ROLLBACK NOTE. The previous release lists and claims only providers it knows, so a CUSTOM row
-- neither breaks its gateway page nor stalls its worker - but it never reads an open custom
-- attempt, which then expires even if paid. Disable the route and drain first: `botctl rollback`
-- never restores the database.
ALTER TABLE "gateway_customer_numbers" DROP CONSTRAINT "gateway_customer_numbers_provider_check";--> statement-breakpoint
ALTER TABLE "gateway_invoices" DROP CONSTRAINT "gateway_invoices_provider_check";--> statement-breakpoint
ALTER TABLE "gateway_invoices" DROP CONSTRAINT "gateway_invoices_provider_user_id_check";--> statement-breakpoint
ALTER TABLE "payment_gateway_call_budgets" DROP CONSTRAINT "payment_gateway_call_budgets_provider_check";--> statement-breakpoint
ALTER TABLE "payment_gateway_credentials" DROP CONSTRAINT "payment_gateway_credentials_provider_check";--> statement-breakpoint
ALTER TABLE "payment_gateways" DROP CONSTRAINT "payment_gateways_provider_check";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_gateway_provider_check";--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD COLUMN "endpoint_base_url" text;--> statement-breakpoint
ALTER TABLE "payment_gateways" ADD COLUMN "endpoint_base_url" text;--> statement-breakpoint
ALTER TABLE "payment_gateways" ADD COLUMN "webhook_ip_allowlist" text[];--> statement-breakpoint
ALTER TABLE "gateway_customer_numbers" ADD CONSTRAINT "gateway_customer_numbers_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS', 'TONPAYS_TELEGRAM', 'NOWPAYMENTS', 'CENTRALPAY', 'TETRAPAY', 'RIALIT', 'CUSTOM'));--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_custom_check" CHECK (provider <> 'CUSTOM' OR (provider_unit = 'IRR' AND conversion_policy = 'SAME_UNIT' AND bot_instance_id IS NULL AND provider_order_id ~ '^cg_[0-9A-HJKMNP-TV-Z]{26}$' AND provider_user_id IS NOT NULL AND endpoint_base_url IS NOT NULL));--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_endpoint_base_url_check" CHECK (endpoint_base_url IS NULL OR (provider = 'CUSTOM' AND endpoint_base_url ~ '^https://' AND length(endpoint_base_url) <= 512));--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS', 'TONPAYS_TELEGRAM', 'NOWPAYMENTS', 'CENTRALPAY', 'TETRAPAY', 'RIALIT', 'CUSTOM'));--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_provider_user_id_check" CHECK (provider_user_id IS NULL OR (provider IN ('CENTRALPAY', 'CUSTOM') AND provider_user_id ~ '^[0-9]{10}$'));--> statement-breakpoint
ALTER TABLE "payment_gateway_call_budgets" ADD CONSTRAINT "payment_gateway_call_budgets_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS', 'TONPAYS_TELEGRAM', 'NOWPAYMENTS', 'CENTRALPAY', 'TETRAPAY', 'RIALIT', 'CUSTOM'));--> statement-breakpoint
ALTER TABLE "payment_gateway_credentials" ADD CONSTRAINT "payment_gateway_credentials_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS', 'TONPAYS_TELEGRAM', 'NOWPAYMENTS', 'CENTRALPAY', 'TETRAPAY', 'RIALIT', 'CUSTOM'));--> statement-breakpoint
ALTER TABLE "payment_gateways" ADD CONSTRAINT "payment_gateways_endpoint_check" CHECK ((provider = 'CUSTOM' OR (endpoint_base_url IS NULL AND webhook_ip_allowlist IS NULL))
          AND (endpoint_base_url IS NULL OR (endpoint_base_url ~ '^https://[^/?#@[:space:]]+' AND length(endpoint_base_url) <= 512))
          AND (webhook_ip_allowlist IS NULL OR cardinality(webhook_ip_allowlist) <= 32));--> statement-breakpoint
ALTER TABLE "payment_gateways" ADD CONSTRAINT "payment_gateways_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS', 'TONPAYS_TELEGRAM', 'NOWPAYMENTS', 'CENTRALPAY', 'TETRAPAY', 'RIALIT', 'CUSTOM'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_gateway_provider_check" CHECK (gateway_provider IS NULL OR gateway_provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS', 'TONPAYS_TELEGRAM', 'NOWPAYMENTS', 'CENTRALPAY', 'TETRAPAY', 'RIALIT', 'CUSTOM'));--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers). The bridge an attempt was created against
-- is where every inquiry of it goes, so the frozen URL is written once, when the attempt opens.
CREATE OR REPLACE FUNCTION nexa_gateway_invoices_endpoint_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.endpoint_base_url IS DISTINCT FROM OLD.endpoint_base_url THEN
    RAISE EXCEPTION 'gateway_invoices.endpoint_base_url is written once, when the attempt opens.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER nexa_gateway_invoices_endpoint_guard
  BEFORE UPDATE ON gateway_invoices
  FOR EACH ROW EXECUTE FUNCTION nexa_gateway_invoices_endpoint_guard();
