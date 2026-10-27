ALTER TABLE "panels" ADD COLUMN "qr_kind" text DEFAULT 'SUB_LINK' NOT NULL;--> statement-breakpoint
ALTER TABLE "panels" ADD COLUMN "singbox_interval_minutes" integer DEFAULT 360 NOT NULL;--> statement-breakpoint
ALTER TABLE "panels" ADD CONSTRAINT "panels_qr_kind_check" CHECK (qr_kind IN ('SUB_LINK', 'SINGBOX', 'BOTH'));--> statement-breakpoint
ALTER TABLE "panels" ADD CONSTRAINT "panels_singbox_interval_check" CHECK ("panels"."singbox_interval_minutes" BETWEEN 1 AND 10080);