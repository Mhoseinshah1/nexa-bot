CREATE TABLE "bot_command_syncs" (
	"bot_instance_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"desired_hash" text NOT NULL,
	"desired_version" integer DEFAULT 1 NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_attempted_at" timestamp with time zone,
	"last_error_code" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"claimed_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_command_syncs_attempts_check" CHECK (attempts >= 0),
	CONSTRAINT "bot_command_syncs_version_check" CHECK (desired_version >= 1)
);
--> statement-breakpoint
ALTER TABLE "bot_command_syncs" ADD CONSTRAINT "bot_command_syncs_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_command_syncs" ADD CONSTRAINT "bot_command_syncs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bot_command_syncs_tenant_idx" ON "bot_command_syncs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "bot_command_syncs_due_idx" ON "bot_command_syncs" USING btree ("next_attempt_at") WHERE next_attempt_at IS NOT NULL;