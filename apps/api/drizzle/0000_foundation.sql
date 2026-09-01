CREATE TABLE "aggregate_sequences" (
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"last_sequence" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"actor_label" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"correlation_id" text NOT NULL,
	"request_id" text,
	"source_surface" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"result" text NOT NULL,
	CONSTRAINT "audit_logs_actor_type_check" CHECK (actor_type IN ('CUSTOMER', 'TELEGRAM_ADMIN', 'WEB_ADMIN', 'SYSTEM_JOB', 'API', 'PROVIDER_SYNC')),
	CONSTRAINT "audit_logs_result_check" CHECK (result IN ('SUCCESS', 'DENIED', 'FAILED')),
	CONSTRAINT "audit_logs_surface_check" CHECK (source_surface IN ('TELEGRAM', 'WEB', 'WORKER', 'SCHEDULER', 'API'))
);
--> statement-breakpoint
CREATE TABLE "bot_instances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"username" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"token_ciphertext" text NOT NULL,
	"token_key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_instances_status_check" CHECK (status IN ('ACTIVE', 'STOPPED', 'DISABLED'))
);
--> statement-breakpoint
CREATE TABLE "callback_refs" (
	"ref" text PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bot_instance_id" uuid,
	"flow" text NOT NULL,
	"step" text NOT NULL,
	"payload" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operational_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid,
	"code" text NOT NULL,
	"severity" text NOT NULL,
	"message" text NOT NULL,
	"context" jsonb,
	"dedupe_key" text,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"correlation_id" text,
	"recovers_code" text,
	CONSTRAINT "operational_events_severity_check" CHECK (severity IN ('DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL')),
	CONSTRAINT "operational_events_occurrence_check" CHECK (occurrence_count >= 1)
);
--> statement-breakpoint
CREATE TABLE "outbox_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"event_type" text NOT NULL,
	"event_version" integer DEFAULT 1 NOT NULL,
	"payload" jsonb NOT NULL,
	"actor" jsonb NOT NULL,
	"correlation_id" text NOT NULL,
	"causation_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_messages_sequence_check" CHECK (sequence >= 1),
	CONSTRAINT "outbox_messages_attempts_check" CHECK (attempts >= 0)
);
--> statement-breakpoint
CREATE TABLE "processed_messages" (
	"consumer" text NOT NULL,
	"message_id" uuid NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_idempotency" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope_ref" text NOT NULL,
	"tenant_id" uuid,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"parent_tenant_id" uuid,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"locale" text DEFAULT 'fa' NOT NULL,
	"display_timezone" text DEFAULT 'Asia/Tehran' NOT NULL,
	"calendar" text DEFAULT 'jalali' NOT NULL,
	"currency" text DEFAULT 'IRT' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_kind_check" CHECK (kind IN ('PRIMARY', 'RESELLER_BOT')),
	CONSTRAINT "tenants_status_check" CHECK (status IN ('ACTIVE', 'STOPPED', 'DISABLED')),
	CONSTRAINT "tenants_calendar_check" CHECK (calendar IN ('gregorian', 'jalali')),
	CONSTRAINT "tenants_currency_check" CHECK (currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "tenants_parent_check" CHECK ((kind = 'PRIMARY' AND parent_tenant_id IS NULL) OR (kind <> 'PRIMARY' AND parent_tenant_id IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "bot_instances" ADD CONSTRAINT "bot_instances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "callback_refs" ADD CONSTRAINT "callback_refs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "callback_refs" ADD CONSTRAINT "callback_refs_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "aggregate_sequences_pkey" ON "aggregate_sequences" USING btree ("aggregate_type","aggregate_id");--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_occurred_idx" ON "audit_logs" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_logs_correlation_idx" ON "audit_logs" USING btree ("correlation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_instances_username_key" ON "bot_instances" USING btree ("username");--> statement-breakpoint
CREATE INDEX "bot_instances_tenant_idx" ON "bot_instances" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "callback_refs_expires_idx" ON "callback_refs" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "operational_events_tenant_seen_idx" ON "operational_events" USING btree ("tenant_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "operational_events_code_idx" ON "operational_events" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "operational_events_dedupe_key" ON "operational_events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_messages_aggregate_sequence_key" ON "outbox_messages" USING btree ("aggregate_type","aggregate_id","sequence");--> statement-breakpoint
CREATE INDEX "outbox_messages_unpublished_idx" ON "outbox_messages" USING btree ("occurred_at") WHERE published_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "processed_messages_pkey" ON "processed_messages" USING btree ("consumer","message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "request_idempotency_scope_key" ON "request_idempotency" USING btree ("scope_ref","key");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants" USING btree ("slug");