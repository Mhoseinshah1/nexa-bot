CREATE TABLE "hosted_bot_activation_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"hosted_tenant_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_by_admin_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "hosted_bot_activation_links_expiry_check" CHECK (expires_at > created_at)
);
--> statement-breakpoint
CREATE TABLE "hosted_bot_activations" (
	"tenant_id" uuid NOT NULL,
	"hosted_tenant_id" uuid NOT NULL,
	"bot_instance_id" uuid,
	"domain" text,
	"token_verified_at" timestamp with time zone,
	"dns_verified_at" timestamp with time zone,
	"tls_verified_at" timestamp with time zone,
	"webhook_registered_at" timestamp with time zone,
	"last_error_step" text,
	"last_error_code" text,
	"last_error_at" timestamp with time zone,
	"owner_activated_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hosted_bot_activations_pkey" PRIMARY KEY("tenant_id","hosted_tenant_id"),
	CONSTRAINT "hosted_bot_activations_domain_shape_check" CHECK (domain IS NULL OR (domain = lower(domain) AND char_length(domain) BETWEEN 4 AND 253)),
	CONSTRAINT "hosted_bot_activations_error_step_check" CHECK (last_error_step IS NULL OR last_error_step IN ('TOKEN', 'DOMAIN', 'SSL', 'WEBHOOK', 'LINK')),
	CONSTRAINT "hosted_bot_activations_error_check" CHECK ((last_error_step IS NULL) = (last_error_code IS NULL) AND (last_error_step IS NULL) = (last_error_at IS NULL)),
	CONSTRAINT "hosted_bot_activations_order_check" CHECK ((tls_verified_at IS NULL OR dns_verified_at IS NOT NULL)
        AND (dns_verified_at IS NULL OR domain IS NOT NULL)
        AND (webhook_registered_at IS NULL OR (tls_verified_at IS NOT NULL AND token_verified_at IS NOT NULL)))
);
--> statement-breakpoint
ALTER TABLE "hosted_bot_activation_links" ADD CONSTRAINT "hosted_bot_activation_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosted_bot_activation_links" ADD CONSTRAINT "hosted_bot_activation_links_hosted_tenant_id_tenants_id_fk" FOREIGN KEY ("hosted_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosted_bot_activation_links" ADD CONSTRAINT "hosted_bot_activation_links_hosted_fk" FOREIGN KEY ("tenant_id","hosted_tenant_id") REFERENCES "public"."hosted_bots"("tenant_id","hosted_tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosted_bot_activation_links" ADD CONSTRAINT "hosted_bot_activation_links_created_by_fk" FOREIGN KEY ("tenant_id","created_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosted_bot_activations" ADD CONSTRAINT "hosted_bot_activations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosted_bot_activations" ADD CONSTRAINT "hosted_bot_activations_hosted_tenant_id_tenants_id_fk" FOREIGN KEY ("hosted_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosted_bot_activations" ADD CONSTRAINT "hosted_bot_activations_hosted_fk" FOREIGN KEY ("tenant_id","hosted_tenant_id") REFERENCES "public"."hosted_bots"("tenant_id","hosted_tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hosted_bot_activation_links_token_key" ON "hosted_bot_activation_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "hosted_bot_activation_links_hosted_idx" ON "hosted_bot_activation_links" USING btree ("tenant_id","hosted_tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "hosted_bot_activations_domain_key" ON "hosted_bot_activations" USING btree ("domain") WHERE domain IS NOT NULL;