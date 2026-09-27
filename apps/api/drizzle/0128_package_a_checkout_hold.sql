-- Package A — the Codex review of #85: an approved Telegram Stars pre-checkout holds its
-- payment against cancellation until the charge arrives (`TELEGRAM_STARS_CHECKOUT_HOLD_MS`).
--
-- Additive: one nullable column and a CHECK that only a GATEWAY payment carries a hold. The
-- release before this one never reads or writes the column, so a rollback leaves it inert.
ALTER TABLE "payments" ADD COLUMN "checkout_held_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_checkout_hold_check" CHECK (checkout_held_until IS NULL OR method = 'GATEWAY');