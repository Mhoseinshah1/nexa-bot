ALTER TABLE "support_learning_candidates" ALTER COLUMN "source_outbound_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "support_learning_jobs" ALTER COLUMN "source_outbound_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "support_learning_candidates" ADD COLUMN "source_message_id" uuid;--> statement-breakpoint
ALTER TABLE "support_learning_jobs" ADD COLUMN "source_message_id" uuid;--> statement-breakpoint
ALTER TABLE "support_learning_jobs" ADD CONSTRAINT "support_learning_jobs_message_fk" FOREIGN KEY ("tenant_id","source_message_id") REFERENCES "public"."business_messages"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_learning_candidates" ADD CONSTRAINT "support_learning_candidates_source_check" CHECK (num_nonnulls(source_outbound_id, source_message_id) = 1);--> statement-breakpoint
ALTER TABLE "support_learning_jobs" ADD CONSTRAINT "support_learning_jobs_source_check" CHECK (num_nonnulls(source_outbound_id, source_message_id) = 1);