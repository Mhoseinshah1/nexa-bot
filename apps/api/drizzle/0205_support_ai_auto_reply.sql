CREATE TABLE "business_conversation_escalations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"control_epoch" integer NOT NULL,
	"reason" text NOT NULL,
	"summary" text,
	"ticket_id" uuid,
	"ticket_outcome" text NOT NULL,
	"job_id" uuid,
	"text_purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_conversation_escalations_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "business_conversation_escalations_reason_check" CHECK (reason IN ('SEND_OUTCOME_UNKNOWN', 'TRANSPORT_REFUSED', 'AI_REQUESTED', 'HANDOFF_TOPIC', 'HUMAN_REQUESTED', 'TOPIC_NOT_ALLOWED', 'LOW_CONFIDENCE', 'REPLY_OUT_OF_BOUNDS', 'DECISION_NOT_REPLY', 'AI_OUTPUT_INVALID', 'AI_UNAVAILABLE', 'ACCOUNT_UNDER_REVIEW', 'IDENTITY_UNVERIFIED', 'CUSTOMER_BLOCKED', 'INSUFFICIENT_GROUNDING', 'LOOP_GUARD', 'UNSUPPORTED_CONTENT')),
	CONSTRAINT "business_conversation_escalations_ticket_outcome_check" CHECK (ticket_outcome IN ('CREATED', 'LINKED', 'NO_CUSTOMER', 'CUSTOMER_BLOCKED', 'NO_CATEGORY', 'SCOPE_INACTIVE')),
	CONSTRAINT "business_conversation_escalations_ticket_shape_check" CHECK ((ticket_outcome IN ('CREATED', 'LINKED')) = (ticket_id IS NOT NULL)),
	CONSTRAINT "business_conversation_escalations_summary_check" CHECK (summary IS NULL OR length(summary) <= 600),
	CONSTRAINT "business_conversation_escalations_epoch_check" CHECK (control_epoch >= 1)
);
--> statement-breakpoint
ALTER TABLE "business_conversations" DROP CONSTRAINT "business_conversations_handoff_reason_check";--> statement-breakpoint
ALTER TABLE "support_ai_jobs" DROP CONSTRAINT "support_ai_jobs_kind_check";--> statement-breakpoint
ALTER TABLE "ticket_messages" DROP CONSTRAINT "ticket_messages_system_event_check";--> statement-breakpoint
ALTER TABLE "business_conversations" ADD COLUMN "ticket_id" uuid;--> statement-breakpoint
ALTER TABLE "support_ai_configs" ADD COLUMN "auto_topics" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "support_ai_configs" ADD COLUMN "auto_min_confidence" text DEFAULT 'HIGH' NOT NULL;--> statement-breakpoint
ALTER TABLE "support_ai_jobs" ADD COLUMN "trigger_telegram_message_id" bigint;--> statement-breakpoint
ALTER TABLE "support_ai_jobs" ADD COLUMN "trigger_content_version" integer;--> statement-breakpoint
ALTER TABLE "support_ai_jobs" ADD COLUMN "control_epoch" integer;--> statement-breakpoint
ALTER TABLE "support_ai_jobs" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "support_ai_jobs" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "support_ai_jobs" ADD COLUMN "handoff_reason" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "origin" text DEFAULT 'BOT' NOT NULL;--> statement-breakpoint
ALTER TABLE "business_conversation_escalations" ADD CONSTRAINT "business_conversation_escalations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_conversation_escalations" ADD CONSTRAINT "business_conversation_escalations_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."business_conversations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_conversation_escalations" ADD CONSTRAINT "business_conversation_escalations_ticket_fk" FOREIGN KEY ("tenant_id","ticket_id") REFERENCES "public"."tickets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "business_conversation_escalations_epoch_key" ON "business_conversation_escalations" USING btree ("tenant_id","conversation_id","control_epoch");--> statement-breakpoint
CREATE INDEX "business_conversation_escalations_ticket_idx" ON "business_conversation_escalations" USING btree ("tenant_id","ticket_id");--> statement-breakpoint
ALTER TABLE "business_conversations" ADD CONSTRAINT "business_conversations_ticket_fk" FOREIGN KEY ("tenant_id","ticket_id") REFERENCES "public"."tickets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "support_ai_jobs_auto_pending_key" ON "support_ai_jobs" USING btree ("tenant_id","conversation_id") WHERE kind = 'AUTO_DECISION' AND state = 'QUEUED';--> statement-breakpoint
ALTER TABLE "business_conversations" ADD CONSTRAINT "business_conversations_handoff_reason_check" CHECK (handoff_reason IN ('SEND_OUTCOME_UNKNOWN', 'TRANSPORT_REFUSED', 'AI_REQUESTED', 'HANDOFF_TOPIC', 'HUMAN_REQUESTED', 'TOPIC_NOT_ALLOWED', 'LOW_CONFIDENCE', 'REPLY_OUT_OF_BOUNDS', 'DECISION_NOT_REPLY', 'AI_OUTPUT_INVALID', 'AI_UNAVAILABLE', 'ACCOUNT_UNDER_REVIEW', 'IDENTITY_UNVERIFIED', 'CUSTOMER_BLOCKED', 'INSUFFICIENT_GROUNDING', 'LOOP_GUARD', 'UNSUPPORTED_CONTENT'));--> statement-breakpoint
ALTER TABLE "support_ai_configs" ADD CONSTRAINT "support_ai_configs_auto_topics_check" CHECK (cardinality(auto_topics) = 0 OR (cardinality(auto_topics) > 0 AND auto_topics <@ ARRAY['CONNECTION_TROUBLESHOOTING', 'APP_SETUP', 'SUBSCRIPTION_UPDATE', 'SERVICE_INFO', 'TRAFFIC_AND_EXPIRY', 'PLAN_INFO', 'KNOWN_ERROR', 'GREETING']::text[]));--> statement-breakpoint
ALTER TABLE "support_ai_configs" ADD CONSTRAINT "support_ai_configs_auto_confidence_check" CHECK (auto_min_confidence IN ('MEDIUM', 'HIGH'));--> statement-breakpoint
ALTER TABLE "support_ai_jobs" ADD CONSTRAINT "support_ai_jobs_outcome_check" CHECK (outcome IS NULL OR outcome IN ('sent', 'dropped_mode', 'dropped_epoch', 'dropped_state', 'dropped_coalesced', 'dropped_connection', 'dropped_scope', 'guard_content', 'guard_customer_blocked', 'guard_consecutive', 'guard_window', 'guard_decision', 'guard_handoff_topic', 'guard_human_requested', 'guard_topic_allowlist', 'guard_identity', 'guard_account_review', 'guard_confidence', 'guard_reply_bounds', 'guard_grounding', 'handoff_ai_requested', 'handoff_output_invalid', 'handoff_ai_unavailable'));--> statement-breakpoint
ALTER TABLE "support_ai_jobs" ADD CONSTRAINT "support_ai_jobs_handoff_reason_check" CHECK (handoff_reason IS NULL OR handoff_reason IN ('SEND_OUTCOME_UNKNOWN', 'TRANSPORT_REFUSED', 'AI_REQUESTED', 'HANDOFF_TOPIC', 'HUMAN_REQUESTED', 'TOPIC_NOT_ALLOWED', 'LOW_CONFIDENCE', 'REPLY_OUT_OF_BOUNDS', 'DECISION_NOT_REPLY', 'AI_OUTPUT_INVALID', 'AI_UNAVAILABLE', 'ACCOUNT_UNDER_REVIEW', 'IDENTITY_UNVERIFIED', 'CUSTOMER_BLOCKED', 'INSUFFICIENT_GROUNDING', 'LOOP_GUARD', 'UNSUPPORTED_CONTENT'));--> statement-breakpoint
ALTER TABLE "support_ai_jobs" ADD CONSTRAINT "support_ai_jobs_auto_shape_check" CHECK ((kind = 'AUTO_DECISION') = (trigger_telegram_message_id IS NOT NULL)
          AND (kind = 'AUTO_DECISION') = (control_epoch IS NOT NULL)
          AND (kind = 'AUTO_DECISION') = (due_at IS NOT NULL)
          AND (kind = 'AUTO_DECISION') = (trigger_content_version IS NOT NULL)
          AND (kind <> 'AUTO_DECISION' OR requested_by_admin_id IS NULL)
          AND (kind = 'AUTO_DECISION' OR outcome IS NULL));--> statement-breakpoint
ALTER TABLE "support_ai_jobs" ADD CONSTRAINT "support_ai_jobs_kind_check" CHECK (kind IN ('ASSIST_DRAFT', 'AUTO_DECISION'));--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_system_event_check" CHECK (system_event IS NULL OR system_event IN ('CLOSED_BY_CUSTOMER', 'CLOSED_BY_SUPPORT', 'REOPENED_BY_SUPPORT', 'ESCALATED_FROM_BUSINESS_CHAT'));--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_origin_check" CHECK (origin IN ('BOT', 'BUSINESS_CHAT'));