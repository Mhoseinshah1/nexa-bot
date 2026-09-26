-- WP10G (docs/customer-blocking-consistency-audit.md §4.5): the Telegram customers section's
-- block reads its MANDATORY reason through the same capture table as the receipt's Block User,
-- so a capture may now name a CUSTOMER instead of a payment.
--
-- Generated from `schema.ts`, so the drift check covers it.
--
-- `payment_id` loses NOT NULL and `customer_id` arrives nullable, with a composite foreign key
-- into `customers (tenant_id, id)` so a capture cannot name another tenant's customer. The new
-- target CHECK ties each purpose to exactly its own column: the three receipt purposes to a
-- payment and never a customer, `CUSTOMER_BLOCK_REASON` to a customer and never a payment.
-- Every existing row is a receipt purpose with a payment, so the CHECK holds on arrival with no
-- data change. The confirmed-check and the purpose-column check are dropped and re-added to
-- admit the new purpose (a confirmed block reason capture has a reason; it never carries an
-- amount). The partial unique index on (tenant, bot, admin) is untouched, and is the point:
-- one open prompt per administrator per bot, across every purpose.

ALTER TABLE "admin_amount_captures" DROP CONSTRAINT "admin_amount_captures_confirmed_check";--> statement-breakpoint
ALTER TABLE "admin_amount_captures" DROP CONSTRAINT "admin_amount_captures_purpose_check";--> statement-breakpoint
ALTER TABLE "admin_amount_captures" DROP CONSTRAINT "admin_amount_captures_purpose_column_check";--> statement-breakpoint
ALTER TABLE "admin_amount_captures" ALTER COLUMN "payment_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_amount_captures" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "admin_amount_captures" ADD CONSTRAINT "admin_amount_captures_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_amount_captures" ADD CONSTRAINT "admin_amount_captures_target_check" CHECK ((purpose IN ('RECEIPT_CREDIT_AMOUNT', 'RECEIPT_BLOCK_REASON', 'RECEIPT_REJECT_REASON')
            AND payment_id IS NOT NULL AND customer_id IS NULL)
          OR (purpose = 'CUSTOMER_BLOCK_REASON' AND customer_id IS NOT NULL AND payment_id IS NULL));--> statement-breakpoint
ALTER TABLE "admin_amount_captures" ADD CONSTRAINT "admin_amount_captures_confirmed_check" CHECK (close_reason IS DISTINCT FROM 'CONFIRMED'
          OR (purpose = 'RECEIPT_CREDIT_AMOUNT' AND amount_minor IS NOT NULL)
          OR (purpose IN ('RECEIPT_BLOCK_REASON', 'RECEIPT_REJECT_REASON', 'CUSTOMER_BLOCK_REASON') AND reason IS NOT NULL));--> statement-breakpoint
ALTER TABLE "admin_amount_captures" ADD CONSTRAINT "admin_amount_captures_purpose_check" CHECK (purpose IN ('RECEIPT_CREDIT_AMOUNT', 'RECEIPT_BLOCK_REASON', 'RECEIPT_REJECT_REASON', 'CUSTOMER_BLOCK_REASON'));--> statement-breakpoint
ALTER TABLE "admin_amount_captures" ADD CONSTRAINT "admin_amount_captures_purpose_column_check" CHECK ((purpose = 'RECEIPT_CREDIT_AMOUNT' AND reason IS NULL)
          OR (purpose IN ('RECEIPT_BLOCK_REASON', 'RECEIPT_REJECT_REASON', 'CUSTOMER_BLOCK_REASON') AND amount_minor IS NULL));--> statement-breakpoint
-- The customers section's one-tap block (WP2) stored this fixed English note as the "reason",
-- and from pre-release V2 to WP10G wrote it with blocked_reason_shown TRUE. It names the
-- surface, not a reason, and must never be shown; marking those rows not shown lets the flag
-- alone decide, instead of the bot reserving the sentence for ever. Hand-written: a data
-- change the schema file does not describe, so the drift check is unaffected.
UPDATE "customers" SET "blocked_reason_shown" = false
 WHERE "blocked_reason" = 'Blocked from the Telegram management panel.' AND "blocked_reason_shown";
