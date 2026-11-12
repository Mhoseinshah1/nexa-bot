-- Reseller-phase PR-6 (§5.9): a reseller's dedicated hosted bot — the request, its fee debits and
-- its short-wallet notices; the HOSTED_BOT_FEE ledger reason, its reference shape, two notification
-- kinds and two secret purposes. customer_notifications and wallet_entries are large tables
-- (scripts/large-tables.txt), so their CHECKs are added NOT VALID, then VALIDATEd. Only hand
-- edit: those three NOT VALID / VALIDATE pairs.
CREATE TABLE "reseller_bot_fee_charges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"period" integer NOT NULL,
	"kind" text NOT NULL,
	"wallet_entry_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reseller_bot_fee_charges_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "reseller_bot_fee_charges_period_key" UNIQUE("tenant_id","request_id","period"),
	CONSTRAINT "reseller_bot_fee_charges_entry_key" UNIQUE("tenant_id","wallet_entry_id"),
	CONSTRAINT "reseller_bot_fee_charges_kind_check" CHECK (kind IN ('APPROVAL', 'RENEWAL', 'REACTIVATION')),
	CONSTRAINT "reseller_bot_fee_charges_currency_check" CHECK (currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "reseller_bot_fee_charges_period_check" CHECK (period >= 1),
	CONSTRAINT "reseller_bot_fee_charges_amount_check" CHECK (amount_minor > 0),
	CONSTRAINT "reseller_bot_fee_charges_window_check" CHECK (period_end > period_start)
);
--> statement-breakpoint
CREATE TABLE "reseller_bot_fee_notices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"period" integer NOT NULL,
	"notice_day" date NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reseller_bot_fee_notices_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "reseller_bot_fee_notices_day_key" UNIQUE("tenant_id","request_id","period","notice_day"),
	CONSTRAINT "reseller_bot_fee_notices_period_check" CHECK (period >= 1)
);
--> statement-breakpoint
CREATE TABLE "reseller_bot_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" bigint GENERATED ALWAYS AS IDENTITY (sequence name "reseller_bot_requests_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"customer_id" uuid NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"telegram_bot_id" text NOT NULL,
	"bot_username" text NOT NULL,
	"token_ciphertext" text NOT NULL,
	"token_key_id" text NOT NULL,
	"domain" text,
	"fee_amount_minor" bigint NOT NULL,
	"fee_currency" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_admin_id" uuid,
	"reject_reason" text,
	"cancelled_at" timestamp with time zone,
	"hosted_tenant_id" uuid,
	"linked_at" timestamp with time zone,
	"paid_through" timestamp with time zone,
	"last_period" integer DEFAULT 0 NOT NULL,
	"fee_stopped_at" timestamp with time zone,
	"activation_link_id" uuid,
	"activation_link_ciphertext" text,
	"activation_link_key_id" text,
	"activation_link_sent_at" timestamp with time zone,
	CONSTRAINT "reseller_bot_requests_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "reseller_bot_requests_status_check" CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
	CONSTRAINT "reseller_bot_requests_currency_check" CHECK (fee_currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "reseller_bot_requests_fee_check" CHECK (fee_amount_minor > 0),
	CONSTRAINT "reseller_bot_requests_decided_check" CHECK ((status IN ('APPROVED', 'REJECTED')) = (decided_at IS NOT NULL)
        AND (status IN ('APPROVED', 'REJECTED')) = (decided_by_admin_id IS NOT NULL)),
	CONSTRAINT "reseller_bot_requests_reason_check" CHECK ((status = 'REJECTED') = (reject_reason IS NOT NULL)
        AND (reject_reason IS NULL OR length(reject_reason) BETWEEN 3 AND 500)),
	CONSTRAINT "reseller_bot_requests_cancelled_check" CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL)),
	CONSTRAINT "reseller_bot_requests_approved_check" CHECK ((status = 'APPROVED') = (paid_through IS NOT NULL)
        AND (status = 'APPROVED') = (last_period >= 1)
        AND (status = 'APPROVED' OR (hosted_tenant_id IS NULL AND fee_stopped_at IS NULL))
        AND (hosted_tenant_id IS NULL) = (linked_at IS NULL)),
	CONSTRAINT "reseller_bot_requests_link_check" CHECK ((activation_link_id IS NULL) = (activation_link_ciphertext IS NULL)
        AND (activation_link_ciphertext IS NULL) = (activation_link_key_id IS NULL))
);
--> statement-breakpoint
ALTER TABLE "customer_notifications" DROP CONSTRAINT "customer_notifications_kind_check";--> statement-breakpoint
ALTER TABLE "secret_reentry_items" DROP CONSTRAINT "secret_reentry_items_purpose_check";--> statement-breakpoint
ALTER TABLE "wallet_entries" DROP CONSTRAINT "wallet_entries_reason_check";--> statement-breakpoint
ALTER TABLE "reseller_bot_fee_charges" ADD CONSTRAINT "reseller_bot_fee_charges_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_bot_fee_charges" ADD CONSTRAINT "reseller_bot_fee_charges_request_fk" FOREIGN KEY ("tenant_id","request_id") REFERENCES "public"."reseller_bot_requests"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_bot_fee_charges" ADD CONSTRAINT "reseller_bot_fee_charges_entry_fk" FOREIGN KEY ("tenant_id","wallet_entry_id") REFERENCES "public"."wallet_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_bot_fee_notices" ADD CONSTRAINT "reseller_bot_fee_notices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_bot_fee_notices" ADD CONSTRAINT "reseller_bot_fee_notices_request_fk" FOREIGN KEY ("tenant_id","request_id") REFERENCES "public"."reseller_bot_requests"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_bot_requests" ADD CONSTRAINT "reseller_bot_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_bot_requests" ADD CONSTRAINT "reseller_bot_requests_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_bot_requests" ADD CONSTRAINT "reseller_bot_requests_decided_by_fk" FOREIGN KEY ("tenant_id","decided_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_bot_requests" ADD CONSTRAINT "reseller_bot_requests_hosted_fk" FOREIGN KEY ("tenant_id","hosted_tenant_id") REFERENCES "public"."hosted_bots"("tenant_id","hosted_tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reseller_bot_requests_one_pending_key" ON "reseller_bot_requests" USING btree ("tenant_id","customer_id") WHERE status = 'PENDING';--> statement-breakpoint
CREATE UNIQUE INDEX "reseller_bot_requests_live_bot_key" ON "reseller_bot_requests" USING btree ("tenant_id","telegram_bot_id") WHERE status IN ('PENDING', 'APPROVED');--> statement-breakpoint
CREATE UNIQUE INDEX "reseller_bot_requests_hosted_key" ON "reseller_bot_requests" USING btree ("tenant_id","hosted_tenant_id") WHERE hosted_tenant_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "reseller_bot_requests_customer_idx" ON "reseller_bot_requests" USING btree ("tenant_id","customer_id","created_at");--> statement-breakpoint
CREATE INDEX "reseller_bot_requests_status_idx" ON "reseller_bot_requests" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "reseller_bot_requests_renewal_idx" ON "reseller_bot_requests" USING btree ("tenant_id","paid_through") WHERE status = 'APPROVED' AND hosted_tenant_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_kind_check" CHECK (kind IN ('PAYMENT_REJECTED', 'PAYMENT_EXPIRED', 'ORDER_EXPIRED', 'SERVICE_ACTION_SUCCEEDED', 'SERVICE_ACTION_FAILED', 'SERVICE_PROVISION_DELAYED', 'PAYMENT_TRANSFER_RECORDED', 'ORDER_CANCELLED', 'WALLET_TOPUP_CREDITED', 'ORDER_REFUNDED_TO_WALLET', 'SERVICE_EXPIRY_FIRST', 'SERVICE_EXPIRY_SECOND', 'SERVICE_EXPIRED', 'SERVICE_USAGE_FIRST', 'SERVICE_USAGE_SECOND', 'SERVICE_USAGE_FINAL', 'TRIAL_NOT_DELIVERED', 'RECEIPT_CREDITED_TO_WALLET', 'WALLET_TOPUP_GIFT_CREDITED', 'GATEWAY_LATE_PAYMENT_CREDITED', 'REFUND_COMPLETED', 'GATEWAY_PAYMENT_FAILED', 'SERVICE_REFUND_REQUEST_REGISTERED', 'SERVICE_REFUND_REQUEST_APPROVED', 'SERVICE_REFUND_REQUEST_REJECTED', 'SERVICE_TRANSFER_RECEIVED', 'TICKET_REPLY', 'SERVICE_EXPIRY_EARLY', 'SERVICE_EXPIRY_DAY', 'WALLET_LOW_BALANCE', 'PAYMENT_PENDING_REMINDER', 'ORDER_PENDING_REMINDER', 'TICKET_REPLY_ATTACHMENT', 'SERVICE_RENEWED', 'RESELLER_MINIMUM_REMINDER', 'RESELLER_MINIMUM_ACHIEVED', 'WALLET_MASS_CREDITED', 'SERVICE_GIFT_APPLIED', 'DIRECT_MESSAGE', 'DIRECT_MESSAGE_MEDIA', 'INCIDENT_NOTICE', 'WALLET_ADMIN_CREDITED', 'WALLET_ADMIN_DEBITED', 'ACCOUNT_UNBLOCKED', 'SERVICE_TRAFFIC_ADDED', 'SERVICE_TIME_ADDED', 'SERVICE_AUTO_RENEW_FUNDS_SHORT', 'SERVICE_AUTO_RENEW_PRICE_CHANGED', 'RESELLER_EXPIRED', 'SERVICE_AUTO_DELETE_WARNING', 'RESELLER_REQUEST_MESSAGE', 'RESELLER_REQUEST_DECISION', 'HOSTED_BOT_ACTIVATION_LINK', 'HOSTED_BOT_FEE_SHORT', 'RESELLER_WEB_NEW_DEVICE')) NOT VALID;--> statement-breakpoint
ALTER TABLE "customer_notifications" VALIDATE CONSTRAINT "customer_notifications_kind_check";--> statement-breakpoint
ALTER TABLE "secret_reentry_items" ADD CONSTRAINT "secret_reentry_items_purpose_check" CHECK (purpose IN ('bot_instance.token', 'panel.username', 'panel.password', 'panel.api_token', 'payment_gateway.api_key', 'payment_gateway.webhook_secret', 'payment_gateway.verify_key', 'payment_gateway.refund_card', 'admin.totp_secret', 'support_ai_provider.api_key', 'legacy_migration.package_key', 'backup.archive_password', 'gift_card.batch_export', 'hosting.totp_secret', 'hosting.archive_password', 'hosting.reseller_bot_token', 'hosting.reseller_activation_link', 'reseller_web.totp_secret'));--> statement-breakpoint
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_hosted_bot_fee_shape_check" CHECK ((reason = 'HOSTED_BOT_FEE') = (left(reference, 15) = 'hosted-bot-fee:')
        AND (reason <> 'HOSTED_BOT_FEE' OR (direction = 'DEBIT' AND order_id IS NULL
          AND payment_id IS NULL AND reverses_entry_id IS NULL AND actor_admin_id IS NULL))) NOT VALID;--> statement-breakpoint
ALTER TABLE "wallet_entries" VALIDATE CONSTRAINT "wallet_entries_hosted_bot_fee_shape_check";--> statement-breakpoint
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_reason_check" CHECK (reason IN ('TOPUP_GATEWAY', 'TOPUP_RECEIPT', 'TOPUP_STARS', 'TOPUP_CRYPTO', 'RECEIPT_CREDIT', 'GATEWAY_LATE_CREDIT', 'PURCHASE', 'PURCHASE_REVERSAL', 'REFUND', 'CASHBACK_GATEWAY', 'CASHBACK_TOPUP', 'CASHBACK_RENEWAL', 'CASHBACK_PURCHASE', 'CASHBACK_REVERSAL', 'REFERRAL_COMMISSION', 'REFERRAL_COMMISSION_REVERSAL', 'REFERRAL_SIGNUP_GIFT', 'GIFT_CARD_REDEMPTION', 'START_GIFT', 'LOTTERY_WIN', 'LUCK_WHEEL_WIN', 'ADMIN_CREDIT', 'ADMIN_DEBIT', 'MASS_CREDIT', 'MASS_DEBIT', 'ACCOUNT_TRANSFER_OUT', 'ACCOUNT_TRANSFER_IN', 'RESELLER_SETTLEMENT', 'RESELLER_MEMBERSHIP_FEE', 'HOSTED_BOT_FEE', 'MIGRATION_OPENING_BALANCE', 'CHARGEBACK', 'CORRECTION', 'OTHER')) NOT VALID;--> statement-breakpoint
ALTER TABLE "wallet_entries" VALIDATE CONSTRAINT "wallet_entries_reason_check";