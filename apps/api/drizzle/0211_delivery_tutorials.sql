CREATE TABLE "delivery_tutorials" (
	"tenant_id" uuid NOT NULL,
	"panel_id" uuid NOT NULL,
	"mode" text DEFAULT 'DISABLED' NOT NULL,
	"text" text,
	"video_client_app_id" uuid,
	"applies_to_purchase" boolean DEFAULT true NOT NULL,
	"applies_to_trial" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_tutorials_pk" PRIMARY KEY("tenant_id","panel_id"),
	CONSTRAINT "delivery_tutorials_mode_check" CHECK (mode IN ('DISABLED', 'TEXT', 'VIDEO', 'VIDEO_TEXT')),
	CONSTRAINT "delivery_tutorials_text_check" CHECK (text IS NULL OR length(btrim(text)) BETWEEN 1 AND 2500),
	CONSTRAINT "delivery_tutorials_content_check" CHECK ((mode NOT IN ('TEXT', 'VIDEO_TEXT') OR text IS NOT NULL)
          AND (mode NOT IN ('VIDEO', 'VIDEO_TEXT') OR video_client_app_id IS NOT NULL)),
	CONSTRAINT "delivery_tutorials_revision_check" CHECK (revision >= 1)
);
--> statement-breakpoint
ALTER TABLE "delivery_tutorials" ADD CONSTRAINT "delivery_tutorials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_tutorials" ADD CONSTRAINT "delivery_tutorials_panel_fk" FOREIGN KEY ("tenant_id","panel_id") REFERENCES "public"."panels"("tenant_id","id") ON DELETE no action ON UPDATE no action;