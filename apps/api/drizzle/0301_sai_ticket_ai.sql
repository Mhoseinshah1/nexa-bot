CREATE TABLE "support_ai_ticket_holds" (
	"tenant_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"state" text NOT NULL,
	"epoch" integer DEFAULT 0 NOT NULL,
	"handoff_kind" text,
	"handoff_reason" text,
	"held_at" timestamp with time zone NOT NULL,
	"last_human_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_ai_ticket_holds_pkey" PRIMARY KEY("tenant_id","ticket_id"),
	CONSTRAINT "support_ai_ticket_holds_state_check" CHECK (state IN ('AI_ACTIVE', 'HANDOFF_REQUIRED', 'HUMAN_ACTIVE')),
	CONSTRAINT "support_ai_ticket_holds_kind_check" CHECK (handoff_kind IS NULL OR handoff_kind IN ('HARD', 'SOFT')),
	CONSTRAINT "support_ai_ticket_holds_reason_check" CHECK (handoff_reason IS NULL OR handoff_reason IN ('SEND_OUTCOME_UNKNOWN', 'TRANSPORT_REFUSED', 'AI_REQUESTED', 'HANDOFF_TOPIC', 'HUMAN_REQUESTED', 'TOPIC_NOT_ALLOWED', 'LOW_CONFIDENCE', 'REPLY_OUT_OF_BOUNDS', 'DECISION_NOT_REPLY', 'AI_OUTPUT_INVALID', 'AI_UNAVAILABLE', 'ACCOUNT_UNDER_REVIEW', 'IDENTITY_UNVERIFIED', 'CUSTOMER_BLOCKED', 'INSUFFICIENT_GROUNDING', 'LOOP_GUARD', 'UNSUPPORTED_CONTENT', 'REPLY_STALE', 'CLARIFYING_LIMIT', 'NO_PROGRESS', 'REPEATED_ADVICE', 'INBOUND_FLOOD', 'OUTPUT_POLICY', 'SUSPICIOUS_PROBING', 'CUSTOMER_UNSATISFIED')),
	CONSTRAINT "support_ai_ticket_holds_epoch_check" CHECK (epoch >= 0),
	CONSTRAINT "support_ai_ticket_holds_shape_check" CHECK ((state = 'AI_ACTIVE') = (handoff_kind IS NULL))
);
--> statement-breakpoint
CREATE TABLE "support_ai_ticket_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"trigger_message_id" uuid NOT NULL,
	"epoch" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" text DEFAULT 'QUEUED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_until" timestamp with time zone,
	"due_at" timestamp with time zone NOT NULL,
	"outcome" text,
	"decision" text,
	"topic" text,
	"confidence" text,
	"handoff_reason" text,
	"failure_class" text,
	"tool_action" text,
	"provider" text,
	"model" text,
	"reply_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_ai_ticket_jobs_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "support_ai_ticket_jobs_state_check" CHECK (state IN ('QUEUED', 'DONE')),
	CONSTRAINT "support_ai_ticket_jobs_outcome_check" CHECK (outcome IS NULL OR outcome IN ('sent', 'sent_clarifying', 'dropped_mode', 'dropped_epoch', 'dropped_state', 'dropped_coalesced', 'dropped_connection', 'dropped_scope', 'guard_content', 'guard_customer_blocked', 'guard_consecutive', 'guard_window', 'guard_decision', 'guard_handoff_topic', 'guard_human_requested', 'guard_topic_allowlist', 'guard_identity', 'guard_account_review', 'guard_confidence', 'guard_reply_bounds', 'guard_grounding', 'guard_clarifying_limit', 'handoff_ai_requested', 'handoff_output_invalid', 'handoff_ai_unavailable', 'handoff_stale', 'guard_no_progress', 'guard_repeated_advice', 'guard_inbound_flood', 'no_action', 'guard_output_policy', 'guard_refusal_abuse', 'sent_link', 'guard_tool_scope', 'guard_tool_rate_limit', 'sent_payment_delivered', 'sent_payment_ask', 'handoff_payment_checked', 'sent_unsupported_content')),
	CONSTRAINT "support_ai_ticket_jobs_decision_check" CHECK (decision IN ('REPLY', 'ASK_CLARIFYING_QUESTION', 'HANDOFF', 'CREATE_OR_LINK_TICKET', 'NO_ACTION')),
	CONSTRAINT "support_ai_ticket_jobs_topic_check" CHECK (topic IN ('CONNECTION_TROUBLESHOOTING', 'APP_SETUP', 'SUBSCRIPTION_UPDATE', 'SERVICE_INFO', 'TRAFFIC_AND_EXPIRY', 'PLAN_INFO', 'KNOWN_ERROR', 'GREETING', 'PURCHASE_INFO', 'RENEWAL_INFO', 'ADDON_INFO', 'TRIAL_INFO', 'LOCATION_INFO', 'SPEED_QUALITY', 'GET_SUBSCRIPTION_LINK', 'PAYMENT_HOWTO', 'POLICY_REFUSAL', 'REFUND', 'WALLET', 'PAYMENT_DISPUTE', 'PAYMENT_STATUS', 'RECEIPT_REVIEW', 'SERVICE_DELETE_OR_TERMINATE', 'OWNERSHIP_OR_ACCOUNT_TRANSFER', 'ACCOUNT_SECURITY', 'CREDENTIALS', 'PROVIDER_CHANGE', 'FRAUD_OR_CHARGEBACK', 'LEGAL_OR_SAFETY', 'HUMAN_REQUESTED', 'OTHER')),
	CONSTRAINT "support_ai_ticket_jobs_confidence_check" CHECK (confidence IN ('LOW', 'MEDIUM', 'HIGH')),
	CONSTRAINT "support_ai_ticket_jobs_provider_check" CHECK (provider IN ('OPENAI', 'ANTHROPIC', 'ZAI')),
	CONSTRAINT "support_ai_ticket_jobs_handoff_reason_check" CHECK (handoff_reason IS NULL OR handoff_reason IN ('SEND_OUTCOME_UNKNOWN', 'TRANSPORT_REFUSED', 'AI_REQUESTED', 'HANDOFF_TOPIC', 'HUMAN_REQUESTED', 'TOPIC_NOT_ALLOWED', 'LOW_CONFIDENCE', 'REPLY_OUT_OF_BOUNDS', 'DECISION_NOT_REPLY', 'AI_OUTPUT_INVALID', 'AI_UNAVAILABLE', 'ACCOUNT_UNDER_REVIEW', 'IDENTITY_UNVERIFIED', 'CUSTOMER_BLOCKED', 'INSUFFICIENT_GROUNDING', 'LOOP_GUARD', 'UNSUPPORTED_CONTENT', 'REPLY_STALE', 'CLARIFYING_LIMIT', 'NO_PROGRESS', 'REPEATED_ADVICE', 'INBOUND_FLOOD', 'OUTPUT_POLICY', 'SUSPICIOUS_PROBING', 'CUSTOMER_UNSATISFIED')),
	CONSTRAINT "support_ai_ticket_jobs_failure_class_check" CHECK (failure_class IS NULL OR failure_class IN ('request_rejected', 'unsupported_capability', 'auth', 'quota', 'rate_limited', 'timeout', 'network', 'provider_error', 'refused', 'no_content', 'truncated', 'not_json', 'schema_invalid', 'reply_too_long', 'no_provider')),
	CONSTRAINT "support_ai_ticket_jobs_tool_action_check" CHECK (tool_action IS NULL OR (tool_action <> 'NONE' AND tool_action IN ('NONE', 'SEND_SUBSCRIPTION_LINK', 'PAYMENT_STATUS', 'BUY', 'RENEW', 'ADD_TRAFFIC', 'ADD_TIME', 'CHANGE_LOCATION', 'TRIAL', 'ROTATE_LINK', 'WALLET_TOPUP'))),
	CONSTRAINT "support_ai_ticket_jobs_attempts_check" CHECK (attempts >= 0 AND epoch >= 0),
	CONSTRAINT "support_ai_ticket_jobs_done_check" CHECK ((state = 'DONE') = (outcome IS NOT NULL) AND (reply_message_id IS NULL OR state = 'DONE')),
	CONSTRAINT "support_ai_ticket_jobs_key_check" CHECK (length(idempotency_key) BETWEEN 1 AND 300)
);
--> statement-breakpoint
ALTER TABLE "ticket_messages" DROP CONSTRAINT "ticket_messages_sender_check";--> statement-breakpoint
ALTER TABLE "ticket_messages" DROP CONSTRAINT "ticket_messages_shape_check";--> statement-breakpoint
ALTER TABLE "support_ai_ticket_holds" ADD CONSTRAINT "support_ai_ticket_holds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ai_ticket_holds" ADD CONSTRAINT "support_ai_ticket_holds_ticket_fk" FOREIGN KEY ("tenant_id","ticket_id") REFERENCES "public"."tickets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ai_ticket_jobs" ADD CONSTRAINT "support_ai_ticket_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ai_ticket_jobs" ADD CONSTRAINT "support_ai_ticket_jobs_ticket_fk" FOREIGN KEY ("tenant_id","ticket_id") REFERENCES "public"."tickets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ai_ticket_jobs" ADD CONSTRAINT "support_ai_ticket_jobs_trigger_fk" FOREIGN KEY ("tenant_id","trigger_message_id") REFERENCES "public"."ticket_messages"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ai_ticket_jobs" ADD CONSTRAINT "support_ai_ticket_jobs_reply_fk" FOREIGN KEY ("tenant_id","reply_message_id") REFERENCES "public"."ticket_messages"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "support_ai_ticket_jobs_idempotency_key" ON "support_ai_ticket_jobs" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "support_ai_ticket_jobs_pending_key" ON "support_ai_ticket_jobs" USING btree ("tenant_id","ticket_id") WHERE state = 'QUEUED';--> statement-breakpoint
CREATE INDEX "support_ai_ticket_jobs_due_idx" ON "support_ai_ticket_jobs" USING btree ("tenant_id","created_at") WHERE state = 'QUEUED';--> statement-breakpoint
CREATE INDEX "support_ai_ticket_jobs_ticket_idx" ON "support_ai_ticket_jobs" USING btree ("tenant_id","ticket_id","created_at");--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_sender_check" CHECK (sender_type IN ('CUSTOMER', 'ADMIN', 'SYSTEM', 'AI'));--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_shape_check" CHECK (CASE sender_type
            WHEN 'CUSTOMER' THEN author_admin_id IS NULL AND system_event IS NULL
                 AND (body IS NOT NULL OR attachment_kind IS NOT NULL) AND idempotency_key IS NOT NULL
            WHEN 'ADMIN' THEN author_admin_id IS NOT NULL AND system_event IS NULL
                 AND body IS NOT NULL AND attachment_kind IS NULL AND idempotency_key IS NOT NULL
            WHEN 'SYSTEM' THEN author_admin_id IS NULL AND system_event IS NOT NULL
                 AND body IS NULL AND attachment_kind IS NULL
            WHEN 'AI' THEN author_admin_id IS NULL AND system_event IS NULL
                 AND body IS NOT NULL AND attachment_kind IS NULL AND idempotency_key IS NOT NULL
            ELSE false
          END);