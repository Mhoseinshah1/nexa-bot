-- TetraPay (Tetra98) (`docs/tetrapay-gateway-audit.md`, Round 6 item 6).
--
-- Additive: the provider roster widened on six tables (0164's shape); `payment_gateways.hidden_until`
-- (nullable) - the instant until which the PROVIDER's own daily limit hides a route, never the
-- operator's switch; and `gateway_invoices_tetrapay_check` (a TetraPay attempt is billed in
-- RIAL with no conversion and no bot, with the provider's documented order-id shape). No money
-- data, no Persian text, no balance, no row written, and no credential column: the API key and
-- the optional webhook secret use the columns and AEAD purposes that already exist.
--
-- ROLLBACK NOTE. The previous release lists and claims only providers it knows, so a TETRAPAY
-- row neither breaks its gateway page nor stalls its worker - but it never verifies an open
-- TetraPay attempt, which then expires even if paid. Disable the route and drain first:
-- `botctl rollback` never restores the database.
ALTER TABLE "gateway_customer_numbers" DROP CONSTRAINT "gateway_customer_numbers_provider_check";--> statement-breakpoint
ALTER TABLE "gateway_invoices" DROP CONSTRAINT "gateway_invoices_provider_check";--> statement-breakpoint
ALTER TABLE "payment_gateway_call_budgets" DROP CONSTRAINT "payment_gateway_call_budgets_provider_check";--> statement-breakpoint
ALTER TABLE "payment_gateway_credentials" DROP CONSTRAINT "payment_gateway_credentials_provider_check";--> statement-breakpoint
ALTER TABLE "payment_gateways" DROP CONSTRAINT "payment_gateways_provider_check";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_gateway_provider_check";--> statement-breakpoint
ALTER TABLE "payment_gateways" ADD COLUMN "hidden_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gateway_customer_numbers" ADD CONSTRAINT "gateway_customer_numbers_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS', 'TONPAYS_TELEGRAM', 'NOWPAYMENTS', 'CENTRALPAY', 'TETRAPAY'));--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_tetrapay_check" CHECK (provider <> 'TETRAPAY' OR (provider_unit = 'IRR' AND conversion_policy = 'SAME_UNIT' AND bot_instance_id IS NULL AND provider_order_id ~ '^[A-Za-z0-9_.:-]{1,64}$'));--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS', 'TONPAYS_TELEGRAM', 'NOWPAYMENTS', 'CENTRALPAY', 'TETRAPAY'));--> statement-breakpoint
ALTER TABLE "payment_gateway_call_budgets" ADD CONSTRAINT "payment_gateway_call_budgets_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS', 'TONPAYS_TELEGRAM', 'NOWPAYMENTS', 'CENTRALPAY', 'TETRAPAY'));--> statement-breakpoint
ALTER TABLE "payment_gateway_credentials" ADD CONSTRAINT "payment_gateway_credentials_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS', 'TONPAYS_TELEGRAM', 'NOWPAYMENTS', 'CENTRALPAY', 'TETRAPAY'));--> statement-breakpoint
ALTER TABLE "payment_gateways" ADD CONSTRAINT "payment_gateways_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS', 'TONPAYS_TELEGRAM', 'NOWPAYMENTS', 'CENTRALPAY', 'TETRAPAY'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_gateway_provider_check" CHECK (gateway_provider IS NULL OR gateway_provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS', 'TONPAYS_TELEGRAM', 'NOWPAYMENTS', 'CENTRALPAY', 'TETRAPAY'));