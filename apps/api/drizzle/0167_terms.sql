CREATE TABLE "terms_acceptances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"terms_version_id" uuid NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"bot_instance_id" uuid,
	"correlation_id" text NOT NULL,
	CONSTRAINT "terms_acceptances_once_key" UNIQUE("tenant_id","customer_id","terms_version_id"),
	CONSTRAINT "terms_acceptances_source_check" CHECK (source IN ('TELEGRAM'))
);
--> statement-breakpoint
CREATE TABLE "terms_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"status" text NOT NULL,
	"version_number" integer,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by_admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by_admin_id" uuid,
	"published_at" timestamp with time zone,
	CONSTRAINT "terms_versions_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "terms_versions_tenant_number_key" UNIQUE("tenant_id","version_number"),
	CONSTRAINT "terms_versions_status_check" CHECK (status IN ('DRAFT', 'PUBLISHED')),
	CONSTRAINT "terms_versions_published_check" CHECK ((status = 'PUBLISHED') = (version_number IS NOT NULL AND published_at IS NOT NULL)),
	CONSTRAINT "terms_versions_number_check" CHECK (version_number IS NULL OR version_number >= 1),
	CONSTRAINT "terms_versions_revision_check" CHECK (revision >= 1),
	CONSTRAINT "terms_versions_title_check" CHECK (length(btrim(title)) BETWEEN 1 AND 120),
	CONSTRAINT "terms_versions_body_check" CHECK (length(btrim(body)) BETWEEN 1 AND 3500)
);
--> statement-breakpoint
ALTER TABLE "terms_acceptances" ADD CONSTRAINT "terms_acceptances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms_acceptances" ADD CONSTRAINT "terms_acceptances_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms_acceptances" ADD CONSTRAINT "terms_acceptances_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms_acceptances" ADD CONSTRAINT "terms_acceptances_version_fk" FOREIGN KEY ("tenant_id","terms_version_id") REFERENCES "public"."terms_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms_versions" ADD CONSTRAINT "terms_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms_versions" ADD CONSTRAINT "terms_versions_created_by_admin_id_admins_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms_versions" ADD CONSTRAINT "terms_versions_published_by_admin_id_admins_id_fk" FOREIGN KEY ("published_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "terms_acceptances_version_idx" ON "terms_acceptances" USING btree ("tenant_id","terms_version_id");--> statement-breakpoint
CREATE INDEX "terms_acceptances_customer_idx" ON "terms_acceptances" USING btree ("tenant_id","customer_id","accepted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "terms_versions_one_draft_key" ON "terms_versions" USING btree ("tenant_id") WHERE status = 'DRAFT';