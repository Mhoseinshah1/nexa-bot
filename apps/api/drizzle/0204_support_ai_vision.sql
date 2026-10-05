CREATE TABLE "support_ai_image_outcomes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"media_type" text,
	"byte_size" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_ai_image_outcomes_outcome_check" CHECK (outcome IN ('PROCESSED', 'SKIPPED')),
	CONSTRAINT "support_ai_image_outcomes_reason_check" CHECK (reason IN ('VISION_DISABLED', 'NO_VISION_CAPABILITY', 'OVER_LIMIT', 'NO_FILE_REFERENCE', 'TOO_LARGE', 'UNSUPPORTED_TYPE', 'DOWNLOAD_FAILED', 'NOT_ANSWERED')),
	CONSTRAINT "support_ai_image_outcomes_shape_check" CHECK ((outcome = 'PROCESSED') = (reason IS NULL)),
	CONSTRAINT "support_ai_image_outcomes_media_type_check" CHECK (media_type IS NULL OR media_type IN ('image/jpeg', 'image/png', 'image/webp')),
	CONSTRAINT "support_ai_image_outcomes_size_check" CHECK (byte_size IS NULL OR byte_size >= 0)
);
--> statement-breakpoint
ALTER TABLE "business_messages" ADD COLUMN "photo_file_id" text;--> statement-breakpoint
ALTER TABLE "business_messages" ADD COLUMN "photo_file_unique_id" text;--> statement-breakpoint
ALTER TABLE "business_messages" ADD COLUMN "photo_file_size" integer;--> statement-breakpoint
ALTER TABLE "support_ai_jobs" ADD COLUMN "images_seen" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "support_ai_jobs" ADD COLUMN "images_unseen" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "support_ai_jobs" ADD COLUMN "unseen_image_handoff" text;--> statement-breakpoint
ALTER TABLE "support_ai_image_outcomes" ADD CONSTRAINT "support_ai_image_outcomes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ai_image_outcomes" ADD CONSTRAINT "support_ai_image_outcomes_job_fk" FOREIGN KEY ("tenant_id","job_id") REFERENCES "public"."support_ai_jobs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ai_image_outcomes" ADD CONSTRAINT "support_ai_image_outcomes_message_fk" FOREIGN KEY ("tenant_id","message_id") REFERENCES "public"."business_messages"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_ai_image_outcomes_job_idx" ON "support_ai_image_outcomes" USING btree ("tenant_id","job_id");--> statement-breakpoint
CREATE INDEX "support_ai_image_outcomes_created_idx" ON "support_ai_image_outcomes" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "business_messages" ADD CONSTRAINT "business_messages_photo_shape_check" CHECK ((photo_file_id IS NULL) = (photo_file_unique_id IS NULL) AND (photo_file_id IS NULL OR kind = 'PHOTO') AND (photo_file_size IS NULL OR photo_file_id IS NOT NULL));--> statement-breakpoint
ALTER TABLE "business_messages" ADD CONSTRAINT "business_messages_photo_bounds_check" CHECK ((photo_file_id IS NULL OR length(photo_file_id) BETWEEN 1 AND 256) AND (photo_file_unique_id IS NULL OR length(photo_file_unique_id) BETWEEN 1 AND 128) AND (photo_file_size IS NULL OR photo_file_size >= 0));--> statement-breakpoint
ALTER TABLE "business_messages" ADD CONSTRAINT "business_messages_photo_deleted_check" CHECK (deleted_at IS NULL OR photo_file_id IS NULL);--> statement-breakpoint
ALTER TABLE "support_ai_jobs" ADD CONSTRAINT "support_ai_jobs_images_check" CHECK (images_seen >= 0 AND images_unseen >= 0);--> statement-breakpoint
ALTER TABLE "support_ai_jobs" ADD CONSTRAINT "support_ai_jobs_unseen_image_handoff_check" CHECK (unseen_image_handoff IN ('VISION_DISABLED', 'NO_VISION_CAPABILITY', 'OVER_LIMIT', 'NO_FILE_REFERENCE', 'TOO_LARGE', 'UNSUPPORTED_TYPE', 'DOWNLOAD_FAILED', 'NOT_ANSWERED'));--> statement-breakpoint
ALTER TABLE "support_ai_jobs" ADD CONSTRAINT "support_ai_jobs_unseen_image_handoff_shape_check" CHECK (unseen_image_handoff IS NULL OR (decision IS NOT DISTINCT FROM 'HANDOFF' AND provider IS NULL AND model IS NULL AND summary IS NULL AND images_seen = 0 AND (suggested_reply IS NOT DISTINCT FROM '' OR (suggested_reply IS NULL AND text_purged_at IS NOT NULL))));