CREATE TABLE "gift_card_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"label" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"code_count" integer NOT NULL,
	"per_customer_limit" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'ACTIVE' NOT NULL,
	"reason" text NOT NULL,
	"created_by_admin_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"disabled_at" timestamp with time zone,
	"disabled_by_admin_id" uuid,
	"export_ciphertext" text,
	"export_key_id" text,
	"export_expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gift_card_batches_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "gift_card_batches_state_check" CHECK (state IN ('ACTIVE', 'DISABLED')),
	CONSTRAINT "gift_card_batches_currency_check" CHECK (currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "gift_card_batches_amount_check" CHECK (amount_minor > 0),
	CONSTRAINT "gift_card_batches_count_check" CHECK (code_count BETWEEN 1 AND 5000),
	CONSTRAINT "gift_card_batches_limit_check" CHECK (per_customer_limit IS NULL OR per_customer_limit >= 1),
	CONSTRAINT "gift_card_batches_label_check" CHECK (char_length(label) BETWEEN 1 AND 80),
	CONSTRAINT "gift_card_batches_reason_check" CHECK (char_length(reason) BETWEEN 1 AND 300),
	CONSTRAINT "gift_card_batches_window_check" CHECK (expires_at > created_at),
	CONSTRAINT "gift_card_batches_disabled_check" CHECK ((state = 'DISABLED') = (disabled_at IS NOT NULL)),
	CONSTRAINT "gift_card_batches_export_check" CHECK ((export_ciphertext IS NULL) = (export_key_id IS NULL))
);
--> statement-breakpoint
CREATE TABLE "gift_card_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"last4" text NOT NULL,
	"state" text DEFAULT 'ACTIVE' NOT NULL,
	"disabled_at" timestamp with time zone,
	"redeemed_at" timestamp with time zone,
	"redeemed_by_customer_id" uuid,
	"wallet_entry_id" uuid,
	CONSTRAINT "gift_card_codes_state_check" CHECK (state IN ('ACTIVE', 'DISABLED')),
	CONSTRAINT "gift_card_codes_hash_check" CHECK (code_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "gift_card_codes_last4_check" CHECK (last4 ~ '^[2-9A-HJKMNP-TV-Z]{4}$'),
	CONSTRAINT "gift_card_codes_redeemed_check" CHECK ((redeemed_at IS NULL) = (redeemed_by_customer_id IS NULL)
        AND (redeemed_at IS NULL) = (wallet_entry_id IS NULL)),
	CONSTRAINT "gift_card_codes_disabled_check" CHECK ((state = 'DISABLED') = (disabled_at IS NOT NULL)
        AND NOT (state = 'DISABLED' AND redeemed_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "gift_card_redemption_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"attempted_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"code_id" uuid,
	CONSTRAINT "gift_card_redemption_attempts_outcome_check" CHECK (outcome IN ('MALFORMED', 'UNKNOWN', 'USED', 'EXPIRED', 'DISABLED', 'LIMIT_REACHED', 'CURRENCY_MISMATCH'))
);
--> statement-breakpoint
ALTER TABLE "customer_text_captures" DROP CONSTRAINT "customer_text_captures_purpose_check";--> statement-breakpoint
ALTER TABLE "wallet_entries" DROP CONSTRAINT "wallet_entries_reason_check";--> statement-breakpoint
ALTER TABLE "gift_card_batches" ADD CONSTRAINT "gift_card_batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_batches" ADD CONSTRAINT "gift_card_batches_created_by_admin_id_admins_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_batches" ADD CONSTRAINT "gift_card_batches_disabled_by_admin_id_admins_id_fk" FOREIGN KEY ("disabled_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_codes" ADD CONSTRAINT "gift_card_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_codes" ADD CONSTRAINT "gift_card_codes_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."gift_card_batches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_codes" ADD CONSTRAINT "gift_card_codes_customer_fk" FOREIGN KEY ("tenant_id","redeemed_by_customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_redemption_attempts" ADD CONSTRAINT "gift_card_redemption_attempts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_redemption_attempts" ADD CONSTRAINT "gift_card_redemption_attempts_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gift_card_batches_tenant_created_idx" ON "gift_card_batches" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "gift_card_codes_tenant_hash_key" ON "gift_card_codes" USING btree ("tenant_id","code_hash");--> statement-breakpoint
CREATE INDEX "gift_card_codes_batch_customer_idx" ON "gift_card_codes" USING btree ("tenant_id","batch_id","redeemed_by_customer_id");--> statement-breakpoint
CREATE INDEX "gift_card_redemption_attempts_customer_idx" ON "gift_card_redemption_attempts" USING btree ("tenant_id","customer_id","attempted_at");--> statement-breakpoint
ALTER TABLE "customer_text_captures" ADD CONSTRAINT "customer_text_captures_purpose_check" CHECK (purpose IN ('TOPUP_AMOUNT', 'SERVICE_SEARCH', 'SERVICE_NOTE', 'SERVICE_REFUND_REASON', 'CUSTOM_SERVICE_VOLUME', 'CUSTOM_SERVICE_DAYS', 'SERVICE_TRANSFER_RECIPIENT', 'TICKET_NEW_MESSAGE', 'TICKET_REPLY', 'GATEWAY_REFUND_CARD', 'GIFT_CARD_CODE'));--> statement-breakpoint
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_gift_card_shape_check" CHECK ((reason = 'GIFT_CARD_REDEMPTION') = (left(reference, 9) = 'giftcard:')
        AND (reason <> 'GIFT_CARD_REDEMPTION' OR (direction = 'CREDIT' AND order_id IS NULL
          AND payment_id IS NULL AND reverses_entry_id IS NULL AND actor_admin_id IS NULL)));--> statement-breakpoint
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_reason_check" CHECK (reason IN ('TOPUP_GATEWAY', 'TOPUP_RECEIPT', 'TOPUP_STARS', 'TOPUP_CRYPTO', 'RECEIPT_CREDIT', 'GATEWAY_LATE_CREDIT', 'PURCHASE', 'PURCHASE_REVERSAL', 'REFUND', 'CASHBACK_GATEWAY', 'CASHBACK_TOPUP', 'CASHBACK_RENEWAL', 'CASHBACK_PURCHASE', 'CASHBACK_REVERSAL', 'REFERRAL_COMMISSION', 'REFERRAL_COMMISSION_REVERSAL', 'REFERRAL_SIGNUP_GIFT', 'GIFT_CARD_REDEMPTION', 'START_GIFT', 'LOTTERY_WIN', 'LUCK_WHEEL_WIN', 'ADMIN_CREDIT', 'ADMIN_DEBIT', 'MASS_CREDIT', 'MASS_DEBIT', 'ACCOUNT_TRANSFER_OUT', 'ACCOUNT_TRANSFER_IN', 'RESELLER_SETTLEMENT', 'RESELLER_MEMBERSHIP_FEE', 'MIGRATION_OPENING_BALANCE', 'CHARGEBACK', 'CORRECTION', 'OTHER'));