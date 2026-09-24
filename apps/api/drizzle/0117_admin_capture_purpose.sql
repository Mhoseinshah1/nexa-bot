-- WP10 follow-up (docs/wp10-followup-audit.md §4) and the owner's File 01 §7 correction: Block
-- User's and a rejection's mandatory reasons are read by the same capture table as the credit's
-- amount.
--
-- Generated from `schema.ts`, so the drift check covers it.
--
-- `purpose` defaults to RECEIPT_CREDIT_AMOUNT, so every existing row is a credit capture and
-- satisfies every new CHECK (its `reason` is NULL). The confirmed-check is dropped and re-added
-- in this one migration, per purpose: a confirmed credit has an amount, a confirmed block or
-- rejection has a reason — the database half of "the reason is mandatory". The partial unique
-- index on (tenant, bot, admin) is untouched, and is the point: one open prompt per
-- administrator per bot across every purpose.

ALTER TABLE "admin_amount_captures" DROP CONSTRAINT "admin_amount_captures_confirmed_check";--> statement-breakpoint
ALTER TABLE "admin_amount_captures" ADD COLUMN "purpose" text DEFAULT 'RECEIPT_CREDIT_AMOUNT' NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_amount_captures" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "admin_amount_captures" ADD CONSTRAINT "admin_amount_captures_purpose_check" CHECK (purpose IN ('RECEIPT_CREDIT_AMOUNT', 'RECEIPT_BLOCK_REASON', 'RECEIPT_REJECT_REASON'));--> statement-breakpoint
ALTER TABLE "admin_amount_captures" ADD CONSTRAINT "admin_amount_captures_purpose_column_check" CHECK ((purpose = 'RECEIPT_CREDIT_AMOUNT' AND reason IS NULL)
          OR (purpose IN ('RECEIPT_BLOCK_REASON', 'RECEIPT_REJECT_REASON') AND amount_minor IS NULL));--> statement-breakpoint
ALTER TABLE "admin_amount_captures" ADD CONSTRAINT "admin_amount_captures_reason_check" CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 500);--> statement-breakpoint
ALTER TABLE "admin_amount_captures" ADD CONSTRAINT "admin_amount_captures_confirmed_check" CHECK (close_reason IS DISTINCT FROM 'CONFIRMED'
          OR (purpose = 'RECEIPT_CREDIT_AMOUNT' AND amount_minor IS NOT NULL)
          OR (purpose IN ('RECEIPT_BLOCK_REASON', 'RECEIPT_REJECT_REASON') AND reason IS NOT NULL));