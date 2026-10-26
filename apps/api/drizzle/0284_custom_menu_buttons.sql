CREATE TABLE "custom_menu_button_bots" (
	"tenant_id" uuid NOT NULL,
	"button_id" uuid NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	CONSTRAINT "custom_menu_button_bots_pk" PRIMARY KEY("tenant_id","button_id","bot_instance_id")
);
--> statement-breakpoint
CREATE TABLE "custom_menu_button_media" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"mime_type" text NOT NULL,
	"file_name" text NOT NULL,
	"byte_length" integer NOT NULL,
	"sha256" text NOT NULL,
	"content" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_menu_button_media_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "custom_menu_button_media_tenant_kind_key" UNIQUE("tenant_id","id","kind"),
	CONSTRAINT "custom_menu_button_media_kind_check" CHECK (kind IN ('PHOTO', 'DOCUMENT')),
	CONSTRAINT "custom_menu_button_media_type_check" CHECK (CASE mime_type WHEN 'image/jpeg' THEN kind = 'PHOTO' AND byte_length BETWEEN 1 AND 5242880 WHEN 'image/png' THEN kind = 'PHOTO' AND byte_length BETWEEN 1 AND 5242880 WHEN 'application/pdf' THEN kind = 'DOCUMENT' AND byte_length BETWEEN 1 AND 10485760 WHEN 'text/plain' THEN kind = 'DOCUMENT' AND byte_length BETWEEN 1 AND 1048576 ELSE false END),
	CONSTRAINT "custom_menu_button_media_content_check" CHECK (octet_length(content) = byte_length),
	CONSTRAINT "custom_menu_button_media_sha256_check" CHECK (sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "custom_menu_button_media_file_name_check" CHECK (char_length(file_name) BETWEEN 1 AND 255)
);
--> statement-breakpoint
CREATE TABLE "custom_menu_buttons" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"label" text NOT NULL,
	"kind" text NOT NULL,
	"url" text,
	"body" text,
	"media_id" uuid,
	"bot_scope" text DEFAULT 'ALL' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_admin_id" uuid,
	"updated_by_admin_id" uuid,
	CONSTRAINT "custom_menu_buttons_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "custom_menu_buttons_kind_check" CHECK (kind IN ('LINK', 'TEXT', 'PHOTO', 'DOCUMENT')),
	CONSTRAINT "custom_menu_buttons_scope_check" CHECK (bot_scope IN ('ALL', 'SELECTED')),
	CONSTRAINT "custom_menu_buttons_version_check" CHECK (version >= 1),
	CONSTRAINT "custom_menu_buttons_label_check" CHECK (char_length(label) BETWEEN 1 AND 64
          AND label !~ '[[:cntrl:]]' AND left(label, 1) <> '/' AND label = btrim(label)),
	CONSTRAINT "custom_menu_buttons_url_check" CHECK (url IS NULL OR (url ~ '^https://' AND char_length(url) <= 2048)),
	CONSTRAINT "custom_menu_buttons_shape_check" CHECK (CASE kind
            WHEN 'LINK' THEN url IS NOT NULL AND media_id IS NULL
              AND (body IS NULL OR char_length(body) BETWEEN 1 AND 4096)
            WHEN 'TEXT' THEN url IS NULL AND media_id IS NULL AND body IS NOT NULL
              AND char_length(body) BETWEEN 1 AND 4096
            WHEN 'PHOTO' THEN url IS NULL AND (media_id IS NOT NULL OR archived_at IS NOT NULL)
              AND (body IS NULL OR char_length(body) BETWEEN 1 AND 1024)
            WHEN 'DOCUMENT' THEN url IS NULL AND (media_id IS NOT NULL OR archived_at IS NOT NULL)
              AND (body IS NULL OR char_length(body) BETWEEN 1 AND 1024)
            ELSE false
          END)
);
--> statement-breakpoint
ALTER TABLE "custom_menu_button_bots" ADD CONSTRAINT "custom_menu_button_bots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_menu_button_bots" ADD CONSTRAINT "custom_menu_button_bots_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_menu_button_bots" ADD CONSTRAINT "custom_menu_button_bots_button_fk" FOREIGN KEY ("tenant_id","button_id") REFERENCES "public"."custom_menu_buttons"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_menu_button_media" ADD CONSTRAINT "custom_menu_button_media_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_menu_buttons" ADD CONSTRAINT "custom_menu_buttons_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_menu_buttons" ADD CONSTRAINT "custom_menu_buttons_media_fk" FOREIGN KEY ("tenant_id","media_id","kind") REFERENCES "public"."custom_menu_button_media"("tenant_id","id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_menu_buttons" ADD CONSTRAINT "custom_menu_buttons_created_admin_fk" FOREIGN KEY ("tenant_id","created_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_menu_buttons" ADD CONSTRAINT "custom_menu_buttons_updated_admin_fk" FOREIGN KEY ("tenant_id","updated_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "custom_menu_button_bots_bot_idx" ON "custom_menu_button_bots" USING btree ("tenant_id","bot_instance_id");--> statement-breakpoint
CREATE INDEX "custom_menu_button_media_tenant_idx" ON "custom_menu_button_media" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_menu_buttons_active_label_key" ON "custom_menu_buttons" USING btree ("tenant_id","label") WHERE archived_at IS NULL;--> statement-breakpoint
CREATE INDEX "custom_menu_buttons_tenant_idx" ON "custom_menu_buttons" USING btree ("tenant_id","created_at","id");