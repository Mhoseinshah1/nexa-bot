ALTER TABLE "gateway_invoices" ADD COLUMN "payment_link" text DEFAULT 'TELEGRAM_BOT' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_gateways" ADD COLUMN "tonpays_payment_link" text DEFAULT 'TELEGRAM_BOT' NOT NULL;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_payment_link_check" CHECK (payment_link IN ('TELEGRAM_BOT', 'WEB'));--> statement-breakpoint
ALTER TABLE "payment_gateways" ADD CONSTRAINT "payment_gateways_tonpays_payment_link_check" CHECK (tonpays_payment_link IN ('TELEGRAM_BOT', 'WEB'));