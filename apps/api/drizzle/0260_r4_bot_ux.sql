CREATE TABLE "payment_destination_switches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"from_account_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"label" text NOT NULL,
	"bank_name" text NOT NULL,
	"holder_name" text NOT NULL,
	"card_number" text NOT NULL,
	"iban" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payment_destination_switches_sequence_key" UNIQUE("tenant_id","payment_id","sequence"),
	CONSTRAINT "payment_destination_switches_sequence_check" CHECK (sequence >= 1),
	CONSTRAINT "payment_destination_switches_card_number_check" CHECK (card_number ~ '^[0-9]{16}$'),
	CONSTRAINT "payment_destination_switches_iban_check" CHECK (iban IS NULL OR iban ~ '^IR[0-9]{24}$')
);
--> statement-breakpoint
ALTER TABLE "customer_notifications" DROP CONSTRAINT "customer_notifications_kind_check";--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "legacy_terms_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "missing_on_panel_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wallet_entries" ADD COLUMN "note_shown_to_customer" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_destination_switches" ADD CONSTRAINT "payment_destination_switches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_destination_switches" ADD CONSTRAINT "payment_destination_switches_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_destination_switches" ADD CONSTRAINT "payment_destination_switches_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."payment_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_destination_switches" ADD CONSTRAINT "payment_destination_switches_from_account_fk" FOREIGN KEY ("tenant_id","from_account_id") REFERENCES "public"."payment_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_kind_check" CHECK (kind IN ('PAYMENT_REJECTED', 'PAYMENT_EXPIRED', 'ORDER_EXPIRED', 'SERVICE_ACTION_SUCCEEDED', 'SERVICE_ACTION_FAILED', 'SERVICE_PROVISION_DELAYED', 'PAYMENT_TRANSFER_RECORDED', 'ORDER_CANCELLED', 'WALLET_TOPUP_CREDITED', 'ORDER_REFUNDED_TO_WALLET', 'SERVICE_EXPIRY_FIRST', 'SERVICE_EXPIRY_SECOND', 'SERVICE_EXPIRED', 'SERVICE_USAGE_FIRST', 'SERVICE_USAGE_SECOND', 'SERVICE_USAGE_FINAL', 'TRIAL_NOT_DELIVERED', 'RECEIPT_CREDITED_TO_WALLET', 'WALLET_TOPUP_GIFT_CREDITED', 'REFUND_COMPLETED', 'GATEWAY_PAYMENT_FAILED', 'SERVICE_REFUND_REQUEST_REGISTERED', 'SERVICE_REFUND_REQUEST_APPROVED', 'SERVICE_REFUND_REQUEST_REJECTED', 'SERVICE_TRANSFER_RECEIVED', 'TICKET_REPLY', 'SERVICE_EXPIRY_EARLY', 'SERVICE_EXPIRY_DAY', 'WALLET_LOW_BALANCE', 'PAYMENT_PENDING_REMINDER', 'ORDER_PENDING_REMINDER', 'TICKET_REPLY_ATTACHMENT', 'SERVICE_RENEWED', 'RESELLER_MINIMUM_REMINDER', 'RESELLER_MINIMUM_ACHIEVED', 'WALLET_MASS_CREDITED', 'SERVICE_GIFT_APPLIED', 'DIRECT_MESSAGE', 'DIRECT_MESSAGE_MEDIA', 'INCIDENT_NOTICE', 'WALLET_ADMIN_CREDITED', 'WALLET_ADMIN_DEBITED', 'ACCOUNT_UNBLOCKED'));