CREATE TABLE "customer_account_transfers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"from_customer_id" uuid NOT NULL,
	"to_customer_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"service_ids" jsonb NOT NULL,
	"wallet_amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"debit_entry_id" uuid,
	"credit_entry_id" uuid,
	"fingerprint" text NOT NULL,
	"reason" text NOT NULL,
	"actor_admin_id" uuid,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_account_transfers_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "customer_account_transfers_parties_check" CHECK (from_customer_id <> to_customer_id),
	CONSTRAINT "customer_account_transfers_currency_check" CHECK (currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "customer_account_transfers_amount_check" CHECK (wallet_amount >= 0),
	CONSTRAINT "customer_account_transfers_entries_check" CHECK ((wallet_amount = 0) = (debit_entry_id IS NULL) AND (debit_entry_id IS NULL) = (credit_entry_id IS NULL)),
	CONSTRAINT "customer_account_transfers_key_check" CHECK (length(idempotency_key) BETWEEN 1 AND 255),
	CONSTRAINT "customer_account_transfers_reason_check" CHECK (length(reason) BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE TABLE "customer_location_change_overrides" (
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"cooldown_hours" integer,
	"max_changes" integer,
	"period_days" integer,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_location_change_overrides_pkey" PRIMARY KEY("tenant_id","customer_id"),
	CONSTRAINT "customer_location_change_overrides_limits_check" CHECK ((cooldown_hours IS NULL OR cooldown_hours BETWEEN 1 AND 8760)
        AND (max_changes IS NULL OR max_changes BETWEEN 1 AND 100)
        AND (period_days IS NULL OR period_days BETWEEN 1 AND 365)
        AND ((max_changes IS NULL) = (period_days IS NULL)))
);
--> statement-breakpoint
ALTER TABLE "wallet_entries" DROP CONSTRAINT "wallet_entries_reason_check";--> statement-breakpoint
ALTER TABLE "service_ownership_transfers" ALTER COLUMN "bot_instance_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "channel_membership_exempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "phone_number" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "phone_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_account_transfers" ADD CONSTRAINT "customer_account_transfers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_account_transfers" ADD CONSTRAINT "customer_account_transfers_actor_admin_id_admins_id_fk" FOREIGN KEY ("actor_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_account_transfers" ADD CONSTRAINT "customer_account_transfers_from_fk" FOREIGN KEY ("tenant_id","from_customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_account_transfers" ADD CONSTRAINT "customer_account_transfers_to_fk" FOREIGN KEY ("tenant_id","to_customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_account_transfers" ADD CONSTRAINT "customer_account_transfers_debit_fk" FOREIGN KEY ("tenant_id","debit_entry_id") REFERENCES "public"."wallet_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_account_transfers" ADD CONSTRAINT "customer_account_transfers_credit_fk" FOREIGN KEY ("tenant_id","credit_entry_id") REFERENCES "public"."wallet_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_location_change_overrides" ADD CONSTRAINT "customer_location_change_overrides_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_location_change_overrides" ADD CONSTRAINT "customer_location_change_overrides_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_account_transfers_from_idx" ON "customer_account_transfers" USING btree ("tenant_id","from_customer_id","created_at");--> statement-breakpoint
CREATE INDEX "customer_account_transfers_to_idx" ON "customer_account_transfers" USING btree ("tenant_id","to_customer_id","created_at");--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_phone_check" CHECK ((phone_number IS NULL) = (phone_verified_at IS NULL));--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_phone_format_check" CHECK (phone_number IS NULL OR phone_number ~ '^[+][1-9][0-9]{7,14}$');--> statement-breakpoint
ALTER TABLE "service_ownership_transfers" ADD CONSTRAINT "service_ownership_transfers_bot_check" CHECK (bot_instance_id IS NOT NULL OR actor_type <> 'CUSTOMER');--> statement-breakpoint
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_reason_check" CHECK (reason IN ('TOPUP_GATEWAY', 'TOPUP_RECEIPT', 'TOPUP_STARS', 'TOPUP_CRYPTO', 'RECEIPT_CREDIT', 'PURCHASE', 'PURCHASE_REVERSAL', 'REFUND', 'CASHBACK_GATEWAY', 'CASHBACK_TOPUP', 'CASHBACK_RENEWAL', 'CASHBACK_PURCHASE', 'CASHBACK_REVERSAL', 'REFERRAL_COMMISSION', 'REFERRAL_COMMISSION_REVERSAL', 'REFERRAL_SIGNUP_GIFT', 'START_GIFT', 'LOTTERY_WIN', 'LUCK_WHEEL_WIN', 'ADMIN_CREDIT', 'ADMIN_DEBIT', 'MASS_CREDIT', 'MASS_DEBIT', 'ACCOUNT_TRANSFER_OUT', 'ACCOUNT_TRANSFER_IN', 'RESELLER_SETTLEMENT', 'RESELLER_MEMBERSHIP_FEE', 'CHARGEBACK', 'CORRECTION', 'OTHER'));