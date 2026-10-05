DROP INDEX "business_conversations_inbox_idx";--> statement-breakpoint
CREATE INDEX "business_conversation_escalations_created_idx" ON "business_conversation_escalations" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "business_conversations_inbox_priority_idx" ON "business_conversations" USING btree ("tenant_id",("state" = 'HANDOFF_REQUIRED'),COALESCE("last_message_at", "created_at"),"id");--> statement-breakpoint
CREATE INDEX "support_ai_jobs_created_idx" ON "support_ai_jobs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "support_learning_candidates_created_idx" ON "support_learning_candidates" USING btree ("tenant_id","created_at","state");