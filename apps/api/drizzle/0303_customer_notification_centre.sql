-- R11 B1: the notification centre's two columns. customer_notifications is a large table
-- (scripts/check-migration-ddl.mjs), so the CHECK is added NOT VALID, then VALIDATEd, and the
-- two partial indexes are built CONCURRENTLY by online-indexes.ts. Only hand edit of the
-- generated SQL; journal and snapshot are untouched.
ALTER TABLE "customer_notifications" ADD COLUMN "rendered_text" text;--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD COLUMN "customer_read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_centre_check" CHECK ((rendered_text IS NULL OR state = 'DELIVERED') AND (customer_read_at IS NULL OR rendered_text IS NOT NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "customer_notifications" VALIDATE CONSTRAINT "customer_notifications_centre_check";
