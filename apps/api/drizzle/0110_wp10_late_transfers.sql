CREATE TABLE "late_transfer_decisions" (
	"tenant_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"reason" text,
	"note" text,
	"amount" bigint,
	"currency" text,
	"wallet_entry_id" uuid,
	"decided_by_admin_id" uuid NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	CONSTRAINT "late_transfer_decisions_pkey" PRIMARY KEY("tenant_id","payment_id"),
	CONSTRAINT "late_transfer_decisions_decision_check" CHECK (decision IN ('CREDITED', 'DISMISSED')),
	CONSTRAINT "late_transfer_decisions_reason_enum_check" CHECK (reason IS NULL OR reason IN ('NOT_RECEIVED', 'AMOUNT_UNDERPAID', 'AMOUNT_OVERPAID', 'WRONG_BENEFICIARY', 'DUPLICATE_REFERENCE', 'UNREADABLE_EVIDENCE', 'OTHER')),
	CONSTRAINT "late_transfer_decisions_reason_check" CHECK ((decision = 'DISMISSED') = (reason IS NOT NULL)),
	CONSTRAINT "late_transfer_decisions_note_check" CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 500),
	CONSTRAINT "late_transfer_decisions_currency_check" CHECK (currency IS NULL OR currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "late_transfer_decisions_credit_check" CHECK ((decision = 'CREDITED') = (amount IS NOT NULL) AND (amount IS NULL) = (currency IS NULL) AND (amount IS NULL) = (wallet_entry_id IS NULL) AND (amount IS NULL OR amount > 0))
);
--> statement-breakpoint
ALTER TABLE "customer_notifications" DROP CONSTRAINT "customer_notifications_kind_check";--> statement-breakpoint
ALTER TABLE "wallet_entries" DROP CONSTRAINT "wallet_entries_reason_check";--> statement-breakpoint
ALTER TABLE "late_transfer_decisions" ADD CONSTRAINT "late_transfer_decisions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "late_transfer_decisions" ADD CONSTRAINT "late_transfer_decisions_decided_by_admin_id_admins_id_fk" FOREIGN KEY ("decided_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "late_transfer_decisions" ADD CONSTRAINT "late_transfer_decisions_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "late_transfer_decisions" ADD CONSTRAINT "late_transfer_decisions_entry_fk" FOREIGN KEY ("tenant_id","wallet_entry_id") REFERENCES "public"."wallet_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_entries_late_transfer_payment_key" ON "wallet_entries" USING btree ("tenant_id","payment_id") WHERE reason = 'LATE_TRANSFER';--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_kind_check" CHECK (kind IN ('PAYMENT_REJECTED', 'PAYMENT_EXPIRED', 'ORDER_EXPIRED', 'SERVICE_ACTION_SUCCEEDED', 'SERVICE_ACTION_FAILED', 'SERVICE_PROVISION_DELAYED', 'PAYMENT_TRANSFER_RECORDED', 'ORDER_CANCELLED', 'WALLET_TOPUP_CREDITED', 'ORDER_REFUNDED_TO_WALLET', 'SERVICE_EXPIRY_FIRST', 'SERVICE_EXPIRY_SECOND', 'SERVICE_EXPIRED', 'SERVICE_USAGE_FIRST', 'SERVICE_USAGE_SECOND', 'SERVICE_USAGE_FINAL', 'TRIAL_NOT_DELIVERED', 'PAYMENT_EXPIRED_UNDER_REVIEW', 'LATE_TRANSFER_CREDITED', 'REFUND_COMPLETED'));--> statement-breakpoint
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_late_transfer_payment_check" CHECK (reason <> 'LATE_TRANSFER' OR payment_id IS NOT NULL);--> statement-breakpoint
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_reason_check" CHECK (reason IN ('TOPUP_GATEWAY', 'TOPUP_RECEIPT', 'TOPUP_STARS', 'TOPUP_CRYPTO', 'LATE_TRANSFER', 'PURCHASE', 'PURCHASE_REVERSAL', 'REFUND', 'CASHBACK_GATEWAY', 'CASHBACK_TOPUP', 'CASHBACK_RENEWAL', 'CASHBACK_PURCHASE', 'CASHBACK_REVERSAL', 'REFERRAL_COMMISSION', 'REFERRAL_COMMISSION_REVERSAL', 'REFERRAL_SIGNUP_GIFT', 'START_GIFT', 'LOTTERY_WIN', 'LUCK_WHEEL_WIN', 'ADMIN_CREDIT', 'ADMIN_DEBIT', 'MASS_CREDIT', 'MASS_DEBIT', 'RESELLER_SETTLEMENT', 'RESELLER_MEMBERSHIP_FEE', 'CHARGEBACK', 'CORRECTION', 'OTHER'));