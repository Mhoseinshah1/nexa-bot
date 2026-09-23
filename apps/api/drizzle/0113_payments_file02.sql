-- Payment File 02 (`docs/payments-file02-design.md`): the schema half of D2, D3, D5 and
-- D7. Generated from `schema.ts`, so the drift check covers every statement; the guards
-- drizzle-kit does not model are 0114.
--
-- - `receipt_credits`: a card-to-card receipt's credit-to-wallet disposition (D2), one
--   per payment by its primary key.
-- - `wallet_entries`: `RECEIPT_CREDIT` replaces nothing (the withdrawn `LATE_TRANSFER`
--   never merged), and both it and `CASHBACK_TOPUP` must name a payment and occur at most
--   once per payment — invariants 8 and 11 of File 02 §23, held by partial unique indexes
--   that ship with the code relying on them, for the reason 0068 gives. Neither predicate
--   matches an existing row: neither reason has had a writer before this release.
-- - `payment_receipts.caption`: the customer's own caption, bounded to Telegram's 1024.
-- - `payment_gateways.topup_cashback_percent`: the route's top-up gift, 0 by default so
--   every existing route keeps promising nothing (D5).
-- - `payments.gateway_provider` and `payments.topup_cashback_percent`: the snapshot a
--   payment takes of its route when it is created, nullable because every existing
--   payment has none. 0114 freezes both after insert.
--
-- Each CHECK this drops is re-added in this same file and this same transaction, so no
-- window exists in which the column accepts a value outside the enum.

CREATE TABLE "receipt_credits" (
	"tenant_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"wallet_entry_id" uuid NOT NULL,
	"decided_by_admin_id" uuid NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"note" text,
	CONSTRAINT "receipt_credits_pkey" PRIMARY KEY("tenant_id","payment_id"),
	CONSTRAINT "receipt_credits_amount_check" CHECK (amount > 0),
	CONSTRAINT "receipt_credits_currency_check" CHECK (currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "receipt_credits_note_check" CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 500)
);
--> statement-breakpoint
ALTER TABLE "customer_notifications" DROP CONSTRAINT "customer_notifications_kind_check";--> statement-breakpoint
ALTER TABLE "wallet_entries" DROP CONSTRAINT "wallet_entries_reason_check";--> statement-breakpoint
ALTER TABLE "payment_gateways" ADD COLUMN "topup_cashback_percent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_receipts" ADD COLUMN "caption" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "gateway_provider" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "topup_cashback_percent" integer;--> statement-breakpoint
ALTER TABLE "receipt_credits" ADD CONSTRAINT "receipt_credits_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_credits" ADD CONSTRAINT "receipt_credits_decided_by_admin_id_admins_id_fk" FOREIGN KEY ("decided_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_credits" ADD CONSTRAINT "receipt_credits_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_credits" ADD CONSTRAINT "receipt_credits_entry_fk" FOREIGN KEY ("tenant_id","wallet_entry_id") REFERENCES "public"."wallet_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_entries_receipt_credit_payment_key" ON "wallet_entries" USING btree ("tenant_id","payment_id") WHERE reason = 'RECEIPT_CREDIT';--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_entries_topup_cashback_payment_key" ON "wallet_entries" USING btree ("tenant_id","payment_id") WHERE reason = 'CASHBACK_TOPUP';--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_kind_check" CHECK (kind IN ('PAYMENT_REJECTED', 'PAYMENT_EXPIRED', 'ORDER_EXPIRED', 'SERVICE_ACTION_SUCCEEDED', 'SERVICE_ACTION_FAILED', 'SERVICE_PROVISION_DELAYED', 'PAYMENT_TRANSFER_RECORDED', 'ORDER_CANCELLED', 'WALLET_TOPUP_CREDITED', 'ORDER_REFUNDED_TO_WALLET', 'SERVICE_EXPIRY_FIRST', 'SERVICE_EXPIRY_SECOND', 'SERVICE_EXPIRED', 'SERVICE_USAGE_FIRST', 'SERVICE_USAGE_SECOND', 'SERVICE_USAGE_FINAL', 'TRIAL_NOT_DELIVERED', 'RECEIPT_CREDITED_TO_WALLET', 'WALLET_TOPUP_GIFT_CREDITED', 'REFUND_COMPLETED'));--> statement-breakpoint
ALTER TABLE "payment_gateways" ADD CONSTRAINT "payment_gateways_topup_cashback_percent_check" CHECK (topup_cashback_percent BETWEEN 0 AND 100);--> statement-breakpoint
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_caption_check" CHECK (caption IS NULL OR length(caption) BETWEEN 1 AND 1024);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_gateway_provider_check" CHECK (gateway_provider IS NULL OR gateway_provider IN ('MANUAL_TRANSFER'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_topup_cashback_percent_check" CHECK (topup_cashback_percent IS NULL OR topup_cashback_percent BETWEEN 0 AND 100);--> statement-breakpoint
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_receipt_credit_payment_check" CHECK (reason <> 'RECEIPT_CREDIT' OR payment_id IS NOT NULL);--> statement-breakpoint
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_topup_cashback_payment_check" CHECK (reason <> 'CASHBACK_TOPUP' OR payment_id IS NOT NULL);--> statement-breakpoint
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_reason_check" CHECK (reason IN ('TOPUP_GATEWAY', 'TOPUP_RECEIPT', 'TOPUP_STARS', 'TOPUP_CRYPTO', 'RECEIPT_CREDIT', 'PURCHASE', 'PURCHASE_REVERSAL', 'REFUND', 'CASHBACK_GATEWAY', 'CASHBACK_TOPUP', 'CASHBACK_RENEWAL', 'CASHBACK_PURCHASE', 'CASHBACK_REVERSAL', 'REFERRAL_COMMISSION', 'REFERRAL_COMMISSION_REVERSAL', 'REFERRAL_SIGNUP_GIFT', 'START_GIFT', 'LOTTERY_WIN', 'LUCK_WHEEL_WIN', 'ADMIN_CREDIT', 'ADMIN_DEBIT', 'MASS_CREDIT', 'MASS_DEBIT', 'RESELLER_SETTLEMENT', 'RESELLER_MEMBERSHIP_FEE', 'CHARGEBACK', 'CORRECTION', 'OTHER'));