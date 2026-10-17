ALTER TABLE "discounts" ADD COLUMN "source_detail" jsonb;--> statement-breakpoint
ALTER TABLE "resellers" ADD COLUMN "imported_purchase_cap_minor" bigint;--> statement-breakpoint
ALTER TABLE "resellers" ADD COLUMN "imported_purchase_cap_currency" text;--> statement-breakpoint
ALTER TABLE "resellers" ADD COLUMN "source_detail" jsonb;--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_source_detail_check" CHECK (source_detail IS NULL OR source = 'MIRZA');--> statement-breakpoint
ALTER TABLE "resellers" ADD CONSTRAINT "resellers_source_detail_check" CHECK (source_detail IS NULL OR source = 'MIRZA');--> statement-breakpoint
ALTER TABLE "resellers" ADD CONSTRAINT "resellers_imported_cap_check" CHECK ((imported_purchase_cap_minor IS NULL) = (imported_purchase_cap_currency IS NULL)
        AND (imported_purchase_cap_minor IS NULL OR (source = 'MIRZA' AND imported_purchase_cap_minor >= 0)));--> statement-breakpoint
ALTER TABLE "resellers" ADD CONSTRAINT "resellers_imported_cap_currency_check" CHECK (imported_purchase_cap_currency IS NULL OR imported_purchase_cap_currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT'));