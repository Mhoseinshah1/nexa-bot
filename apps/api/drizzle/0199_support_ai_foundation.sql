CREATE TABLE "support_ai_configs" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'OFF' NOT NULL,
	"primary_provider" text,
	"primary_model" text,
	"fallbacks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"vision_enabled" boolean DEFAULT false NOT NULL,
	"timeout_ms" integer NOT NULL,
	"max_output_chars" integer NOT NULL,
	"max_consecutive_replies" integer NOT NULL,
	"cooldown_seconds" integer NOT NULL,
	"settle_delay_seconds" integer DEFAULT 6 NOT NULL,
	"tone_instructions" text DEFAULT '' NOT NULL,
	"updated_by_admin_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_ai_configs_mode_check" CHECK (mode IN ('OFF', 'ASSIST_ONLY', 'AUTO_REPLY_SAFE')),
	CONSTRAINT "support_ai_configs_primary_provider_check" CHECK (primary_provider IN ('OPENAI', 'ANTHROPIC', 'ZAI')),
	CONSTRAINT "support_ai_configs_primary_shape_check" CHECK ((primary_provider IS NULL) = (primary_model IS NULL)),
	CONSTRAINT "support_ai_configs_mode_provider_check" CHECK (mode = 'OFF' OR primary_provider IS NOT NULL),
	CONSTRAINT "support_ai_configs_fallbacks_check" CHECK (jsonb_typeof(fallbacks) = 'array' AND jsonb_array_length(fallbacks) <= 2),
	CONSTRAINT "support_ai_configs_timeout_check" CHECK (timeout_ms BETWEEN 5000 AND 120000),
	CONSTRAINT "support_ai_configs_output_check" CHECK (max_output_chars BETWEEN 200 AND 4000),
	CONSTRAINT "support_ai_configs_replies_check" CHECK (max_consecutive_replies BETWEEN 1 AND 20),
	CONSTRAINT "support_ai_configs_cooldown_check" CHECK (cooldown_seconds BETWEEN 0 AND 3600),
	CONSTRAINT "support_ai_configs_settle_check" CHECK (settle_delay_seconds BETWEEN 3 AND 30),
	CONSTRAINT "support_ai_configs_tone_check" CHECK (length(tone_instructions) <= 2000),
	CONSTRAINT "support_ai_configs_version_check" CHECK (version >= 1)
);
--> statement-breakpoint
CREATE TABLE "support_ai_provider_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"api_key_ciphertext" text NOT NULL,
	"api_key_key_id" text NOT NULL,
	"api_key_set_at" timestamp with time zone NOT NULL,
	"region" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"tripped_until" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"last_test_outcome" text,
	"last_tested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_ai_provider_credentials_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "support_ai_provider_credentials_provider_check" CHECK (provider IN ('OPENAI', 'ANTHROPIC', 'ZAI')),
	CONSTRAINT "support_ai_provider_credentials_region_check" CHECK (region IS NULL OR (provider = 'ZAI' AND region IN ('INTERNATIONAL', 'CHINA'))),
	CONSTRAINT "support_ai_provider_credentials_test_outcome_check" CHECK (last_test_outcome IN ('OK', 'RATE_LIMITED', 'AUTH_FAILED', 'TEMPORARY', 'INVALID_OUTPUT', 'REFUSED_BY_PROVIDER', 'TIMEOUT')),
	CONSTRAINT "support_ai_provider_credentials_failures_check" CHECK (consecutive_failures >= 0)
);
--> statement-breakpoint
CREATE TABLE "support_ai_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid,
	"operation" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"attempt_index" integer NOT NULL,
	"latency_ms" integer NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"outcome" text NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_ai_runs_operation_check" CHECK (operation IN ('CONNECTION_TEST', 'ASSIST_DRAFT', 'AUTO_DECISION', 'SUMMARY', 'LEARNING_EXTRACT')),
	CONSTRAINT "support_ai_runs_provider_check" CHECK (provider IN ('OPENAI', 'ANTHROPIC', 'ZAI')),
	CONSTRAINT "support_ai_runs_outcome_check" CHECK (outcome IN ('OK', 'RATE_LIMITED', 'AUTH_FAILED', 'TEMPORARY', 'INVALID_OUTPUT', 'REFUSED_BY_PROVIDER', 'TIMEOUT')),
	CONSTRAINT "support_ai_runs_attempt_check" CHECK (attempt_index BETWEEN 0 AND 2),
	CONSTRAINT "support_ai_runs_latency_check" CHECK (latency_ms >= 0),
	CONSTRAINT "support_ai_runs_model_check" CHECK (length(model) BETWEEN 1 AND 128)
);
--> statement-breakpoint
ALTER TABLE "support_ai_configs" ADD CONSTRAINT "support_ai_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ai_configs" ADD CONSTRAINT "support_ai_configs_admin_fk" FOREIGN KEY ("tenant_id","updated_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ai_provider_credentials" ADD CONSTRAINT "support_ai_provider_credentials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ai_runs" ADD CONSTRAINT "support_ai_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ai_runs" ADD CONSTRAINT "support_ai_runs_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."business_conversations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "support_ai_provider_credentials_provider_key" ON "support_ai_provider_credentials" USING btree ("tenant_id","provider");--> statement-breakpoint
CREATE INDEX "support_ai_runs_tenant_created_idx" ON "support_ai_runs" USING btree ("tenant_id","created_at");