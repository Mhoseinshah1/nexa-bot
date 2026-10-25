-- Rialit (`docs/rialit-gateway-audit.md`, Round 9 item C4).
--
-- Additive: the provider roster widened on six tables (0275's shape), and
-- `gateway_invoices_rialit_check` (a Rialit attempt is billed in TOMAN with no conversion and no
-- bot, and its order id is the 1-64-byte `[A-Za-z0-9_.:-]` subset Nexa generates). No money
-- data, no Persian text, no balance, no row written, and no credential column: the API key uses
-- the column and AEAD purpose that already exist. The route starts DISABLED like every keyed one.
--
-- ROLLBACK NOTE. The previous release lists and claims only providers it knows, so a RIALIT row
-- neither breaks its gateway page nor stalls its worker - but it never reads an open Rialit
-- attempt, which then expires even if paid. Disable the route and drain first: `botctl rollback`
-- never restores the database.
ALTER TABLE "gateway_customer_numbers" DROP CONSTRAINT "gateway_customer_numbers_provider_check";--> statement-breakpoint
ALTER TABLE "gateway_invoices" DROP CONSTRAINT "gateway_invoices_provider_check";--> statement-breakpoint
ALTER TABLE "payment_gateway_call_budgets" DROP CONSTRAINT "payment_gateway_call_budgets_provider_check";--> statement-breakpoint
ALTER TABLE "payment_gateway_credentials" DROP CONSTRAINT "payment_gateway_credentials_provider_check";--> statement-breakpoint
ALTER TABLE "payment_gateways" DROP CONSTRAINT "payment_gateways_provider_check";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_gateway_provider_check";--> statement-breakpoint
ALTER TABLE "gateway_customer_numbers" ADD CONSTRAINT "gateway_customer_numbers_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS', 'TONPAYS_TELEGRAM', 'NOWPAYMENTS', 'CENTRALPAY', 'TETRAPAY', 'RIALIT'));--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_rialit_check" CHECK (provider <> 'RIALIT' OR (provider_unit = 'IRT' AND conversion_policy = 'SAME_UNIT' AND bot_instance_id IS NULL AND octet_length(provider_order_id) <= 64 AND provider_order_id ~ '^[A-Za-z0-9_.:-]{1,64}$'));--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS', 'TONPAYS_TELEGRAM', 'NOWPAYMENTS', 'CENTRALPAY', 'TETRAPAY', 'RIALIT'));--> statement-breakpoint
ALTER TABLE "payment_gateway_call_budgets" ADD CONSTRAINT "payment_gateway_call_budgets_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS', 'TONPAYS_TELEGRAM', 'NOWPAYMENTS', 'CENTRALPAY', 'TETRAPAY', 'RIALIT'));--> statement-breakpoint
ALTER TABLE "payment_gateway_credentials" ADD CONSTRAINT "payment_gateway_credentials_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS', 'TONPAYS_TELEGRAM', 'NOWPAYMENTS', 'CENTRALPAY', 'TETRAPAY', 'RIALIT'));--> statement-breakpoint
ALTER TABLE "payment_gateways" ADD CONSTRAINT "payment_gateways_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS', 'TONPAYS_TELEGRAM', 'NOWPAYMENTS', 'CENTRALPAY', 'TETRAPAY', 'RIALIT'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_gateway_provider_check" CHECK (gateway_provider IS NULL OR gateway_provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS', 'TONPAYS_TELEGRAM', 'NOWPAYMENTS', 'CENTRALPAY', 'TETRAPAY', 'RIALIT'));