CREATE TABLE "broadcast_bot_pacing" (
	"tenant_id" uuid NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"sent_in_window" integer DEFAULT 0 NOT NULL,
	"hold_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "broadcast_bot_pacing_pk" PRIMARY KEY("tenant_id","bot_instance_id"),
	CONSTRAINT "broadcast_bot_pacing_sent_check" CHECK (sent_in_window >= 0)
);
--> statement-breakpoint
CREATE TABLE "broadcast_media" (
	"tenant_id" uuid NOT NULL,
	"broadcast_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"mime_type" text NOT NULL,
	"file_name" text NOT NULL,
	"byte_length" integer NOT NULL,
	"sha256" text NOT NULL,
	"content" "bytea",
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "broadcast_media_pk" PRIMARY KEY("tenant_id","broadcast_id"),
	CONSTRAINT "broadcast_media_type_check" CHECK (CASE mime_type WHEN 'image/jpeg' THEN kind = 'PHOTO' AND byte_length BETWEEN 1 AND 5242880 WHEN 'image/png' THEN kind = 'PHOTO' AND byte_length BETWEEN 1 AND 5242880 WHEN 'video/mp4' THEN kind = 'VIDEO' AND byte_length BETWEEN 1 AND 20971520 WHEN 'application/pdf' THEN kind = 'DOCUMENT' AND byte_length BETWEEN 1 AND 10485760 ELSE false END),
	CONSTRAINT "broadcast_media_content_check" CHECK ((content IS NULL) = (purged_at IS NOT NULL)
          AND (content IS NULL OR octet_length(content) = byte_length)),
	CONSTRAINT "broadcast_media_sha256_check" CHECK (sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "broadcast_media_name_check" CHECK (length(file_name) BETWEEN 1 AND 120)
);
--> statement-breakpoint
CREATE TABLE "broadcast_media_handles" (
	"tenant_id" uuid NOT NULL,
	"broadcast_id" uuid NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	"telegram_file_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "broadcast_media_handles_pk" PRIMARY KEY("tenant_id","broadcast_id","bot_instance_id"),
	CONSTRAINT "broadcast_media_handles_file_check" CHECK (length(telegram_file_id) BETWEEN 1 AND 512)
);
--> statement-breakpoint
CREATE TABLE "broadcast_recipients" (
	"tenant_id" uuid NOT NULL,
	"broadcast_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"bot_instance_id" uuid,
	"chat_id" text NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"send_started_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "broadcast_recipients_pk" PRIMARY KEY("tenant_id","broadcast_id","customer_id"),
	CONSTRAINT "broadcast_recipients_state_check" CHECK (state IN ('PENDING', 'SENDING', 'SENT', 'UNCONFIRMED', 'FAILED', 'UNREACHABLE', 'SKIPPED', 'CANCELLED')),
	CONSTRAINT "broadcast_recipients_attempts_check" CHECK (attempts >= 0 AND attempts <= 100),
	CONSTRAINT "broadcast_recipients_resolved_check" CHECK ((state IN ('PENDING', 'SENDING')) = (resolved_at IS NULL)),
	CONSTRAINT "broadcast_recipients_sending_check" CHECK (state <> 'SENDING' OR (send_started_at IS NOT NULL AND lease_until IS NOT NULL)),
	CONSTRAINT "broadcast_recipients_error_check" CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE TABLE "broadcasts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"state" text DEFAULT 'DRAFT' NOT NULL,
	"pause_reason" text,
	"content_kind" text NOT NULL,
	"body" text NOT NULL,
	"buttons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"audience_definition" jsonb NOT NULL,
	"audience_hash" text NOT NULL,
	"audience_as_of" timestamp with time zone,
	"recipient_count" integer,
	"audience_fingerprint" text,
	"scheduled_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_admin_id" uuid,
	"launched_by_admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"launched_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "broadcasts_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "broadcasts_state_check" CHECK (state IN ('DRAFT', 'SCHEDULED', 'SENDING', 'PAUSED', 'COMPLETED', 'CANCELLED')),
	CONSTRAINT "broadcasts_pause_reason_check" CHECK (pause_reason IS NULL OR pause_reason IN ('OPERATOR', 'BOT_UNAVAILABLE')),
	CONSTRAINT "broadcasts_content_kind_check" CHECK (content_kind IN ('TEXT', 'PHOTO', 'VIDEO', 'DOCUMENT')),
	CONSTRAINT "broadcasts_title_check" CHECK (length(title) BETWEEN 1 AND 120),
	CONSTRAINT "broadcasts_hash_check" CHECK (audience_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "broadcasts_version_check" CHECK (version >= 1),
	CONSTRAINT "broadcasts_buttons_check" CHECK (jsonb_typeof(buttons) = 'array'),
	CONSTRAINT "broadcasts_frozen_check" CHECK ((state = 'DRAFT') = (launched_at IS NULL)
          AND (state = 'DRAFT' OR (audience_as_of IS NOT NULL AND recipient_count IS NOT NULL
                                   AND audience_fingerprint IS NOT NULL))),
	CONSTRAINT "broadcasts_schedule_check" CHECK (state <> 'SCHEDULED' OR scheduled_at IS NOT NULL),
	CONSTRAINT "broadcasts_paused_check" CHECK ((state = 'PAUSED') = (pause_reason IS NOT NULL)),
	CONSTRAINT "broadcasts_completed_check" CHECK ((state = 'COMPLETED') = (completed_at IS NOT NULL)),
	CONSTRAINT "broadcasts_cancelled_check" CHECK ((state = 'CANCELLED') = (cancelled_at IS NOT NULL)),
	CONSTRAINT "broadcasts_recipient_count_check" CHECK (recipient_count IS NULL OR recipient_count >= 0)
);
--> statement-breakpoint
CREATE TABLE "bulk_operation_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bulk_operation_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"service_id" uuid,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"skip_reason" text,
	"wallet_entry_id" uuid,
	"provisioning_operation_id" uuid,
	"notified_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bulk_operation_items_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "bulk_operation_items_state_check" CHECK (state IN ('PENDING', 'CREDITED', 'PLANNED', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED')),
	CONSTRAINT "bulk_operation_items_skip_check" CHECK (skip_reason IS NULL OR skip_reason IN ('CUSTOMER_BLOCKED', 'CURRENCY_CHANGED', 'SERVICE_NOT_ELIGIBLE', 'SERVICE_NOT_OWNED', 'PANEL_NOT_OPERABLE', 'ACTION_IN_PROGRESS', 'UNLIMITED', 'LIMIT_EXCEEDED', 'REFUND_REQUESTED', 'TERMINATION_PENDING')),
	CONSTRAINT "bulk_operation_items_skipped_check" CHECK ((state = 'SKIPPED') = (skip_reason IS NOT NULL)),
	CONSTRAINT "bulk_operation_items_credited_check" CHECK ((state = 'CREDITED') = (wallet_entry_id IS NOT NULL)),
	CONSTRAINT "bulk_operation_items_planned_check" CHECK ((state IN ('PLANNED', 'SUCCEEDED', 'FAILED')) = (provisioning_operation_id IS NOT NULL)),
	CONSTRAINT "bulk_operation_items_processed_check" CHECK ((state IN ('PENDING', 'CANCELLED')) = (processed_at IS NULL))
);
--> statement-breakpoint
CREATE TABLE "bulk_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'RUNNING' NOT NULL,
	"amount_minor" bigint,
	"currency" text,
	"traffic_bytes" bigint,
	"duration_days" integer,
	"notify" boolean NOT NULL,
	"note" text NOT NULL,
	"audience_definition" jsonb NOT NULL,
	"audience_hash" text NOT NULL,
	"audience_as_of" timestamp with time zone NOT NULL,
	"item_count" integer NOT NULL,
	"audience_fingerprint" text NOT NULL,
	"created_by_admin_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "bulk_operations_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "bulk_operations_kind_check" CHECK (kind IN ('WALLET_CREDIT', 'SERVICE_TRAFFIC', 'SERVICE_TIME')),
	CONSTRAINT "bulk_operations_state_check" CHECK (state IN ('RUNNING', 'COMPLETED', 'CANCELLED')),
	CONSTRAINT "bulk_operations_currency_check" CHECK (currency IS NULL OR currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "bulk_operations_grant_check" CHECK (CASE kind
            WHEN 'WALLET_CREDIT' THEN amount_minor IS NOT NULL AND amount_minor > 0
                 AND currency IS NOT NULL AND traffic_bytes IS NULL AND duration_days IS NULL
            WHEN 'SERVICE_TRAFFIC' THEN traffic_bytes IS NOT NULL AND traffic_bytes > 0
                 AND amount_minor IS NULL AND currency IS NULL AND duration_days IS NULL
            WHEN 'SERVICE_TIME' THEN duration_days IS NOT NULL AND duration_days > 0
                 AND amount_minor IS NULL AND currency IS NULL AND traffic_bytes IS NULL
            ELSE false
          END),
	CONSTRAINT "bulk_operations_note_check" CHECK (length(note) BETWEEN 1 AND 300),
	CONSTRAINT "bulk_operations_hash_check" CHECK (audience_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "bulk_operations_items_check" CHECK (item_count >= 1),
	CONSTRAINT "bulk_operations_completed_check" CHECK ((state = 'COMPLETED') = (completed_at IS NOT NULL)),
	CONSTRAINT "bulk_operations_cancelled_check" CHECK ((state = 'CANCELLED') = (cancelled_at IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "customer_notifications" DROP CONSTRAINT "customer_notifications_kind_check";--> statement-breakpoint
ALTER TABLE "broadcast_bot_pacing" ADD CONSTRAINT "broadcast_bot_pacing_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_bot_pacing" ADD CONSTRAINT "broadcast_bot_pacing_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_media" ADD CONSTRAINT "broadcast_media_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_media" ADD CONSTRAINT "broadcast_media_broadcast_fk" FOREIGN KEY ("tenant_id","broadcast_id") REFERENCES "public"."broadcasts"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_media_handles" ADD CONSTRAINT "broadcast_media_handles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_media_handles" ADD CONSTRAINT "broadcast_media_handles_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_media_handles" ADD CONSTRAINT "broadcast_media_handles_broadcast_fk" FOREIGN KEY ("tenant_id","broadcast_id") REFERENCES "public"."broadcasts"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_broadcast_fk" FOREIGN KEY ("tenant_id","broadcast_id") REFERENCES "public"."broadcasts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_created_by_admin_id_admins_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_launched_by_admin_id_admins_id_fk" FOREIGN KEY ("launched_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_operation_items" ADD CONSTRAINT "bulk_operation_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_operation_items" ADD CONSTRAINT "bulk_operation_items_operation_fk" FOREIGN KEY ("tenant_id","bulk_operation_id") REFERENCES "public"."bulk_operations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_operation_items" ADD CONSTRAINT "bulk_operation_items_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_operation_items" ADD CONSTRAINT "bulk_operation_items_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_operation_items" ADD CONSTRAINT "bulk_operation_items_wallet_entry_fk" FOREIGN KEY ("tenant_id","wallet_entry_id") REFERENCES "public"."wallet_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_operation_items" ADD CONSTRAINT "bulk_operation_items_operation_row_fk" FOREIGN KEY ("tenant_id","provisioning_operation_id") REFERENCES "public"."provisioning_operations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_operations" ADD CONSTRAINT "bulk_operations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_operations" ADD CONSTRAINT "bulk_operations_created_by_admin_id_admins_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "broadcast_media_staged_idx" ON "broadcast_media" USING btree ("tenant_id","created_at") WHERE content IS NOT NULL;--> statement-breakpoint
CREATE INDEX "broadcast_recipients_due_idx" ON "broadcast_recipients" USING btree ("tenant_id","bot_instance_id","broadcast_id","customer_id") WHERE state = 'PENDING';--> statement-breakpoint
CREATE INDEX "broadcast_recipients_stranded_idx" ON "broadcast_recipients" USING btree ("lease_until") WHERE state = 'SENDING';--> statement-breakpoint
CREATE INDEX "broadcast_recipients_state_idx" ON "broadcast_recipients" USING btree ("tenant_id","broadcast_id","state","customer_id");--> statement-breakpoint
CREATE INDEX "broadcasts_tenant_created_idx" ON "broadcasts" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "broadcasts_scheduled_idx" ON "broadcasts" USING btree ("scheduled_at") WHERE state = 'SCHEDULED';--> statement-breakpoint
CREATE INDEX "broadcasts_sending_idx" ON "broadcasts" USING btree ("tenant_id") WHERE state = 'SENDING';--> statement-breakpoint
CREATE UNIQUE INDEX "bulk_operation_items_customer_key" ON "bulk_operation_items" USING btree ("tenant_id","bulk_operation_id","customer_id") WHERE service_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bulk_operation_items_service_key" ON "bulk_operation_items" USING btree ("tenant_id","bulk_operation_id","service_id") WHERE service_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "bulk_operation_items_pending_idx" ON "bulk_operation_items" USING btree ("tenant_id","bulk_operation_id","id") WHERE state = 'PENDING';--> statement-breakpoint
CREATE INDEX "bulk_operation_items_planned_idx" ON "bulk_operation_items" USING btree ("tenant_id","bulk_operation_id") WHERE state = 'PLANNED';--> statement-breakpoint
CREATE INDEX "bulk_operation_items_state_idx" ON "bulk_operation_items" USING btree ("tenant_id","bulk_operation_id","state","id");--> statement-breakpoint
CREATE INDEX "bulk_operations_tenant_created_idx" ON "bulk_operations" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "bulk_operations_running_idx" ON "bulk_operations" USING btree ("tenant_id") WHERE state = 'RUNNING';--> statement-breakpoint
CREATE INDEX "trial_grants_customer_idx" ON "trial_grants" USING btree ("tenant_id","customer_id");--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_kind_check" CHECK (kind IN ('PAYMENT_REJECTED', 'PAYMENT_EXPIRED', 'ORDER_EXPIRED', 'SERVICE_ACTION_SUCCEEDED', 'SERVICE_ACTION_FAILED', 'SERVICE_PROVISION_DELAYED', 'PAYMENT_TRANSFER_RECORDED', 'ORDER_CANCELLED', 'WALLET_TOPUP_CREDITED', 'ORDER_REFUNDED_TO_WALLET', 'SERVICE_EXPIRY_FIRST', 'SERVICE_EXPIRY_SECOND', 'SERVICE_EXPIRED', 'SERVICE_USAGE_FIRST', 'SERVICE_USAGE_SECOND', 'SERVICE_USAGE_FINAL', 'TRIAL_NOT_DELIVERED', 'RECEIPT_CREDITED_TO_WALLET', 'WALLET_TOPUP_GIFT_CREDITED', 'REFUND_COMPLETED', 'GATEWAY_PAYMENT_FAILED', 'SERVICE_REFUND_REQUEST_REGISTERED', 'SERVICE_REFUND_REQUEST_APPROVED', 'SERVICE_REFUND_REQUEST_REJECTED', 'SERVICE_TRANSFER_RECEIVED', 'TICKET_REPLY', 'SERVICE_EXPIRY_EARLY', 'SERVICE_EXPIRY_DAY', 'WALLET_LOW_BALANCE', 'PAYMENT_PENDING_REMINDER', 'ORDER_PENDING_REMINDER', 'TICKET_REPLY_ATTACHMENT', 'SERVICE_RENEWED', 'WALLET_MASS_CREDITED', 'SERVICE_GIFT_APPLIED'));--> statement-breakpoint
-- Backfill: round N's new permissions reach the system roles that already exist.
--
-- `ensureSystemRoles` writes a seed's permissions only when it CREATES the role, so a key
-- newly added to a seeded role reaches an existing installation only through a migration.
-- All three keys are NEW in this release: no installation can have withdrawn any of them, so
-- this deletes nothing and replaces nothing, and a DENY override still beats it because
-- resolution subtracts DENY last. `owner` holds every key; `observer` holds every LOW key,
-- and `broadcasts.view` and `bulk_operations.view` are LOW. `services.mass.grant` is CRITICAL
-- and reaches the owner alone.
--
-- The VALUES-join shape matches the earlier backfills, because the seed/backfill coverage
-- guard reads the PAIRS out of this statement.
INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
JOIN (VALUES
        ('owner', 'broadcasts.view'),
        ('owner', 'bulk_operations.view'),
        ('owner', 'services.mass.grant'),
        ('observer', 'broadcasts.view'),
        ('observer', 'bulk_operations.view')
     ) AS p("role_key", "key")
  ON p."role_key" = r."key"
WHERE r."is_system" = true
ON CONFLICT DO NOTHING;
