CREATE TABLE "reseller_entitlement_overrides" (
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"dimension" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reseller_entitlement_overrides_pkey" PRIMARY KEY("tenant_id","customer_id","dimension"),
	CONSTRAINT "reseller_entitlement_overrides_dimension_check" CHECK (dimension IN ('OPERATION', 'CATALOGUE', 'PANEL', 'BOT'))
);
--> statement-breakpoint
CREATE TABLE "reseller_grant_overrides" (
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"dimension" text NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reseller_grant_overrides_pkey" PRIMARY KEY("tenant_id","customer_id","kind","subject"),
	CONSTRAINT "reseller_grant_overrides_kind_check" CHECK (kind IN ('PRODUCT', 'CATEGORY', 'PANEL', 'BOT', 'OPERATION')),
	CONSTRAINT "reseller_grant_overrides_dimension_check" CHECK ((kind = 'OPERATION' AND dimension = 'OPERATION')
          OR (kind IN ('PRODUCT', 'CATEGORY') AND dimension = 'CATALOGUE')
          OR (kind = 'PANEL' AND dimension = 'PANEL')
          OR (kind = 'BOT' AND dimension = 'BOT')),
	CONSTRAINT "reseller_grant_overrides_subject_check" CHECK (subject = '*' OR (kind = 'OPERATION' AND subject IN ('NEW_SERVICE', 'RENEW', 'ADD_TRAFFIC', 'ADD_TIME', 'ADD_DEVICES', 'CHANGE_LOCATION')) OR (kind <> 'OPERATION' AND subject ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
);
--> statement-breakpoint
CREATE TABLE "reseller_minimum_notices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"minimum_amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"achieved_amount" bigint NOT NULL,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reseller_minimum_notices_period_key" UNIQUE("tenant_id","customer_id","kind","period_start"),
	CONSTRAINT "reseller_minimum_notices_kind_check" CHECK (kind IN ('REMINDER', 'ACHIEVED')),
	CONSTRAINT "reseller_minimum_notices_currency_check" CHECK (currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "reseller_minimum_notices_period_check" CHECK (period_end > period_start),
	CONSTRAINT "reseller_minimum_notices_amounts_check" CHECK (minimum_amount > 0 AND achieved_amount >= 0)
);
--> statement-breakpoint
ALTER TABLE "customer_notifications" DROP CONSTRAINT "customer_notifications_kind_check";--> statement-breakpoint
ALTER TABLE "reseller_tiers" ADD COLUMN "monthly_minimum_amount" bigint;--> statement-breakpoint
ALTER TABLE "reseller_tiers" ADD COLUMN "monthly_minimum_currency" text;--> statement-breakpoint
ALTER TABLE "resellers" ADD COLUMN "monthly_minimum_amount" bigint;--> statement-breakpoint
ALTER TABLE "resellers" ADD COLUMN "monthly_minimum_currency" text;--> statement-breakpoint
ALTER TABLE "reseller_entitlement_overrides" ADD CONSTRAINT "reseller_entitlement_overrides_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_entitlement_overrides" ADD CONSTRAINT "reseller_entitlement_overrides_reseller_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."resellers"("tenant_id","customer_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_grant_overrides" ADD CONSTRAINT "reseller_grant_overrides_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_grant_overrides" ADD CONSTRAINT "reseller_grant_overrides_dimension_fk" FOREIGN KEY ("tenant_id","customer_id","dimension") REFERENCES "public"."reseller_entitlement_overrides"("tenant_id","customer_id","dimension") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_minimum_notices" ADD CONSTRAINT "reseller_minimum_notices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_minimum_notices" ADD CONSTRAINT "reseller_minimum_notices_reseller_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."resellers"("tenant_id","customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_kind_check" CHECK (kind IN ('PAYMENT_REJECTED', 'PAYMENT_EXPIRED', 'ORDER_EXPIRED', 'SERVICE_ACTION_SUCCEEDED', 'SERVICE_ACTION_FAILED', 'SERVICE_PROVISION_DELAYED', 'PAYMENT_TRANSFER_RECORDED', 'ORDER_CANCELLED', 'WALLET_TOPUP_CREDITED', 'ORDER_REFUNDED_TO_WALLET', 'SERVICE_EXPIRY_FIRST', 'SERVICE_EXPIRY_SECOND', 'SERVICE_EXPIRED', 'SERVICE_USAGE_FIRST', 'SERVICE_USAGE_SECOND', 'SERVICE_USAGE_FINAL', 'TRIAL_NOT_DELIVERED', 'RECEIPT_CREDITED_TO_WALLET', 'WALLET_TOPUP_GIFT_CREDITED', 'REFUND_COMPLETED', 'GATEWAY_PAYMENT_FAILED', 'SERVICE_REFUND_REQUEST_REGISTERED', 'SERVICE_REFUND_REQUEST_APPROVED', 'SERVICE_REFUND_REQUEST_REJECTED', 'SERVICE_TRANSFER_RECEIVED', 'TICKET_REPLY', 'SERVICE_EXPIRY_EARLY', 'SERVICE_EXPIRY_DAY', 'WALLET_LOW_BALANCE', 'PAYMENT_PENDING_REMINDER', 'ORDER_PENDING_REMINDER', 'TICKET_REPLY_ATTACHMENT', 'SERVICE_RENEWED', 'RESELLER_MINIMUM_REMINDER', 'RESELLER_MINIMUM_ACHIEVED'));--> statement-breakpoint
ALTER TABLE "reseller_tiers" ADD CONSTRAINT "reseller_tiers_minimum_pair_check" CHECK ((monthly_minimum_amount IS NULL) = (monthly_minimum_currency IS NULL));--> statement-breakpoint
ALTER TABLE "reseller_tiers" ADD CONSTRAINT "reseller_tiers_minimum_check" CHECK (monthly_minimum_amount IS NULL OR monthly_minimum_amount >= 0);--> statement-breakpoint
ALTER TABLE "reseller_tiers" ADD CONSTRAINT "reseller_tiers_minimum_currency_check" CHECK (monthly_minimum_currency IS NULL OR monthly_minimum_currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT'));--> statement-breakpoint
ALTER TABLE "resellers" ADD CONSTRAINT "resellers_minimum_pair_check" CHECK ((monthly_minimum_amount IS NULL) = (monthly_minimum_currency IS NULL));--> statement-breakpoint
ALTER TABLE "resellers" ADD CONSTRAINT "resellers_minimum_check" CHECK (monthly_minimum_amount IS NULL OR monthly_minimum_amount >= 0);--> statement-breakpoint
ALTER TABLE "resellers" ADD CONSTRAINT "resellers_minimum_currency_check" CHECK (monthly_minimum_currency IS NULL OR monthly_minimum_currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT'));