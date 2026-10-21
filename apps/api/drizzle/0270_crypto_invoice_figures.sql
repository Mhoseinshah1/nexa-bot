ALTER TABLE "gateway_invoices" ADD COLUMN "crypto_pay_currency" text;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD COLUMN "crypto_requested" text;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD COLUMN "crypto_paid" text;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD COLUMN "crypto_received" text;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD COLUMN "crypto_received_currency" text;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD COLUMN "crypto_pay_address" text;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_crypto_figures_check" CHECK ((crypto_pay_currency IS NULL OR length(crypto_pay_currency) BETWEEN 1 AND 24)
          AND (crypto_requested IS NULL OR crypto_requested ~ '^[0-9]{1,24}(\.[0-9]{1,18})?$')
          AND (crypto_paid IS NULL OR crypto_paid ~ '^[0-9]{1,24}(\.[0-9]{1,18})?$')
          AND (crypto_received IS NULL OR crypto_received ~ '^[0-9]{1,24}(\.[0-9]{1,18})?$')
          AND (crypto_received_currency IS NULL OR length(crypto_received_currency) BETWEEN 1 AND 24)
          AND (crypto_pay_address IS NULL OR length(crypto_pay_address) BETWEEN 1 AND 256));