ALTER TABLE "support_ai_jobs" ADD COLUMN "failure_class" text;--> statement-breakpoint
ALTER TABLE "support_ai_provider_credentials" ADD COLUMN "last_test_failure_class" text;--> statement-breakpoint
ALTER TABLE "support_ai_runs" ADD COLUMN "job_id" uuid;--> statement-breakpoint
ALTER TABLE "support_ai_runs" ADD COLUMN "failure_class" text;--> statement-breakpoint
ALTER TABLE "support_ai_runs" ADD COLUMN "http_status" integer;--> statement-breakpoint
ALTER TABLE "support_ai_runs" ADD COLUMN "provider_error_code" text;--> statement-breakpoint
ALTER TABLE "support_ai_runs" ADD COLUMN "provider_error_type" text;--> statement-breakpoint
ALTER TABLE "support_ai_runs" ADD COLUMN "provider_error_param" text;--> statement-breakpoint
ALTER TABLE "support_ai_runs" ADD COLUMN "schema_issue_path" text;--> statement-breakpoint
ALTER TABLE "support_ai_runs" ADD COLUMN "schema_issue_code" text;--> statement-breakpoint
ALTER TABLE "support_ai_runs" ADD CONSTRAINT "support_ai_runs_job_fk" FOREIGN KEY ("tenant_id","job_id") REFERENCES "public"."support_ai_jobs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_ai_runs_job_idx" ON "support_ai_runs" USING btree ("tenant_id","job_id") WHERE job_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "support_ai_jobs" ADD CONSTRAINT "support_ai_jobs_failure_class_check" CHECK (failure_class IS NULL OR failure_class IN ('request_rejected', 'unsupported_capability', 'auth', 'quota', 'rate_limited', 'timeout', 'network', 'provider_error', 'refused', 'no_content', 'truncated', 'not_json', 'schema_invalid', 'reply_too_long', 'no_provider'));--> statement-breakpoint
ALTER TABLE "support_ai_provider_credentials" ADD CONSTRAINT "support_ai_provider_credentials_test_failure_class_check" CHECK (last_test_failure_class IS NULL OR last_test_failure_class IN ('request_rejected', 'unsupported_capability', 'auth', 'quota', 'rate_limited', 'timeout', 'network', 'provider_error', 'refused', 'no_content', 'truncated', 'not_json', 'schema_invalid', 'reply_too_long', 'no_provider'));--> statement-breakpoint
ALTER TABLE "support_ai_provider_credentials" ADD CONSTRAINT "support_ai_provider_credentials_test_failure_shape_check" CHECK (last_test_outcome IS DISTINCT FROM 'OK' OR last_test_failure_class IS NULL);--> statement-breakpoint
ALTER TABLE "support_ai_runs" ADD CONSTRAINT "support_ai_runs_failure_class_check" CHECK (failure_class IS NULL OR failure_class IN ('request_rejected', 'unsupported_capability', 'auth', 'quota', 'rate_limited', 'timeout', 'network', 'provider_error', 'refused', 'no_content', 'truncated', 'not_json', 'schema_invalid', 'reply_too_long', 'no_provider'));--> statement-breakpoint
ALTER TABLE "support_ai_runs" ADD CONSTRAINT "support_ai_runs_failure_shape_check" CHECK (outcome <> 'OK' OR failure_class IS NULL);--> statement-breakpoint
ALTER TABLE "support_ai_runs" ADD CONSTRAINT "support_ai_runs_http_status_check" CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599);--> statement-breakpoint
ALTER TABLE "support_ai_runs" ADD CONSTRAINT "support_ai_runs_provider_error_check" CHECK ((provider_error_code IS NULL OR length(provider_error_code) <= 64)
          AND (provider_error_type IS NULL OR length(provider_error_type) <= 64)
          AND (provider_error_param IS NULL OR length(provider_error_param) <= 64)
          AND (schema_issue_path IS NULL OR length(schema_issue_path) <= 128)
          AND (schema_issue_code IS NULL OR length(schema_issue_code) <= 64));