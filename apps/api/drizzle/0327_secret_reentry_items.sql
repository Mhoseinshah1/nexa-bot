CREATE TABLE "secret_reentry_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"entity_table" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"entity_key" text,
	"recovery_request_id" uuid NOT NULL,
	"cleared_at" timestamp with time zone NOT NULL,
	CONSTRAINT "secret_reentry_items_purpose_check" CHECK (purpose IN ('bot_instance.token', 'panel.username', 'panel.password', 'panel.api_token', 'payment_gateway.api_key', 'payment_gateway.webhook_secret', 'payment_gateway.verify_key', 'payment_gateway.refund_card', 'admin.totp_secret', 'support_ai_provider.api_key', 'legacy_migration.package_key', 'backup.archive_password', 'gift_card.batch_export', 'hosting.totp_secret')),
	CONSTRAINT "secret_reentry_items_entity_table_check" CHECK (entity_table ~ '^[a-z_]{1,63}$'),
	CONSTRAINT "secret_reentry_items_entity_key_check" CHECK (entity_key IS NULL OR char_length(entity_key) BETWEEN 1 AND 64)
);
--> statement-breakpoint
ALTER TABLE "secret_reentry_items" ADD CONSTRAINT "secret_reentry_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "secret_reentry_items_tenant_cleared_idx" ON "secret_reentry_items" USING btree ("tenant_id","cleared_at","id");