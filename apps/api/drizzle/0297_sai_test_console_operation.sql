-- Phase 4 PR-5: a new run operation, TEST_CONSOLE. The CHECK is added NOT VALID, then VALIDATEd
-- (support_ai_runs is a large table; scripts/check-migration-ddl.mjs). Only hand edit of the
-- generated SQL; journal and snapshot are untouched.
ALTER TABLE "support_ai_runs" DROP CONSTRAINT "support_ai_runs_operation_check";--> statement-breakpoint
ALTER TABLE "support_ai_runs" ADD CONSTRAINT "support_ai_runs_operation_check" CHECK (operation IN ('CONNECTION_TEST', 'ASSIST_DRAFT', 'AUTO_DECISION', 'SUMMARY', 'LEARNING_EXTRACT', 'TEST_CONSOLE')) NOT VALID;--> statement-breakpoint
ALTER TABLE "support_ai_runs" VALIDATE CONSTRAINT "support_ai_runs_operation_check";
