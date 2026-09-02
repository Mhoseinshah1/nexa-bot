-- Phase 2 — the control plane.
--
-- Six tables and two columns. Nothing here is created because this phase named
-- a concept: every table has a writer and a reader in the same phase.
--
-- Two shapes are worth reading twice.
--
-- `template_overrides` has NO default body and no `is_default` flag. A tenant
-- that has not customised a key has no row, which is what lets an improved
-- default reach them, and what makes "has this been customised" answerable
-- without a boolean that can disagree with the value beside it. Reverting
-- deletes the row; `template_revisions` keeps the history, the revert included.
--
-- `notifications` and `notification_delivery_attempts` are two tables on
-- purpose. The intent is what somebody should be told; an attempt is what
-- happened on the wire. The legacy system has one field quietly doing both, and
-- that is precisely why nobody can say whether its notification report means
-- "sent" or "matched" (UNK-LGR-015).
--
-- `operational_events` gains `resolved_at` and `resolved_by_event_id`. They mark
-- history; they never remove it. A recovery event sets them, a recurrence clears
-- them again, and both events stay in the table either way.
--
-- Composite foreign keys throughout, following migration 0007: a child row names
-- "this id, IN THIS TENANT", so a mis-tenanted row is rejected by the database
-- rather than becoming invisible to the tenant that owns the id.
--
-- One partial index is added, `notifications_pending_idx`, and it serves exactly
-- one query: the dispatcher's claim. It stays small because a row leaves it the
-- moment the notification reaches SENT or FAILED, and it deliberately does not
-- lead with `tenant_id` — the dispatcher runs for the installation and has no
-- tenant to fix.

CREATE TABLE "feature_flag_states" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"flag_key" text NOT NULL,
	"enabled" boolean NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_admin_id" uuid,
	"reason" text,
	CONSTRAINT "feature_flag_states_version_check" CHECK (version >= 1)
);
--> statement-breakpoint
CREATE TABLE "notification_delivery_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"notification_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"transport" text NOT NULL,
	"outcome" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"error_code" text,
	"error_message" text,
	"retry_after_ms" integer,
	CONSTRAINT "notification_delivery_attempts_outcome_check" CHECK (outcome IN ('SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_PERMANENT')),
	CONSTRAINT "notification_delivery_attempts_transport_check" CHECK (transport IN ('TELEGRAM', 'RECORDING')),
	CONSTRAINT "notification_delivery_attempts_number_check" CHECK (attempt_number >= 1),
	CONSTRAINT "notification_delivery_attempts_error_check" CHECK ((outcome = 'SUCCEEDED' AND error_code IS NULL) OR (outcome <> 'SUCCEEDED' AND error_code IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"destination" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"template_key" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"correlation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "notifications_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "notifications_kind_check" CHECK (kind IN ('OPERATIONAL_EVENT', 'OPERATIONS_TEST')),
	CONSTRAINT "notifications_status_check" CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
	CONSTRAINT "notifications_attempts_check" CHECK (attempt_count >= 0 AND max_attempts >= 1),
	CONSTRAINT "notifications_completed_check" CHECK ((status = 'PENDING' AND completed_at IS NULL) OR (status <> 'PENDING' AND completed_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "setting_values" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"setting_key" text NOT NULL,
	"value" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_admin_id" uuid,
	CONSTRAINT "setting_values_version_check" CHECK (version >= 1)
);
--> statement-breakpoint
CREATE TABLE "template_overrides" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"template_key" text NOT NULL,
	"locale" text NOT NULL,
	"body" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"revision" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_admin_id" uuid,
	CONSTRAINT "template_overrides_version_check" CHECK (version >= 1),
	CONSTRAINT "template_overrides_body_check" CHECK (length(body) BETWEEN 1 AND 4096)
);
--> statement-breakpoint
CREATE TABLE "template_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"template_key" text NOT NULL,
	"locale" text NOT NULL,
	"revision" integer NOT NULL,
	"action" text NOT NULL,
	"body" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_admin_id" uuid,
	CONSTRAINT "template_revisions_action_check" CHECK (action IN ('SET', 'REVERT')),
	CONSTRAINT "template_revisions_revision_check" CHECK (revision >= 1),
	CONSTRAINT "template_revisions_body_check" CHECK ((action = 'SET' AND body IS NOT NULL AND length(body) BETWEEN 1 AND 4096) OR (action = 'REVERT' AND body IS NULL))
);
--> statement-breakpoint
ALTER TABLE "operational_events" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "operational_events" ADD COLUMN "resolved_by_event_id" uuid;--> statement-breakpoint
ALTER TABLE "feature_flag_states" ADD CONSTRAINT "feature_flag_states_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flag_states" ADD CONSTRAINT "feature_flag_states_tenant_admin_fk" FOREIGN KEY ("tenant_id","updated_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery_attempts" ADD CONSTRAINT "notification_delivery_attempts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery_attempts" ADD CONSTRAINT "notification_delivery_attempts_tenant_notification_fk" FOREIGN KEY ("tenant_id","notification_id") REFERENCES "public"."notifications"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setting_values" ADD CONSTRAINT "setting_values_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setting_values" ADD CONSTRAINT "setting_values_tenant_admin_fk" FOREIGN KEY ("tenant_id","updated_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_overrides" ADD CONSTRAINT "template_overrides_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_overrides" ADD CONSTRAINT "template_overrides_tenant_admin_fk" FOREIGN KEY ("tenant_id","updated_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_revisions" ADD CONSTRAINT "template_revisions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_revisions" ADD CONSTRAINT "template_revisions_tenant_admin_fk" FOREIGN KEY ("tenant_id","created_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feature_flag_states_key" ON "feature_flag_states" USING btree ("tenant_id","flag_key");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_delivery_attempts_key" ON "notification_delivery_attempts" USING btree ("tenant_id","notification_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_key" ON "notifications" USING btree ("tenant_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "notifications_tenant_created_idx" ON "notifications" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_pending_idx" ON "notifications" USING btree ("next_attempt_at") WHERE status = 'PENDING';--> statement-breakpoint
CREATE UNIQUE INDEX "setting_values_key" ON "setting_values" USING btree ("tenant_id","setting_key");--> statement-breakpoint
CREATE UNIQUE INDEX "template_overrides_key" ON "template_overrides" USING btree ("tenant_id","template_key","locale");--> statement-breakpoint
CREATE UNIQUE INDEX "template_revisions_key" ON "template_revisions" USING btree ("tenant_id","template_key","locale","revision");--> statement-breakpoint
ALTER TABLE "operational_events" ADD CONSTRAINT "operational_events_resolution_check" CHECK (resolved_by_event_id IS NULL OR resolved_at IS NOT NULL);