CREATE TABLE "reseller_web_devices" (
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reseller_web_devices_pkey" PRIMARY KEY("tenant_id","customer_id","fingerprint")
);
--> statement-breakpoint
CREATE TABLE "reseller_web_file_fetches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reseller_web_login_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"session_id" uuid,
	CONSTRAINT "reseller_web_login_tokens_expiry_check" CHECK (expires_at > created_at),
	CONSTRAINT "reseller_web_login_tokens_used_check" CHECK ((used_at IS NULL) = (session_id IS NULL))
);
--> statement-breakpoint
CREATE TABLE "reseller_web_preferences" (
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"new_device_alert" boolean NOT NULL,
	"expiring_digest" boolean NOT NULL,
	"daily_sales_report" boolean NOT NULL,
	"ticket_reply" boolean NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reseller_web_preferences_pkey" PRIMARY KEY("tenant_id","customer_id")
);
--> statement-breakpoint
CREATE TABLE "reseller_web_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"device_fingerprint" text NOT NULL,
	"device_label" text NOT NULL,
	"network" text,
	"second_factor_attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "reseller_web_sessions_state_check" CHECK (state IN ('PENDING_SECOND_FACTOR', 'ACTIVE')),
	CONSTRAINT "reseller_web_sessions_end_check" CHECK ((ended_at IS NULL) = (end_reason IS NULL) AND (end_reason IS NULL OR end_reason IN ('LOGOUT', 'REVOKED', 'REVOKED_ALL', 'ADMIN_FORCE_LOGOUT', 'SECOND_FACTOR_FAILED', 'SECOND_FACTOR_ENABLED'))),
	CONSTRAINT "reseller_web_sessions_expiry_check" CHECK (absolute_expires_at > created_at),
	CONSTRAINT "reseller_web_sessions_label_check" CHECK (char_length(device_label) BETWEEN 1 AND 80 AND (network IS NULL OR char_length(network) <= 64))
);
--> statement-breakpoint
CREATE TABLE "reseller_web_totp_factors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"state" text NOT NULL,
	"totp_secret_ciphertext" text NOT NULL,
	"totp_secret_key_id" text NOT NULL,
	"last_used_step" integer,
	"activation_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"activated_at" timestamp with time zone,
	CONSTRAINT "reseller_web_totp_factors_state_check" CHECK (state IN ('PENDING', 'ACTIVE')),
	CONSTRAINT "reseller_web_totp_factors_active_check" CHECK ((state = 'ACTIVE') = (activated_at IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "customer_notifications" DROP CONSTRAINT "customer_notifications_kind_check";--> statement-breakpoint
ALTER TABLE "secret_reentry_items" DROP CONSTRAINT "secret_reentry_items_purpose_check";--> statement-breakpoint
ALTER TABLE "reseller_web_devices" ADD CONSTRAINT "reseller_web_devices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_web_devices" ADD CONSTRAINT "reseller_web_devices_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_web_file_fetches" ADD CONSTRAINT "reseller_web_file_fetches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_web_file_fetches" ADD CONSTRAINT "reseller_web_file_fetches_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_web_login_tokens" ADD CONSTRAINT "reseller_web_login_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_web_login_tokens" ADD CONSTRAINT "reseller_web_login_tokens_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_web_login_tokens" ADD CONSTRAINT "reseller_web_login_tokens_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_web_preferences" ADD CONSTRAINT "reseller_web_preferences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_web_preferences" ADD CONSTRAINT "reseller_web_preferences_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_web_sessions" ADD CONSTRAINT "reseller_web_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_web_sessions" ADD CONSTRAINT "reseller_web_sessions_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_web_sessions" ADD CONSTRAINT "reseller_web_sessions_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_web_totp_factors" ADD CONSTRAINT "reseller_web_totp_factors_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_web_totp_factors" ADD CONSTRAINT "reseller_web_totp_factors_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reseller_web_file_fetches_window_idx" ON "reseller_web_file_fetches" USING btree ("tenant_id","customer_id","service_id","fetched_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reseller_web_login_tokens_token_key" ON "reseller_web_login_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "reseller_web_login_tokens_customer_idx" ON "reseller_web_login_tokens" USING btree ("tenant_id","customer_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reseller_web_sessions_token_key" ON "reseller_web_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "reseller_web_sessions_customer_idx" ON "reseller_web_sessions" USING btree ("tenant_id","customer_id","last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reseller_web_totp_factors_customer_key" ON "reseller_web_totp_factors" USING btree ("tenant_id","customer_id");--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_kind_check" CHECK (kind IN ('PAYMENT_REJECTED', 'PAYMENT_EXPIRED', 'ORDER_EXPIRED', 'SERVICE_ACTION_SUCCEEDED', 'SERVICE_ACTION_FAILED', 'SERVICE_PROVISION_DELAYED', 'PAYMENT_TRANSFER_RECORDED', 'ORDER_CANCELLED', 'WALLET_TOPUP_CREDITED', 'ORDER_REFUNDED_TO_WALLET', 'SERVICE_EXPIRY_FIRST', 'SERVICE_EXPIRY_SECOND', 'SERVICE_EXPIRED', 'SERVICE_USAGE_FIRST', 'SERVICE_USAGE_SECOND', 'SERVICE_USAGE_FINAL', 'TRIAL_NOT_DELIVERED', 'RECEIPT_CREDITED_TO_WALLET', 'WALLET_TOPUP_GIFT_CREDITED', 'GATEWAY_LATE_PAYMENT_CREDITED', 'REFUND_COMPLETED', 'GATEWAY_PAYMENT_FAILED', 'SERVICE_REFUND_REQUEST_REGISTERED', 'SERVICE_REFUND_REQUEST_APPROVED', 'SERVICE_REFUND_REQUEST_REJECTED', 'SERVICE_TRANSFER_RECEIVED', 'TICKET_REPLY', 'SERVICE_EXPIRY_EARLY', 'SERVICE_EXPIRY_DAY', 'WALLET_LOW_BALANCE', 'PAYMENT_PENDING_REMINDER', 'ORDER_PENDING_REMINDER', 'TICKET_REPLY_ATTACHMENT', 'SERVICE_RENEWED', 'RESELLER_MINIMUM_REMINDER', 'RESELLER_MINIMUM_ACHIEVED', 'WALLET_MASS_CREDITED', 'SERVICE_GIFT_APPLIED', 'DIRECT_MESSAGE', 'DIRECT_MESSAGE_MEDIA', 'INCIDENT_NOTICE', 'WALLET_ADMIN_CREDITED', 'WALLET_ADMIN_DEBITED', 'ACCOUNT_UNBLOCKED', 'SERVICE_TRAFFIC_ADDED', 'SERVICE_TIME_ADDED', 'SERVICE_AUTO_RENEW_FUNDS_SHORT', 'SERVICE_AUTO_RENEW_PRICE_CHANGED', 'RESELLER_EXPIRED', 'SERVICE_AUTO_DELETE_WARNING', 'RESELLER_REQUEST_MESSAGE', 'RESELLER_REQUEST_DECISION', 'RESELLER_WEB_NEW_DEVICE')) NOT VALID;--> statement-breakpoint
ALTER TABLE "customer_notifications" VALIDATE CONSTRAINT "customer_notifications_kind_check";--> statement-breakpoint
ALTER TABLE "secret_reentry_items" ADD CONSTRAINT "secret_reentry_items_purpose_check" CHECK (purpose IN ('bot_instance.token', 'panel.username', 'panel.password', 'panel.api_token', 'payment_gateway.api_key', 'payment_gateway.webhook_secret', 'payment_gateway.verify_key', 'payment_gateway.refund_card', 'admin.totp_secret', 'support_ai_provider.api_key', 'legacy_migration.package_key', 'backup.archive_password', 'gift_card.batch_export', 'hosting.totp_secret', 'hosting.archive_password', 'reseller_web.totp_secret'));