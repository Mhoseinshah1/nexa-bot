-- NEXA-OWNER-BATCH-1 PR-3: automatic deletion of finished services. Two nullable columns on
-- services (state_since, expiry_cause) with NO backfill — a row that predates them is given its
-- clock by the worker when it first sees it, never a guessed earlier moment — and one new table.
-- No customer is sent anything by this migration. services and customer_notifications are large
-- tables (scripts/large-tables.txt), so their CHECKs are added NOT VALID, then VALIDATEd. Only hand
-- edit: those two NOT VALID / VALIDATE pairs.
CREATE TABLE "service_auto_delete_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"panel_id" uuid NOT NULL,
	"cycle_state" text NOT NULL,
	"cycle_since" timestamp with time zone NOT NULL,
	"cause" text NOT NULL,
	"days" integer NOT NULL,
	"service_label" text NOT NULL,
	"delete_after" timestamp with time zone NOT NULL,
	"warned_at" timestamp with time zone,
	"state" text NOT NULL,
	"operation_id" uuid,
	"planned_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "service_auto_delete_runs_state_check" CHECK (state IN ('SCHEDULED', 'PLANNED', 'CANCELLED')),
	CONSTRAINT "service_auto_delete_runs_cause_check" CHECK (cause IN ('TRAFFIC', 'TIME', 'SUSPENDED')),
	CONSTRAINT "service_auto_delete_runs_cycle_state_check" CHECK (cycle_state IN ('EXPIRED', 'SUSPENDED')),
	CONSTRAINT "service_auto_delete_runs_planned_check" CHECK ((state = 'PLANNED') = (operation_id IS NOT NULL AND planned_at IS NOT NULL)),
	CONSTRAINT "service_auto_delete_runs_days_check" CHECK (days >= 1)
);
--> statement-breakpoint
ALTER TABLE "customer_notifications" DROP CONSTRAINT "customer_notifications_kind_check";--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "state_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "expiry_cause" text;--> statement-breakpoint
ALTER TABLE "service_auto_delete_runs" ADD CONSTRAINT "service_auto_delete_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_auto_delete_runs" ADD CONSTRAINT "service_auto_delete_runs_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_auto_delete_runs" ADD CONSTRAINT "service_auto_delete_runs_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_auto_delete_runs" ADD CONSTRAINT "service_auto_delete_runs_panel_fk" FOREIGN KEY ("tenant_id","panel_id") REFERENCES "public"."panels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "service_auto_delete_runs_cycle_key" ON "service_auto_delete_runs" USING btree ("tenant_id","service_id","cycle_since") WHERE state <> 'CANCELLED';--> statement-breakpoint
CREATE INDEX "service_auto_delete_runs_due_idx" ON "service_auto_delete_runs" USING btree ("tenant_id","delete_after") WHERE state = 'SCHEDULED';--> statement-breakpoint
CREATE INDEX "service_auto_delete_runs_panel_planned_idx" ON "service_auto_delete_runs" USING btree ("tenant_id","panel_id","planned_at") WHERE state = 'PLANNED';--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_kind_check" CHECK (kind IN ('PAYMENT_REJECTED', 'PAYMENT_EXPIRED', 'ORDER_EXPIRED', 'SERVICE_ACTION_SUCCEEDED', 'SERVICE_ACTION_FAILED', 'SERVICE_PROVISION_DELAYED', 'PAYMENT_TRANSFER_RECORDED', 'ORDER_CANCELLED', 'WALLET_TOPUP_CREDITED', 'ORDER_REFUNDED_TO_WALLET', 'SERVICE_EXPIRY_FIRST', 'SERVICE_EXPIRY_SECOND', 'SERVICE_EXPIRED', 'SERVICE_USAGE_FIRST', 'SERVICE_USAGE_SECOND', 'SERVICE_USAGE_FINAL', 'TRIAL_NOT_DELIVERED', 'RECEIPT_CREDITED_TO_WALLET', 'WALLET_TOPUP_GIFT_CREDITED', 'GATEWAY_LATE_PAYMENT_CREDITED', 'REFUND_COMPLETED', 'GATEWAY_PAYMENT_FAILED', 'SERVICE_REFUND_REQUEST_REGISTERED', 'SERVICE_REFUND_REQUEST_APPROVED', 'SERVICE_REFUND_REQUEST_REJECTED', 'SERVICE_TRANSFER_RECEIVED', 'TICKET_REPLY', 'SERVICE_EXPIRY_EARLY', 'SERVICE_EXPIRY_DAY', 'WALLET_LOW_BALANCE', 'PAYMENT_PENDING_REMINDER', 'ORDER_PENDING_REMINDER', 'TICKET_REPLY_ATTACHMENT', 'SERVICE_RENEWED', 'RESELLER_MINIMUM_REMINDER', 'RESELLER_MINIMUM_ACHIEVED', 'WALLET_MASS_CREDITED', 'SERVICE_GIFT_APPLIED', 'DIRECT_MESSAGE', 'DIRECT_MESSAGE_MEDIA', 'INCIDENT_NOTICE', 'WALLET_ADMIN_CREDITED', 'WALLET_ADMIN_DEBITED', 'ACCOUNT_UNBLOCKED', 'SERVICE_TRAFFIC_ADDED', 'SERVICE_TIME_ADDED', 'SERVICE_AUTO_RENEW_FUNDS_SHORT', 'SERVICE_AUTO_RENEW_PRICE_CHANGED', 'RESELLER_EXPIRED', 'SERVICE_AUTO_DELETE_WARNING')) NOT VALID;--> statement-breakpoint
ALTER TABLE "customer_notifications" VALIDATE CONSTRAINT "customer_notifications_kind_check";--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_expiry_cause_check" CHECK (expiry_cause IS NULL OR expiry_cause IN ('TRAFFIC', 'TIME')) NOT VALID;--> statement-breakpoint
ALTER TABLE "services" VALIDATE CONSTRAINT "services_expiry_cause_check";