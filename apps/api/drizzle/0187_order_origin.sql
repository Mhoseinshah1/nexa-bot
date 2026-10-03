ALTER TABLE "orders" ADD COLUMN "origin" text DEFAULT 'STANDARD' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_origin_check" CHECK (origin IN ('STANDARD', 'LEGACY_ADOPTION'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_legacy_adoption_shape_check" CHECK (origin <> 'LEGACY_ADOPTION' OR (purpose = 'NEW_SERVICE' AND state = 'PAID'
          AND subtotal_amount = 0 AND discount_amount = 0 AND total_amount = 0
          AND discount_code IS NULL));