ALTER TABLE "support_ai_configs" ALTER COLUMN "max_consecutive_replies" SET DEFAULT 4;--> statement-breakpoint
ALTER TABLE "support_ai_configs" ALTER COLUMN "max_consecutive_clarifying_questions" SET DEFAULT 3;--> statement-breakpoint
ALTER TABLE "support_ai_configs" ADD COLUMN "session_reply_budget" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "support_ai_configs" ADD COLUMN "max_auto_replies_per_hour" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "support_ai_configs" ADD CONSTRAINT "support_ai_configs_session_budget_check" CHECK (session_reply_budget BETWEEN 5 AND 40);--> statement-breakpoint
ALTER TABLE "support_ai_configs" ADD CONSTRAINT "support_ai_configs_hourly_limit_check" CHECK (max_auto_replies_per_hour BETWEEN 10 AND 60);