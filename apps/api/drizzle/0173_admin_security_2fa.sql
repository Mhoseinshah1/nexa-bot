CREATE TABLE "admin_backup_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"admin_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "admin_login_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"admin_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"credential_fingerprint" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" timestamp with time zone,
	"ip" text,
	"user_agent" text,
	CONSTRAINT "admin_login_challenges_attempts_check" CHECK (attempts >= 0)
);
--> statement-breakpoint
CREATE TABLE "admin_totp_factors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"admin_id" uuid NOT NULL,
	"state" text NOT NULL,
	"totp_secret_ciphertext" text NOT NULL,
	"totp_secret_key_id" text NOT NULL,
	"last_used_step" integer,
	"enrolled_session_id" uuid,
	"activation_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"activated_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "admin_totp_factors_state_check" CHECK (state IN ('PENDING', 'ACTIVE')),
	CONSTRAINT "admin_totp_factors_activated_check" CHECK ((state = 'ACTIVE') = (activated_at IS NOT NULL)),
	CONSTRAINT "admin_totp_factors_step_check" CHECK (last_used_step IS NULL OR last_used_step >= 0),
	CONSTRAINT "admin_totp_factors_attempts_check" CHECK (activation_attempts >= 0)
);
--> statement-breakpoint
ALTER TABLE "admin_backup_codes" ADD CONSTRAINT "admin_backup_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_backup_codes" ADD CONSTRAINT "admin_backup_codes_tenant_admin_fk" FOREIGN KEY ("tenant_id","admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_login_challenges" ADD CONSTRAINT "admin_login_challenges_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_login_challenges" ADD CONSTRAINT "admin_login_challenges_tenant_admin_fk" FOREIGN KEY ("tenant_id","admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_totp_factors" ADD CONSTRAINT "admin_totp_factors_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_totp_factors" ADD CONSTRAINT "admin_totp_factors_tenant_admin_fk" FOREIGN KEY ("tenant_id","admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_backup_codes_hash_key" ON "admin_backup_codes" USING btree ("tenant_id","admin_id","code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_login_challenges_token_key" ON "admin_login_challenges" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "admin_login_challenges_admin_idx" ON "admin_login_challenges" USING btree ("tenant_id","admin_id");--> statement-breakpoint
CREATE INDEX "admin_login_challenges_retention_idx" ON "admin_login_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_totp_factors_admin_key" ON "admin_totp_factors" USING btree ("tenant_id","admin_id");