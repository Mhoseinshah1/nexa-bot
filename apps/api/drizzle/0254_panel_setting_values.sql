CREATE TABLE "panel_setting_values" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"panel_id" uuid NOT NULL,
	"setting_key" text NOT NULL,
	"value" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_admin_id" uuid,
	CONSTRAINT "panel_setting_values_version_check" CHECK (version >= 1),
	CONSTRAINT "panel_setting_values_key_check" CHECK (setting_key IN ('panel.connection_files.caption_mode', 'panel.connection_files.caption_template', 'panel.connection_files.caption_placement'))
);
--> statement-breakpoint
ALTER TABLE "panel_setting_values" ADD CONSTRAINT "panel_setting_values_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panel_setting_values" ADD CONSTRAINT "panel_setting_values_panel_fk" FOREIGN KEY ("tenant_id","panel_id") REFERENCES "public"."panels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panel_setting_values" ADD CONSTRAINT "panel_setting_values_tenant_admin_fk" FOREIGN KEY ("tenant_id","updated_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "panel_setting_values_key" ON "panel_setting_values" USING btree ("tenant_id","panel_id","setting_key");--> statement-breakpoint
-- Track 3 §2: a tenant that had REWRITTEN `bot.service.file_caption` keeps it. The registry
-- default for a panel's caption mode is CUSTOM (the owner's default for new installs), which
-- would silently stop rendering that tenant's own wording; so each existing panel of such a
-- tenant is pinned to the behaviour it had — the panel's caption, on every file. Every other
-- panel takes the registry defaults. `gen_random_uuid()` for the id, as other data
-- migrations do: SQL has no UUIDv7.
INSERT INTO "panel_setting_values" ("id", "tenant_id", "panel_id", "setting_key", "value")
SELECT gen_random_uuid(), p."tenant_id", p."id", k."setting_key", k."value"
FROM "panels" p
CROSS JOIN (
  VALUES
    ('panel.connection_files.caption_mode', '"PANEL_DEFAULT"'::jsonb),
    ('panel.connection_files.caption_placement', '"EVERY_FILE"'::jsonb)
) AS k("setting_key", "value")
WHERE EXISTS (
  SELECT 1 FROM "template_overrides" o
  WHERE o."tenant_id" = p."tenant_id" AND o."template_key" = 'bot.service.file_caption'
);
