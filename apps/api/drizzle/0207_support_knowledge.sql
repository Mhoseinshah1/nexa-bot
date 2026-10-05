CREATE TABLE "support_knowledge_articles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source" text NOT NULL,
	"state" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"category" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"candidate_id" uuid,
	"created_by_admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_knowledge_articles_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "support_knowledge_articles_source_check" CHECK (source IN ('MANUAL', 'LEARNED', 'NEXA_BUILD')),
	CONSTRAINT "support_knowledge_articles_state_check" CHECK (state IN ('DRAFT', 'APPROVED', 'RETIRED')),
	CONSTRAINT "support_knowledge_articles_category_check" CHECK (category IN ('CONNECTION', 'APPS', 'PLANS', 'PAYMENTS', 'ACCOUNT', 'POLICY', 'GENERAL')),
	CONSTRAINT "support_knowledge_articles_title_check" CHECK (length(btrim(title)) BETWEEN 1 AND 200),
	CONSTRAINT "support_knowledge_articles_body_check" CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
	CONSTRAINT "support_knowledge_articles_tags_check" CHECK (cardinality(tags) <= 8),
	CONSTRAINT "support_knowledge_articles_version_check" CHECK (version >= 1 AND revision >= 0),
	CONSTRAINT "support_knowledge_articles_approved_check" CHECK (state <> 'APPROVED' OR revision >= 1),
	CONSTRAINT "support_knowledge_articles_learned_check" CHECK ((source = 'LEARNED') = (candidate_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "support_knowledge_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"origin" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"category" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"reviewer_admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_knowledge_revisions_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "support_knowledge_revisions_origin_check" CHECK (origin IN ('MANUAL', 'CANDIDATE', 'BUILD')),
	CONSTRAINT "support_knowledge_revisions_category_check" CHECK (category IN ('CONNECTION', 'APPS', 'PLANS', 'PAYMENTS', 'ACCOUNT', 'POLICY', 'GENERAL')),
	CONSTRAINT "support_knowledge_revisions_revision_check" CHECK (revision >= 1),
	CONSTRAINT "support_knowledge_revisions_title_check" CHECK (length(btrim(title)) BETWEEN 1 AND 200),
	CONSTRAINT "support_knowledge_revisions_body_check" CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
	CONSTRAINT "support_knowledge_revisions_tags_check" CHECK (cardinality(tags) <= 8)
);
--> statement-breakpoint
CREATE TABLE "support_learning_candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"title" text NOT NULL,
	"normalized_title" text NOT NULL,
	"body" text,
	"category" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"rationale" text,
	"confidence" text NOT NULL,
	"reject_reason" text,
	"sensitive_kinds" text[] DEFAULT '{}'::text[] NOT NULL,
	"conversation_id" uuid NOT NULL,
	"source_outbound_id" uuid NOT NULL,
	"source_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_count" integer DEFAULT 1 NOT NULL,
	"job_id" uuid NOT NULL,
	"provider" text,
	"model" text,
	"article_id" uuid,
	"reviewed_by_admin_id" uuid,
	"reviewed_at" timestamp with time zone,
	"text_purged_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_learning_candidates_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "support_learning_candidates_state_check" CHECK (state IN ('PENDING', 'APPROVED', 'REJECTED')),
	CONSTRAINT "support_learning_candidates_category_check" CHECK (category IN ('CONNECTION', 'APPS', 'PLANS', 'PAYMENTS', 'ACCOUNT', 'POLICY', 'GENERAL')),
	CONSTRAINT "support_learning_candidates_confidence_check" CHECK (confidence IN ('LOW', 'MEDIUM', 'HIGH')),
	CONSTRAINT "support_learning_candidates_reject_reason_check" CHECK (reject_reason IS NULL OR reject_reason IN ('REVIEWER', 'SENSITIVE_CONTENT')),
	CONSTRAINT "support_learning_candidates_sensitive_kinds_check" CHECK (sensitive_kinds <@ ARRAY['EMAIL', 'PHONE', 'CARD', 'IBAN', 'SUBSCRIPTION_LINK', 'URL_TOKEN', 'IP_ADDRESS', 'UUID', 'SECRET', 'USERNAME', 'AMOUNT', 'LONG_NUMBER', 'REDACTION_MARK']::text[]),
	CONSTRAINT "support_learning_candidates_provider_check" CHECK (provider IS NULL OR provider IN ('OPENAI', 'ANTHROPIC', 'ZAI')),
	CONSTRAINT "support_learning_candidates_reject_shape_check" CHECK ((state = 'REJECTED') = (reject_reason IS NOT NULL)),
	CONSTRAINT "support_learning_candidates_approve_shape_check" CHECK ((state = 'APPROVED') = (article_id IS NOT NULL)),
	CONSTRAINT "support_learning_candidates_reviewed_check" CHECK ((state = 'PENDING') = (reviewed_at IS NULL)),
	CONSTRAINT "support_learning_candidates_sensitive_shape_check" CHECK ((reject_reason IS NOT DISTINCT FROM 'SENSITIVE_CONTENT') = (cardinality(sensitive_kinds) > 0)
          AND (reject_reason IS DISTINCT FROM 'SENSITIVE_CONTENT' OR reviewed_by_admin_id IS NULL)),
	CONSTRAINT "support_learning_candidates_title_check" CHECK (length(btrim(title)) BETWEEN 1 AND 200 AND length(normalized_title) >= 1),
	CONSTRAINT "support_learning_candidates_body_check" CHECK (body IS NULL OR length(body) <= 4000),
	CONSTRAINT "support_learning_candidates_purge_check" CHECK (body IS NOT NULL OR text_purged_at IS NOT NULL),
	CONSTRAINT "support_learning_candidates_tags_check" CHECK (cardinality(tags) <= 8),
	CONSTRAINT "support_learning_candidates_counts_check" CHECK (source_count >= 1 AND version >= 1)
);
--> statement-breakpoint
CREATE TABLE "support_learning_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"source_outbound_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"requested_by_admin_id" uuid,
	"idempotency_key" text NOT NULL,
	"state" text DEFAULT 'QUEUED' NOT NULL,
	"outcome" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_until" timestamp with time zone,
	"candidate_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_learning_jobs_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "support_learning_jobs_trigger_check" CHECK (trigger IN ('HANDBACK', 'OPERATOR_PROPOSAL')),
	CONSTRAINT "support_learning_jobs_state_check" CHECK (state IN ('QUEUED', 'DONE', 'FAILED')),
	CONSTRAINT "support_learning_jobs_outcome_check" CHECK (outcome IS NULL OR outcome IN ('candidate_created', 'merged', 'auto_rejected', 'declined', 'dropped_mode', 'dropped_source', 'dropped_scope', 'output_invalid', 'ai_unavailable', 'attempts_exhausted')),
	CONSTRAINT "support_learning_jobs_outcome_shape_check" CHECK ((state = 'QUEUED') = (outcome IS NULL)),
	CONSTRAINT "support_learning_jobs_requester_check" CHECK ((trigger = 'OPERATOR_PROPOSAL') = (requested_by_admin_id IS NOT NULL)),
	CONSTRAINT "support_learning_jobs_attempts_check" CHECK (attempts >= 0)
);
--> statement-breakpoint
ALTER TABLE "support_knowledge_articles" ADD CONSTRAINT "support_knowledge_articles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_knowledge_articles" ADD CONSTRAINT "support_knowledge_articles_candidate_fk" FOREIGN KEY ("tenant_id","candidate_id") REFERENCES "public"."support_learning_candidates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_knowledge_articles" ADD CONSTRAINT "support_knowledge_articles_admin_fk" FOREIGN KEY ("tenant_id","created_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_knowledge_revisions" ADD CONSTRAINT "support_knowledge_revisions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_knowledge_revisions" ADD CONSTRAINT "support_knowledge_revisions_article_fk" FOREIGN KEY ("tenant_id","article_id") REFERENCES "public"."support_knowledge_articles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_knowledge_revisions" ADD CONSTRAINT "support_knowledge_revisions_reviewer_fk" FOREIGN KEY ("tenant_id","reviewer_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_learning_candidates" ADD CONSTRAINT "support_learning_candidates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_learning_candidates" ADD CONSTRAINT "support_learning_candidates_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."business_conversations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_learning_candidates" ADD CONSTRAINT "support_learning_candidates_reviewer_fk" FOREIGN KEY ("tenant_id","reviewed_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_learning_jobs" ADD CONSTRAINT "support_learning_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_learning_jobs" ADD CONSTRAINT "support_learning_jobs_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."business_conversations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_learning_jobs" ADD CONSTRAINT "support_learning_jobs_outbound_fk" FOREIGN KEY ("tenant_id","source_outbound_id") REFERENCES "public"."business_outbound_messages"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_learning_jobs" ADD CONSTRAINT "support_learning_jobs_admin_fk" FOREIGN KEY ("tenant_id","requested_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_knowledge_articles_active_idx" ON "support_knowledge_articles" USING btree ("tenant_id","state","enabled","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "support_knowledge_articles_candidate_key" ON "support_knowledge_articles" USING btree ("tenant_id","candidate_id") WHERE candidate_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "support_knowledge_revisions_article_key" ON "support_knowledge_revisions" USING btree ("tenant_id","article_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "support_learning_candidates_title_key" ON "support_learning_candidates" USING btree ("tenant_id","normalized_title");--> statement-breakpoint
CREATE INDEX "support_learning_candidates_queue_idx" ON "support_learning_candidates" USING btree ("tenant_id","state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "support_learning_jobs_idempotency_key" ON "support_learning_jobs" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "support_learning_jobs_due_idx" ON "support_learning_jobs" USING btree ("tenant_id","created_at") WHERE state = 'QUEUED';--> statement-breakpoint
CREATE INDEX "support_learning_jobs_conversation_idx" ON "support_learning_jobs" USING btree ("tenant_id","conversation_id","created_at");