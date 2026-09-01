CREATE TABLE "admin_login_throttle" (
	"tenant_id" uuid NOT NULL,
	"subject_kind" text NOT NULL,
	"subject" text NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"locked_until" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "admin_login_throttle_kind_check" CHECK (subject_kind IN ('USERNAME', 'IP')),
	CONSTRAINT "admin_login_throttle_count_check" CHECK (failed_count >= 0)
);
--> statement-breakpoint
CREATE TABLE "admin_permission_overrides" (
	"tenant_id" uuid NOT NULL,
	"admin_id" uuid NOT NULL,
	"permission_key" text NOT NULL,
	"effect" text NOT NULL,
	"reason" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_admin_id" uuid,
	CONSTRAINT "admin_permission_overrides_effect_check" CHECK (effect IN ('GRANT', 'DENY'))
);
--> statement-breakpoint
CREATE TABLE "admin_roles" (
	"tenant_id" uuid NOT NULL,
	"admin_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assigned_by_admin_id" uuid
);
--> statement-breakpoint
CREATE TABLE "admin_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"admin_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "admins" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"password_updated_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"telegram_user_id" text,
	"last_login_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admins_status_check" CHECK (status IN ('ACTIVE', 'DISABLED')),
	CONSTRAINT "admins_username_lowercase_check" CHECK (username = lower(username)),
	CONSTRAINT "admins_username_shape_check" CHECK (username ~ '^[a-z0-9._-]{3,64}$'),
	CONSTRAINT "admins_telegram_shape_check" CHECK (telegram_user_id IS NULL OR telegram_user_id ~ '^[0-9]{1,20}$'),
	CONSTRAINT "admins_disabled_at_check" CHECK ((status = 'DISABLED' AND disabled_at IS NOT NULL) OR (status <> 'DISABLED' AND disabled_at IS NULL))
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"tenant_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"permission_key" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_key_shape_check" CHECK (key ~ '^[a-z][a-z0-9_]{1,63}$')
);
--> statement-breakpoint
ALTER TABLE "admin_login_throttle" ADD CONSTRAINT "admin_login_throttle_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_permission_overrides" ADD CONSTRAINT "admin_permission_overrides_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_permission_overrides" ADD CONSTRAINT "admin_permission_overrides_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_roles" ADD CONSTRAINT "admin_roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_roles" ADD CONSTRAINT "admin_roles_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_roles" ADD CONSTRAINT "admin_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admins" ADD CONSTRAINT "admins_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_login_throttle_pkey" ON "admin_login_throttle" USING btree ("tenant_id","subject_kind","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_permission_overrides_pkey" ON "admin_permission_overrides" USING btree ("tenant_id","admin_id","permission_key","effect");--> statement-breakpoint
CREATE INDEX "admin_permission_overrides_admin_idx" ON "admin_permission_overrides" USING btree ("admin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_roles_pkey" ON "admin_roles" USING btree ("tenant_id","admin_id","role_id");--> statement-breakpoint
CREATE INDEX "admin_roles_admin_idx" ON "admin_roles" USING btree ("admin_id");--> statement-breakpoint
CREATE INDEX "admin_roles_role_idx" ON "admin_roles" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_sessions_token_key" ON "admin_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "admin_sessions_admin_idx" ON "admin_sessions" USING btree ("tenant_id","admin_id");--> statement-breakpoint
CREATE INDEX "admin_sessions_expiry_idx" ON "admin_sessions" USING btree ("expires_at") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "admins_tenant_username_key" ON "admins" USING btree ("tenant_id","username");--> statement-breakpoint
CREATE UNIQUE INDEX "admins_tenant_telegram_key" ON "admins" USING btree ("tenant_id","telegram_user_id") WHERE telegram_user_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "admins_tenant_status_idx" ON "admins" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "role_permissions_pkey" ON "role_permissions" USING btree ("tenant_id","role_id","permission_key");--> statement-breakpoint
CREATE INDEX "role_permissions_role_idx" ON "role_permissions" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_tenant_key_key" ON "roles" USING btree ("tenant_id","key");