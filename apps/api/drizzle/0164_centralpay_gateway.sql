-- CentralPay (`docs/centralpay-gateway-audit.md`, spec §17).
--
-- Additive: the provider roster widened on five tables (0158's shape); on
-- `payment_gateway_credentials` the separate verify key (all-or-none CHECK, its own AEAD
-- purpose); on `gateway_invoices` the customer's integer as sent (`provider_user_id`), the
-- CentralPay snapshot CHECK (Toman, same unit, no bot, ten-digit integers) and an order id
-- unique across EVERY tenant for CentralPay; and `gateway_customer_numbers`, the customer's
-- stable random integer per provider. The hand-written tail adds two write-once guards
-- drizzle-kit does not model. No money data, no Persian text, no balance, no row written.
--
-- ROLLBACK NOTE. The previous release lists and claims only providers it knows, so a
-- CENTRALPAY row neither breaks its gateway page nor stalls its worker — but it never
-- verifies an open CentralPay attempt, which then expires even if paid. Disable the route and
-- drain first: docs/deployment.md, "Before rolling back past CentralPay (0164)". `botctl
-- rollback` never restores the database.
CREATE TABLE "gateway_customer_numbers" (
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"number" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_customer_numbers_pk" PRIMARY KEY("tenant_id","provider","customer_id"),
	CONSTRAINT "gateway_customer_numbers_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS', 'TONPAYS_TELEGRAM', 'NOWPAYMENTS', 'CENTRALPAY')),
	CONSTRAINT "gateway_customer_numbers_number_check" CHECK (number BETWEEN 1000000000 AND 2147483647)
);
--> statement-breakpoint
ALTER TABLE "gateway_invoices" DROP CONSTRAINT "gateway_invoices_provider_check";--> statement-breakpoint
ALTER TABLE "payment_gateway_call_budgets" DROP CONSTRAINT "payment_gateway_call_budgets_provider_check";--> statement-breakpoint
ALTER TABLE "payment_gateway_credentials" DROP CONSTRAINT "payment_gateway_credentials_provider_check";--> statement-breakpoint
ALTER TABLE "payment_gateways" DROP CONSTRAINT "payment_gateways_provider_check";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_gateway_provider_check";--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD COLUMN "provider_user_id" text;--> statement-breakpoint
ALTER TABLE "payment_gateway_credentials" ADD COLUMN "verify_key_ciphertext" text;--> statement-breakpoint
ALTER TABLE "payment_gateway_credentials" ADD COLUMN "verify_key_key_id" text;--> statement-breakpoint
ALTER TABLE "payment_gateway_credentials" ADD COLUMN "verify_key_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gateway_customer_numbers" ADD CONSTRAINT "gateway_customer_numbers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_customer_numbers" ADD CONSTRAINT "gateway_customer_numbers_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_customer_numbers_number_key" ON "gateway_customer_numbers" USING btree ("provider","number");--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_invoices_centralpay_order_id_key" ON "gateway_invoices" USING btree ("provider_order_id") WHERE provider = 'CENTRALPAY';--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_centralpay_check" CHECK (provider <> 'CENTRALPAY' OR (provider_unit = 'IRT' AND conversion_policy = 'SAME_UNIT' AND bot_instance_id IS NULL AND provider_user_id IS NOT NULL AND provider_order_id ~ '^[0-9]{10}$'));--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_provider_user_id_check" CHECK (provider_user_id IS NULL OR (provider = 'CENTRALPAY' AND provider_user_id ~ '^[0-9]{10}$'));--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS', 'TONPAYS_TELEGRAM', 'NOWPAYMENTS', 'CENTRALPAY'));--> statement-breakpoint
ALTER TABLE "payment_gateway_call_budgets" ADD CONSTRAINT "payment_gateway_call_budgets_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS', 'TONPAYS_TELEGRAM', 'NOWPAYMENTS', 'CENTRALPAY'));--> statement-breakpoint
ALTER TABLE "payment_gateway_credentials" ADD CONSTRAINT "payment_gateway_credentials_verify_key_check" CHECK ((verify_key_ciphertext IS NULL) = (verify_key_key_id IS NULL) AND (verify_key_ciphertext IS NULL) = (verify_key_set_at IS NULL));--> statement-breakpoint
ALTER TABLE "payment_gateway_credentials" ADD CONSTRAINT "payment_gateway_credentials_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS', 'TONPAYS_TELEGRAM', 'NOWPAYMENTS', 'CENTRALPAY'));--> statement-breakpoint
ALTER TABLE "payment_gateways" ADD CONSTRAINT "payment_gateways_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS', 'TONPAYS_TELEGRAM', 'NOWPAYMENTS', 'CENTRALPAY'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_gateway_provider_check" CHECK (gateway_provider IS NULL OR gateway_provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS', 'TONPAYS_TELEGRAM', 'NOWPAYMENTS', 'CENTRALPAY'));--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers). The integer a customer was SENT as is
-- what a verify is judged against, so it is written once, when the attempt opens.
CREATE OR REPLACE FUNCTION nexa_gateway_invoices_provider_user_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.provider_user_id IS DISTINCT FROM OLD.provider_user_id THEN
    RAISE EXCEPTION 'gateway_invoices.provider_user_id is written once, when the attempt opens.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER nexa_gateway_invoices_provider_user_guard
  BEFORE UPDATE ON gateway_invoices
  FOR EACH ROW EXECUTE FUNCTION nexa_gateway_invoices_provider_user_guard();--> statement-breakpoint
-- A customer's provider number never changes: the provider may tie its own records to it.
CREATE OR REPLACE FUNCTION nexa_gateway_customer_numbers_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'gateway_customer_numbers rows are immutable.'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER nexa_gateway_customer_numbers_guard
  BEFORE UPDATE ON gateway_customer_numbers
  FOR EACH ROW EXECUTE FUNCTION nexa_gateway_customer_numbers_guard();
