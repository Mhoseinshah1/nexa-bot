CREATE TABLE "customer_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"body" text NOT NULL,
	"author_admin_id" uuid,
	"author_label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_notes_body_check" CHECK (length(body) BETWEEN 1 AND 2000),
	CONSTRAINT "customer_notes_author_check" CHECK (length(author_label) BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE "customer_tag_assignments" (
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"assigned_by_admin_id" uuid,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_tag_assignments_pkey" PRIMARY KEY("tenant_id","customer_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "customer_tags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"label" text NOT NULL,
	"color" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_tags_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "customer_tags_color_check" CHECK (color IS NULL OR color IN ('neutral', 'info', 'ok', 'warn', 'danger', 'violet', 'teal')),
	CONSTRAINT "customer_tags_label_check" CHECK (length(label) BETWEEN 1 AND 40 AND label = btrim(regexp_replace(label, '\s+', ' ', 'g')))
);
--> statement-breakpoint
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_author_admin_id_admins_id_fk" FOREIGN KEY ("author_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_tag_assignments" ADD CONSTRAINT "customer_tag_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_tag_assignments" ADD CONSTRAINT "customer_tag_assignments_assigned_by_admin_id_admins_id_fk" FOREIGN KEY ("assigned_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_tag_assignments" ADD CONSTRAINT "customer_tag_assignments_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_tag_assignments" ADD CONSTRAINT "customer_tag_assignments_tag_fk" FOREIGN KEY ("tenant_id","tag_id") REFERENCES "public"."customer_tags"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_tags" ADD CONSTRAINT "customer_tags_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_notes_customer_idx" ON "customer_notes" USING btree ("tenant_id","customer_id","created_at","id");--> statement-breakpoint
CREATE INDEX "customer_tag_assignments_tag_idx" ON "customer_tag_assignments" USING btree ("tenant_id","tag_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_tags_active_label_key" ON "customer_tags" USING btree ("tenant_id",lower("label")) WHERE archived_at IS NULL;