CREATE TABLE "support_ai_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"requested_by_admin_id" uuid,
	"idempotency_key" text NOT NULL,
	"state" text DEFAULT 'QUEUED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_until" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"failure_code" text,
	"decision" text,
	"topic" text,
	"confidence" text,
	"ticket_action" text,
	"summary" text,
	"intent" text,
	"suggested_reply" text,
	"fact_refs" text[] DEFAULT '{}'::text[] NOT NULL,
	"fact_labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"provider" text,
	"model" text,
	"sent_outbound_id" uuid,
	"text_purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_ai_jobs_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "support_ai_jobs_kind_check" CHECK (kind IN ('ASSIST_DRAFT')),
	CONSTRAINT "support_ai_jobs_state_check" CHECK (state IN ('QUEUED', 'READY', 'FAILED', 'SENT', 'DISCARDED')),
	CONSTRAINT "support_ai_jobs_decision_check" CHECK (decision IN ('REPLY', 'ASK_CLARIFYING_QUESTION', 'HANDOFF', 'CREATE_OR_LINK_TICKET', 'NO_ACTION')),
	CONSTRAINT "support_ai_jobs_topic_check" CHECK (topic IN ('CONNECTION_TROUBLESHOOTING', 'APP_SETUP', 'SUBSCRIPTION_UPDATE', 'SERVICE_INFO', 'TRAFFIC_AND_EXPIRY', 'PLAN_INFO', 'KNOWN_ERROR', 'GREETING', 'REFUND', 'WALLET', 'PAYMENT_DISPUTE', 'PAYMENT_STATUS', 'RECEIPT_REVIEW', 'SERVICE_DELETE_OR_TERMINATE', 'OWNERSHIP_OR_ACCOUNT_TRANSFER', 'ACCOUNT_SECURITY', 'CREDENTIALS', 'PROVIDER_CHANGE', 'FRAUD_OR_CHARGEBACK', 'LEGAL_OR_SAFETY', 'HUMAN_REQUESTED', 'OTHER')),
	CONSTRAINT "support_ai_jobs_confidence_check" CHECK (confidence IN ('LOW', 'MEDIUM', 'HIGH')),
	CONSTRAINT "support_ai_jobs_ticket_action_check" CHECK (ticket_action IN ('NONE', 'CREATE', 'LINK')),
	CONSTRAINT "support_ai_jobs_provider_check" CHECK (provider IN ('OPENAI', 'ANTHROPIC', 'ZAI')),
	CONSTRAINT "support_ai_jobs_result_shape_check" CHECK ((state IN ('READY', 'SENT')) <= (decision IS NOT NULL OR text_purged_at IS NOT NULL)),
	CONSTRAINT "support_ai_jobs_sent_check" CHECK ((state = 'SENT') = (sent_outbound_id IS NOT NULL)),
	CONSTRAINT "support_ai_jobs_reply_check" CHECK (suggested_reply IS NULL OR length(suggested_reply) <= 4000),
	CONSTRAINT "support_ai_jobs_summary_check" CHECK (summary IS NULL OR length(summary) <= 600),
	CONSTRAINT "support_ai_jobs_attempts_check" CHECK (attempts >= 0)
);
--> statement-breakpoint
ALTER TABLE "support_ai_jobs" ADD CONSTRAINT "support_ai_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ai_jobs" ADD CONSTRAINT "support_ai_jobs_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."business_conversations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ai_jobs" ADD CONSTRAINT "support_ai_jobs_admin_fk" FOREIGN KEY ("tenant_id","requested_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "support_ai_jobs_idempotency_key" ON "support_ai_jobs" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "support_ai_jobs_due_idx" ON "support_ai_jobs" USING btree ("tenant_id","created_at") WHERE state = 'QUEUED';--> statement-breakpoint
CREATE INDEX "support_ai_jobs_conversation_idx" ON "support_ai_jobs" USING btree ("tenant_id","conversation_id","created_at");