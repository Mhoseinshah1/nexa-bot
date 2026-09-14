ALTER TABLE "bot_instances" ADD COLUMN "webhook_registered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bot_instances" ADD COLUMN "webhook_url" text;