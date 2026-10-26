ALTER TABLE "customers" ADD COLUMN "personal_discount_percent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "personal_discount_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_personal_discount_check" CHECK (personal_discount_percent BETWEEN 0 AND 100);