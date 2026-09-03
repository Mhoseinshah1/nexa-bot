CREATE TABLE "panel_credentials" (
	"panel_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"username_ciphertext" text,
	"username_key_id" text,
	"username_set_at" timestamp with time zone,
	"password_ciphertext" text,
	"password_key_id" text,
	"password_set_at" timestamp with time zone,
	"api_token_ciphertext" text,
	"api_token_key_id" text,
	"api_token_set_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "panel_credentials_username_check" CHECK ((username_ciphertext IS NULL) = (username_key_id IS NULL)
          AND (username_ciphertext IS NULL) = (username_set_at IS NULL)),
	CONSTRAINT "panel_credentials_password_check" CHECK ((password_ciphertext IS NULL) = (password_key_id IS NULL)
          AND (password_ciphertext IS NULL) = (password_set_at IS NULL)),
	CONSTRAINT "panel_credentials_api_token_check" CHECK ((api_token_ciphertext IS NULL) = (api_token_key_id IS NULL)
          AND (api_token_ciphertext IS NULL) = (api_token_set_at IS NULL))
);
--> statement-breakpoint
CREATE TABLE "panel_health" (
	"panel_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"state" text NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"latency_ms" integer NOT NULL,
	"failure" text,
	"status_code" integer,
	"provider_version" text,
	"last_healthy_at" timestamp with time zone,
	CONSTRAINT "panel_health_state_check" CHECK (state IN ('HEALTHY', 'DEGRADED', 'UNREACHABLE', 'AUTH_FAILED')),
	CONSTRAINT "panel_health_failure_check" CHECK (failure IS NULL OR failure IN ('AUTHENTICATION_FAILED', 'UNREACHABLE', 'TIMEOUT', 'TLS_FAILED', 'BLOCKED_TARGET', 'MALFORMED_RESPONSE', 'PROVIDER_ERROR', 'UNSUPPORTED_CAPABILITY')),
	CONSTRAINT "panel_health_failure_presence_check" CHECK ((state IN ('HEALTHY', 'DEGRADED')) = (failure IS NULL))
);
--> statement-breakpoint
CREATE TABLE "panels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"provider_type" text NOT NULL,
	"base_url" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "panels_status_check" CHECK (status IN ('ACTIVE', 'DISABLED', 'ARCHIVED')),
	CONSTRAINT "panels_provider_type_check" CHECK (provider_type IN ('marzban', 'sanaei')),
	CONSTRAINT "panels_archived_at_check" CHECK ((status = 'ARCHIVED') = (archived_at IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "panel_credentials" ADD CONSTRAINT "panel_credentials_panel_id_panels_id_fk" FOREIGN KEY ("panel_id") REFERENCES "public"."panels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panel_credentials" ADD CONSTRAINT "panel_credentials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panel_health" ADD CONSTRAINT "panel_health_panel_id_panels_id_fk" FOREIGN KEY ("panel_id") REFERENCES "public"."panels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panel_health" ADD CONSTRAINT "panel_health_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panels" ADD CONSTRAINT "panels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "panel_credentials_tenant_idx" ON "panel_credentials" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "panel_health_tenant_idx" ON "panel_health" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "panels_tenant_status_idx" ON "panels" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "panels_tenant_name_live_key" ON "panels" USING btree ("tenant_id","name") WHERE status <> 'ARCHIVED';