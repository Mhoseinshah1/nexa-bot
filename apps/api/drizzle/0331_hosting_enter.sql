CREATE TABLE "hosting_enter_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"hosted_tenant_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"owner_admin_id" uuid NOT NULL,
	"hosting_session_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"admin_session_id" uuid,
	CONSTRAINT "hosting_enter_tokens_expiry_check" CHECK (expires_at > created_at),
	CONSTRAINT "hosting_enter_tokens_used_check" CHECK ((used_at IS NULL) = (admin_session_id IS NULL)),
	CONSTRAINT "hosting_enter_tokens_domain_shape_check" CHECK (domain = lower(domain) AND char_length(domain) BETWEEN 4 AND 253)
);
--> statement-breakpoint
ALTER TABLE "admins" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "acted_in_tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD COLUMN "impersonated_by_admin_id" uuid;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD COLUMN "impersonation_hosting_session_id" uuid;--> statement-breakpoint
ALTER TABLE "admins" ADD COLUMN "kind" text DEFAULT 'OPERATOR' NOT NULL;--> statement-breakpoint
ALTER TABLE "hosting_enter_tokens" ADD CONSTRAINT "hosting_enter_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting_enter_tokens" ADD CONSTRAINT "hosting_enter_tokens_hosted_tenant_id_tenants_id_fk" FOREIGN KEY ("hosted_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting_enter_tokens" ADD CONSTRAINT "hosting_enter_tokens_hosting_session_id_hosting_sessions_id_fk" FOREIGN KEY ("hosting_session_id") REFERENCES "public"."hosting_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting_enter_tokens" ADD CONSTRAINT "hosting_enter_tokens_hosted_fk" FOREIGN KEY ("tenant_id","hosted_tenant_id") REFERENCES "public"."hosted_bots"("tenant_id","hosted_tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting_enter_tokens" ADD CONSTRAINT "hosting_enter_tokens_owner_fk" FOREIGN KEY ("tenant_id","owner_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hosting_enter_tokens_token_key" ON "hosting_enter_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "hosting_enter_tokens_hosted_idx" ON "hosting_enter_tokens" USING btree ("tenant_id","hosted_tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "admin_sessions_impersonation_idx" ON "admin_sessions" USING btree ("impersonation_hosting_session_id") WHERE impersonation_hosting_session_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "admins_tenant_host_key" ON "admins" USING btree ("tenant_id") WHERE kind = 'HOST';--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_impersonation_check" CHECK ((impersonated_by_admin_id IS NULL) = (impersonation_hosting_session_id IS NULL));--> statement-breakpoint
ALTER TABLE "admins" ADD CONSTRAINT "admins_kind_check" CHECK (kind IN ('OPERATOR', 'HOST'));--> statement-breakpoint
ALTER TABLE "admins" ADD CONSTRAINT "admins_kind_password_check" CHECK ((kind = 'HOST') = (password_hash IS NULL));