-- TonPays «لینک پرداخت»: the route's choice of TonPays' bot link (invoice_url) or web link
-- (web_invoice_url), and that choice frozen on each attempt. Both default to TELEGRAM_BOT; no
-- customer is sent anything by this migration. gateway_invoices is a large table
-- (scripts/large-tables.txt), so its CHECK is added NOT VALID, then VALIDATEd. Only hand edit
-- of the generated SQL; journal and snapshot are untouched.
ALTER TABLE "gateway_invoices" ADD COLUMN "payment_link" text DEFAULT 'TELEGRAM_BOT' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_gateways" ADD COLUMN "tonpays_payment_link" text DEFAULT 'TELEGRAM_BOT' NOT NULL;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_payment_link_check" CHECK (payment_link IN ('TELEGRAM_BOT', 'WEB')) NOT VALID;--> statement-breakpoint
ALTER TABLE "gateway_invoices" VALIDATE CONSTRAINT "gateway_invoices_payment_link_check";--> statement-breakpoint
ALTER TABLE "payment_gateways" ADD CONSTRAINT "payment_gateways_tonpays_payment_link_check" CHECK (tonpays_payment_link IN ('TELEGRAM_BOT', 'WEB'));