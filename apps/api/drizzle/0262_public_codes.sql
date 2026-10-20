ALTER TABLE "orders" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "code_number" integer;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_code_check" CHECK (code IS NULL OR code ~ '^[2-9A-HJKMNP-TV-Z]{8}$');--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_code_check" CHECK (code IS NULL OR code ~ '^[2-9A-HJKMNP-TV-Z]{8}$');--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_code_number_check" CHECK (code_number IS NULL OR code_number > 0);--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_code_check" CHECK (code IS NULL OR code ~ '^[2-9A-HJKMNP-TV-Z]{8}$');--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_code_check" CHECK (code IS NULL OR code ~ '^[2-9A-HJKMNP-TV-Z]{8}$');