-- NOWPayments (`docs/nowpayments-gateway-audit.md`, spec §16).
--
-- Additive: the provider roster widened on five tables (0127's and 0157's shape), the
-- review-window CHECK widened to the routes that review (TonPays Telegram and NOWPayments),
-- the webhook signing secret and the last credential check on `payment_gateway_credentials`
-- (all-or-none CHECKs), and on `gateway_invoices` the hinted provider payment id and the
-- NOWPayments snapshot CHECK (US cents, central FX, no bot). No money data, no Persian text,
-- no balance, no row written.
--
-- ROLLBACK NOTE. The release boots and seeds a DISABLED NOWPAYMENTS route row per tenant. The
-- previous (0157) binary has no NOWPAYMENTS descriptor and indexes the descriptor map by every
-- row's provider: its Web Admin gateway list throws, an ACTIVE row breaks its customer route
-- evaluator, and an open NOWPayments attempt stalls its gateway worker. Before rolling back,
-- follow `docs/deployment.md`, "Before rolling back past NOWPayments (0158)": disable the
-- route, wait until no NOWPayments payment is PENDING/UNKNOWN and nothing is scheduled, then
-- delete the NOWPAYMENTS budget, credential and route rows. `botctl rollback` never restores
-- the database (CLAUDE.md).
ALTER TABLE "gateway_invoices" DROP CONSTRAINT "gateway_invoices_provider_check";--> statement-breakpoint
ALTER TABLE "payment_gateway_call_budgets" DROP CONSTRAINT "payment_gateway_call_budgets_provider_check";--> statement-breakpoint
ALTER TABLE "payment_gateway_credentials" DROP CONSTRAINT "payment_gateway_credentials_provider_check";--> statement-breakpoint
ALTER TABLE "payment_gateways" DROP CONSTRAINT "payment_gateways_provider_check";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_gateway_provider_check";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_provider_review_check";--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD COLUMN "hinted_payment_id" text;--> statement-breakpoint
ALTER TABLE "payment_gateway_credentials" ADD COLUMN "webhook_secret_ciphertext" text;--> statement-breakpoint
ALTER TABLE "payment_gateway_credentials" ADD COLUMN "webhook_secret_key_id" text;--> statement-breakpoint
ALTER TABLE "payment_gateway_credentials" ADD COLUMN "webhook_secret_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_gateway_credentials" ADD COLUMN "last_check_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_gateway_credentials" ADD COLUMN "last_check_result" text;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_hinted_payment_id_check" CHECK (hinted_payment_id IS NULL OR hinted_payment_id ~ '^[0-9]{1,20}$');--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_nowpayments_check" CHECK (provider <> 'NOWPAYMENTS' OR (provider_unit = 'USD' AND conversion_policy = 'CENTRAL_FX' AND bot_instance_id IS NULL));--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS', 'TONPAYS_TELEGRAM', 'NOWPAYMENTS'));--> statement-breakpoint
ALTER TABLE "payment_gateway_call_budgets" ADD CONSTRAINT "payment_gateway_call_budgets_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS', 'TONPAYS_TELEGRAM', 'NOWPAYMENTS'));--> statement-breakpoint
ALTER TABLE "payment_gateway_credentials" ADD CONSTRAINT "payment_gateway_credentials_webhook_secret_check" CHECK ((webhook_secret_ciphertext IS NULL) = (webhook_secret_key_id IS NULL) AND (webhook_secret_ciphertext IS NULL) = (webhook_secret_set_at IS NULL));--> statement-breakpoint
ALTER TABLE "payment_gateway_credentials" ADD CONSTRAINT "payment_gateway_credentials_last_check_check" CHECK ((last_check_at IS NULL) = (last_check_result IS NULL) AND (last_check_result IS NULL OR length(last_check_result) BETWEEN 1 AND 64));--> statement-breakpoint
ALTER TABLE "payment_gateway_credentials" ADD CONSTRAINT "payment_gateway_credentials_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS', 'TONPAYS_TELEGRAM', 'NOWPAYMENTS'));--> statement-breakpoint
ALTER TABLE "payment_gateways" ADD CONSTRAINT "payment_gateways_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS', 'TONPAYS_TELEGRAM', 'NOWPAYMENTS'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_gateway_provider_check" CHECK (gateway_provider IS NULL OR gateway_provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS', 'TONPAYS_TELEGRAM', 'NOWPAYMENTS'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_provider_review_check" CHECK ((provider_review_started_at IS NULL) = (provider_review_until IS NULL) AND (provider_review_until IS NULL OR (method = 'GATEWAY' AND gateway_provider IN ('TONPAYS_TELEGRAM', 'NOWPAYMENTS') AND expires_at IS NOT NULL AND provider_review_started_at < expires_at AND provider_review_until = provider_review_started_at + interval '24 hours')));