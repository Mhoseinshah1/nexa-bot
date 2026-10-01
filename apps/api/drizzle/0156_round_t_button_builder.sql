-- Round T — the button builder (docs/round-t-button-builder-audit.md §11.1).
--
-- Two tables beside bot.main_menu, never a change to it: main_menu_layouts holds each
-- tenant's draft and published head (one row per tenant, none until its first draft
-- save), and main_menu_revisions holds one append-only row per publish. bot.main_menu
-- keeps its exact shape and becomes the compatibility projection a publish rewrites in the
-- same transaction, so the previous release keeps reading a value its strict parser
-- accepts.
--
-- Rollback: this only adds. The previous release neither reads nor writes either table; it
-- draws the keyboard from the projection (same order, same visibility, two to a row, no
-- styles or icons). A setting it writes during the rollback moves setting_values.version
-- past projection_setting_version, which this release reads as SUPERSEDED: the keyboard
-- follows the setting until somebody publishes again (docs/deployment.md, round T).
CREATE TABLE "main_menu_layouts" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"draft" jsonb NOT NULL,
	"draft_version" integer DEFAULT 1 NOT NULL,
	"draft_updated_at" timestamp with time zone NOT NULL,
	"draft_updated_by_admin_id" uuid,
	"draft_restored_from_revision_id" uuid,
	"draft_legacy_setting_version" integer,
	"published" jsonb,
	"published_revision" integer,
	"published_at" timestamp with time zone,
	"published_by_admin_id" uuid,
	"projection_setting_version" integer,
	CONSTRAINT "main_menu_layouts_draft_check" CHECK (jsonb_typeof(draft) = 'object'),
	CONSTRAINT "main_menu_layouts_draft_version_check" CHECK (draft_version >= 1),
	CONSTRAINT "main_menu_layouts_draft_legacy_setting_version_check" CHECK (draft_legacy_setting_version IS NULL OR draft_legacy_setting_version >= 1),
	CONSTRAINT "main_menu_layouts_published_check" CHECK (published IS NULL OR jsonb_typeof(published) = 'object'),
	CONSTRAINT "main_menu_layouts_published_revision_check" CHECK (published_revision IS NULL OR published_revision >= 1),
	CONSTRAINT "main_menu_layouts_published_shape_check" CHECK ((published IS NULL) = (published_revision IS NULL) AND (published IS NULL) = (published_at IS NULL) AND (published IS NULL) = (projection_setting_version IS NULL))
);
--> statement-breakpoint
CREATE TABLE "main_menu_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"restored_from_revision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_admin_id" uuid,
	CONSTRAINT "main_menu_revisions_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "main_menu_revisions_revision_check" CHECK (revision >= 1),
	CONSTRAINT "main_menu_revisions_snapshot_check" CHECK (jsonb_typeof(snapshot) = 'object')
);
--> statement-breakpoint
ALTER TABLE "main_menu_layouts" ADD CONSTRAINT "main_menu_layouts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "main_menu_layouts" ADD CONSTRAINT "main_menu_layouts_restored_from_fk" FOREIGN KEY ("tenant_id","draft_restored_from_revision_id") REFERENCES "public"."main_menu_revisions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "main_menu_layouts" ADD CONSTRAINT "main_menu_layouts_draft_admin_fk" FOREIGN KEY ("tenant_id","draft_updated_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "main_menu_layouts" ADD CONSTRAINT "main_menu_layouts_published_admin_fk" FOREIGN KEY ("tenant_id","published_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "main_menu_revisions" ADD CONSTRAINT "main_menu_revisions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "main_menu_revisions" ADD CONSTRAINT "main_menu_revisions_restored_from_fk" FOREIGN KEY ("tenant_id","restored_from_revision_id") REFERENCES "public"."main_menu_revisions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "main_menu_revisions" ADD CONSTRAINT "main_menu_revisions_tenant_admin_fk" FOREIGN KEY ("tenant_id","created_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "main_menu_revisions_tenant_revision_key" ON "main_menu_revisions" USING btree ("tenant_id","revision");
--> statement-breakpoint
-- A published keyboard is history: never edited, never removed (as template_revisions, 0011).
CREATE TRIGGER main_menu_revisions_no_update
  BEFORE UPDATE ON main_menu_revisions
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER main_menu_revisions_no_delete
  BEFORE DELETE ON main_menu_revisions
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
