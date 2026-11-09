ALTER TABLE "tenant_restores" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "tenant_restores" ADD COLUMN "lease_heartbeat_at" timestamp with time zone;