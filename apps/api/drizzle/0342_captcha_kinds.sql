ALTER TABLE "customer_captchas" DROP CONSTRAINT "customer_captchas_options_check";--> statement-breakpoint
ALTER TABLE "customer_captchas" ADD COLUMN "kind" text DEFAULT 'MATH' NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_captchas" ADD COLUMN "answer_text" text;--> statement-breakpoint
ALTER TABLE "customer_captchas" ADD COLUMN "refreshes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_captchas" ADD CONSTRAINT "customer_captchas_kind_check" CHECK (kind IN ('MATH', 'IMAGE_NUMBER', 'EMOJI', 'WORD_NUMBER'));--> statement-breakpoint
ALTER TABLE "customer_captchas" ADD CONSTRAINT "customer_captchas_answer_text_check" CHECK ((kind = 'IMAGE_NUMBER') = (answer_text IS NOT NULL) AND (answer_text IS NULL OR answer_text ~ '^[0-9]{4}$'));--> statement-breakpoint
ALTER TABLE "customer_captchas" ADD CONSTRAINT "customer_captchas_refreshes_check" CHECK (refreshes BETWEEN 0 AND 3);--> statement-breakpoint
ALTER TABLE "customer_captchas" ADD CONSTRAINT "customer_captchas_options_check" CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) = CASE WHEN kind = 'IMAGE_NUMBER' THEN 0 ELSE 4 END);