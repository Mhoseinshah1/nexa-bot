DROP INDEX "support_learning_candidates_title_key";--> statement-breakpoint
ALTER TABLE "support_learning_candidates" ADD COLUMN "replaces_article_id" uuid;--> statement-breakpoint
ALTER TABLE "support_learning_candidates" ADD COLUMN "assisted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "support_learning_candidates_title_key" ON "support_learning_candidates" USING btree ("tenant_id","normalized_title") WHERE state = 'PENDING';