CREATE TABLE "hosted_bots" (
	"tenant_id" uuid NOT NULL,
	"hosted_tenant_id" uuid NOT NULL,
	"state" text NOT NULL,
	"expires_at" timestamp with time zone,
	"owner_admin_id" uuid NOT NULL,
	"created_by_admin_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"state_changed_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hosted_bots_pkey" PRIMARY KEY("tenant_id","hosted_tenant_id"),
	CONSTRAINT "hosted_bots_state_check" CHECK (state IN ('ACTIVE', 'SUSPENDED', 'EXPIRED', 'DELETED', 'PURGED')),
	CONSTRAINT "hosted_bots_not_self_check" CHECK (tenant_id <> hosted_tenant_id),
	CONSTRAINT "hosted_bots_deleted_check" CHECK ((state IN ('DELETED', 'PURGED')) = (deleted_at IS NOT NULL)),
	CONSTRAINT "hosted_bots_purged_check" CHECK ((state = 'PURGED') = (purged_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "hosting_recovery_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"admin_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "hosting_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"admin_id" uuid NOT NULL,
	"admin_session_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "hosting_sessions_expiry_check" CHECK (expires_at > created_at)
);
--> statement-breakpoint
CREATE TABLE "hosting_totp_factors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"admin_id" uuid NOT NULL,
	"state" text NOT NULL,
	"totp_secret_ciphertext" text NOT NULL,
	"totp_secret_key_id" text NOT NULL,
	"last_used_step" integer,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"enrolled_session_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"activated_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hosting_totp_factors_state_check" CHECK (state IN ('PENDING', 'ACTIVE')),
	CONSTRAINT "hosting_totp_factors_activated_check" CHECK ((state = 'ACTIVE') = (activated_at IS NOT NULL)),
	CONSTRAINT "hosting_totp_factors_step_check" CHECK (last_used_step IS NULL OR last_used_step >= 0),
	CONSTRAINT "hosting_totp_factors_attempts_check" CHECK (failed_attempts >= 0)
);
--> statement-breakpoint
ALTER TABLE "tenants" DROP CONSTRAINT "tenants_kind_check";--> statement-breakpoint
ALTER TABLE "hosted_bots" ADD CONSTRAINT "hosted_bots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosted_bots" ADD CONSTRAINT "hosted_bots_hosted_tenant_id_tenants_id_fk" FOREIGN KEY ("hosted_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosted_bots" ADD CONSTRAINT "hosted_bots_owner_admin_fk" FOREIGN KEY ("hosted_tenant_id","owner_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosted_bots" ADD CONSTRAINT "hosted_bots_created_by_fk" FOREIGN KEY ("tenant_id","created_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting_recovery_codes" ADD CONSTRAINT "hosting_recovery_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting_recovery_codes" ADD CONSTRAINT "hosting_recovery_codes_tenant_admin_fk" FOREIGN KEY ("tenant_id","admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting_sessions" ADD CONSTRAINT "hosting_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting_sessions" ADD CONSTRAINT "hosting_sessions_tenant_admin_fk" FOREIGN KEY ("tenant_id","admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting_totp_factors" ADD CONSTRAINT "hosting_totp_factors_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting_totp_factors" ADD CONSTRAINT "hosting_totp_factors_tenant_admin_fk" FOREIGN KEY ("tenant_id","admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hosted_bots_hosted_tenant_key" ON "hosted_bots" USING btree ("hosted_tenant_id");--> statement-breakpoint
CREATE INDEX "hosted_bots_tenant_state_idx" ON "hosted_bots" USING btree ("tenant_id","state");--> statement-breakpoint
CREATE INDEX "hosted_bots_tenant_expiry_idx" ON "hosted_bots" USING btree ("tenant_id","expires_at") WHERE state = 'ACTIVE' AND expires_at IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "hosting_recovery_codes_hash_key" ON "hosting_recovery_codes" USING btree ("tenant_id","admin_id","code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "hosting_sessions_token_key" ON "hosting_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "hosting_sessions_tenant_admin_idx" ON "hosting_sessions" USING btree ("tenant_id","admin_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "hosting_totp_factors_admin_key" ON "hosting_totp_factors" USING btree ("tenant_id","admin_id");--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_kind_check" CHECK (kind IN ('PRIMARY', 'RESELLER_BOT', 'HOSTED'));