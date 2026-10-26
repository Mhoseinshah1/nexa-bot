CREATE TABLE "service_auto_renew_preferences" (
	"tenant_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"enabled" boolean NOT NULL,
	"consented_total_minor" bigint,
	"consented_currency" text,
	"source" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "service_auto_renew_preferences_pkey" PRIMARY KEY("tenant_id","service_id"),
	CONSTRAINT "service_auto_renew_preferences_source_check" CHECK (source IN ('TELEGRAM', 'MINI_APP', 'TRANSFER')),
	CONSTRAINT "service_auto_renew_preferences_currency_check" CHECK (consented_currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "service_auto_renew_preferences_consent_check" CHECK ((enabled AND consented_total_minor IS NOT NULL AND consented_currency IS NOT NULL
            AND consented_total_minor >= 0)
          OR (NOT enabled AND consented_total_minor IS NULL AND consented_currency IS NULL))
);
--> statement-breakpoint
CREATE TABLE "service_auto_renew_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"basis_expires_at" timestamp with time zone NOT NULL,
	"attempt" integer NOT NULL,
	"state" text NOT NULL,
	"refusal" text,
	"service_label" text NOT NULL,
	"consented_total_minor" bigint NOT NULL,
	"consented_currency" text NOT NULL,
	"quoted_total_minor" bigint,
	"quoted_currency" text,
	"order_id" uuid,
	"notified_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "service_auto_renew_runs_period_key" UNIQUE("tenant_id","service_id","basis_expires_at"),
	CONSTRAINT "service_auto_renew_runs_state_check" CHECK (state IN ('CLAIMED', 'RENEWED', 'FUNDS_SHORT', 'REFUSED')),
	CONSTRAINT "service_auto_renew_runs_refusal_check" CHECK (refusal IN ('PRICE_ROSE', 'CONSENT_WITHDRAWN', 'NOT_RENEWABLE')),
	CONSTRAINT "service_auto_renew_runs_refusal_state_check" CHECK ((state = 'REFUSED') = (refusal IS NOT NULL)),
	CONSTRAINT "service_auto_renew_runs_renewed_check" CHECK ((state = 'RENEWED') = (order_id IS NOT NULL)),
	CONSTRAINT "service_auto_renew_runs_attempt_check" CHECK (attempt >= 1),
	CONSTRAINT "service_auto_renew_runs_consented_currency_check" CHECK (consented_currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "service_auto_renew_runs_quoted_currency_check" CHECK (quoted_currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "service_auto_renew_runs_quote_check" CHECK ((quoted_total_minor IS NULL) = (quoted_currency IS NULL)
          AND consented_total_minor >= 0
          AND (quoted_total_minor IS NULL OR quoted_total_minor >= 0))
);
--> statement-breakpoint
ALTER TABLE "customer_notifications" DROP CONSTRAINT "customer_notifications_kind_check";--> statement-breakpoint
ALTER TABLE "service_auto_renew_preferences" ADD CONSTRAINT "service_auto_renew_preferences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_auto_renew_preferences" ADD CONSTRAINT "service_auto_renew_preferences_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_auto_renew_preferences" ADD CONSTRAINT "service_auto_renew_preferences_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_auto_renew_runs" ADD CONSTRAINT "service_auto_renew_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_auto_renew_runs" ADD CONSTRAINT "service_auto_renew_runs_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_auto_renew_runs" ADD CONSTRAINT "service_auto_renew_runs_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_auto_renew_runs" ADD CONSTRAINT "service_auto_renew_runs_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_auto_renew_preferences_enabled_idx" ON "service_auto_renew_preferences" USING btree ("tenant_id","service_id") WHERE enabled;--> statement-breakpoint
CREATE UNIQUE INDEX "service_auto_renew_runs_order_key" ON "service_auto_renew_runs" USING btree ("tenant_id","order_id") WHERE order_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "service_auto_renew_runs_state_idx" ON "service_auto_renew_runs" USING btree ("tenant_id","state","lease_until");--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_kind_check" CHECK (kind IN ('PAYMENT_REJECTED', 'PAYMENT_EXPIRED', 'ORDER_EXPIRED', 'SERVICE_ACTION_SUCCEEDED', 'SERVICE_ACTION_FAILED', 'SERVICE_PROVISION_DELAYED', 'PAYMENT_TRANSFER_RECORDED', 'ORDER_CANCELLED', 'WALLET_TOPUP_CREDITED', 'ORDER_REFUNDED_TO_WALLET', 'SERVICE_EXPIRY_FIRST', 'SERVICE_EXPIRY_SECOND', 'SERVICE_EXPIRED', 'SERVICE_USAGE_FIRST', 'SERVICE_USAGE_SECOND', 'SERVICE_USAGE_FINAL', 'TRIAL_NOT_DELIVERED', 'RECEIPT_CREDITED_TO_WALLET', 'WALLET_TOPUP_GIFT_CREDITED', 'GATEWAY_LATE_PAYMENT_CREDITED', 'REFUND_COMPLETED', 'GATEWAY_PAYMENT_FAILED', 'SERVICE_REFUND_REQUEST_REGISTERED', 'SERVICE_REFUND_REQUEST_APPROVED', 'SERVICE_REFUND_REQUEST_REJECTED', 'SERVICE_TRANSFER_RECEIVED', 'TICKET_REPLY', 'SERVICE_EXPIRY_EARLY', 'SERVICE_EXPIRY_DAY', 'WALLET_LOW_BALANCE', 'PAYMENT_PENDING_REMINDER', 'ORDER_PENDING_REMINDER', 'TICKET_REPLY_ATTACHMENT', 'SERVICE_RENEWED', 'RESELLER_MINIMUM_REMINDER', 'RESELLER_MINIMUM_ACHIEVED', 'WALLET_MASS_CREDITED', 'SERVICE_GIFT_APPLIED', 'DIRECT_MESSAGE', 'DIRECT_MESSAGE_MEDIA', 'INCIDENT_NOTICE', 'WALLET_ADMIN_CREDITED', 'WALLET_ADMIN_DEBITED', 'ACCOUNT_UNBLOCKED', 'SERVICE_TRAFFIC_ADDED', 'SERVICE_TIME_ADDED', 'SERVICE_AUTO_RENEW_FUNDS_SHORT', 'SERVICE_AUTO_RENEW_PRICE_CHANGED'));