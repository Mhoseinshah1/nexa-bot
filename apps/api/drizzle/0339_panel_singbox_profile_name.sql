ALTER TABLE "panels" ADD COLUMN "singbox_name_mode" text DEFAULT 'DEFAULT' NOT NULL;--> statement-breakpoint
ALTER TABLE "panels" ADD COLUMN "singbox_name_custom" text;--> statement-breakpoint
ALTER TABLE "panels" ADD CONSTRAINT "panels_singbox_name_mode_check" CHECK (singbox_name_mode IN ('DEFAULT', 'USERNAME', 'CUSTOM'));--> statement-breakpoint
ALTER TABLE "panels" ADD CONSTRAINT "panels_singbox_name_custom_check" CHECK ("panels"."singbox_name_custom" IS NULL OR (char_length("panels"."singbox_name_custom") BETWEEN 1 AND 64 AND "panels"."singbox_name_custom" !~ '[[:cntrl:]]'));