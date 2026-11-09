CREATE TABLE "hosted_bot_backup_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"hosted_tenant_id" uuid NOT NULL,
	"enabled" boolean NOT NULL,
	"daily_time" text NOT NULL,
	"keep" integer NOT NULL,
	"password_ciphertext" text,
	"password_key_id" text,
	"password_set_at" timestamp with time zone,
	"run_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hosted_bot_backup_policies_not_self_check" CHECK (tenant_id <> hosted_tenant_id),
	CONSTRAINT "hosted_bot_backup_policies_time_check" CHECK (daily_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
	CONSTRAINT "hosted_bot_backup_policies_keep_check" CHECK (keep BETWEEN 1 AND 60),
	CONSTRAINT "hosted_bot_backup_policies_password_check" CHECK ((password_ciphertext IS NULL) = (password_key_id IS NULL) AND (password_ciphertext IS NULL) = (password_set_at IS NULL))
);
--> statement-breakpoint
ALTER TABLE "secret_reentry_items" DROP CONSTRAINT "secret_reentry_items_purpose_check";--> statement-breakpoint
ALTER TABLE "tenant_restores" ADD COLUMN "confirm_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hosted_bot_backup_policies" ADD CONSTRAINT "hosted_bot_backup_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosted_bot_backup_policies" ADD CONSTRAINT "hosted_bot_backup_policies_hosted_tenant_id_tenants_id_fk" FOREIGN KEY ("hosted_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hosted_bot_backup_policies_hosted_key" ON "hosted_bot_backup_policies" USING btree ("tenant_id","hosted_tenant_id");--> statement-breakpoint
CREATE INDEX "hosted_bot_backup_policies_tenant_idx" ON "hosted_bot_backup_policies" USING btree ("tenant_id","updated_at");--> statement-breakpoint
ALTER TABLE "secret_reentry_items" ADD CONSTRAINT "secret_reentry_items_purpose_check" CHECK (purpose IN ('bot_instance.token', 'panel.username', 'panel.password', 'panel.api_token', 'payment_gateway.api_key', 'payment_gateway.webhook_secret', 'payment_gateway.verify_key', 'payment_gateway.refund_card', 'admin.totp_secret', 'support_ai_provider.api_key', 'legacy_migration.package_key', 'backup.archive_password', 'gift_card.batch_export', 'hosting.totp_secret', 'hosting.archive_password'));