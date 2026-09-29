ALTER TABLE "client_apps" ADD COLUMN "image_content" "bytea";--> statement-breakpoint
ALTER TABLE "client_apps" ADD COLUMN "image_mime_type" text;--> statement-breakpoint
ALTER TABLE "client_apps" ADD COLUMN "image_byte_length" integer;--> statement-breakpoint
ALTER TABLE "client_apps" ADD COLUMN "image_width" integer;--> statement-breakpoint
ALTER TABLE "client_apps" ADD COLUMN "image_height" integer;--> statement-breakpoint
ALTER TABLE "client_apps" ADD COLUMN "image_sha256" text;--> statement-breakpoint
ALTER TABLE "client_apps" ADD COLUMN "image_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "client_apps" ADD CONSTRAINT "client_apps_image_check" CHECK ((image_content IS NULL AND image_mime_type IS NULL AND image_byte_length IS NULL
            AND image_width IS NULL AND image_height IS NULL AND image_sha256 IS NULL
            AND image_updated_at IS NULL)
          OR (image_content IS NOT NULL AND image_mime_type IS NOT NULL
            AND image_byte_length IS NOT NULL AND image_width IS NOT NULL
            AND image_height IS NOT NULL AND image_sha256 IS NOT NULL
            AND image_updated_at IS NOT NULL
            AND image_mime_type IN ('image/png', 'image/jpeg')
            AND image_byte_length BETWEEN 1 AND 524288
            AND image_byte_length = octet_length(image_content)
            AND image_width BETWEEN 16 AND 2048
            AND image_height BETWEEN 16 AND 2048
            AND image_sha256 ~ '^[0-9a-f]{64}$'));