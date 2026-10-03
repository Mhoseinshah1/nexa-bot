CREATE TABLE "client_app_videos" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_app_id" uuid NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	"file_id" text NOT NULL,
	"file_unique_id" text NOT NULL,
	"mime_type" text,
	"duration_seconds" integer,
	"file_size" bigint,
	"set_by_admin_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_app_videos_file_check" CHECK (length(file_id) BETWEEN 1 AND 256
          AND length(file_unique_id) BETWEEN 1 AND 128
          AND (mime_type IS NULL OR length(mime_type) BETWEEN 1 AND 128)
          AND (duration_seconds IS NULL OR duration_seconds >= 0)
          AND (file_size IS NULL OR file_size > 0)),
	CONSTRAINT "client_app_videos_version_check" CHECK (version >= 1)
);
--> statement-breakpoint
ALTER TABLE "admin_amount_captures" DROP CONSTRAINT "admin_amount_captures_target_check";--> statement-breakpoint
ALTER TABLE "admin_amount_captures" DROP CONSTRAINT "admin_amount_captures_confirmed_check";--> statement-breakpoint
ALTER TABLE "admin_amount_captures" DROP CONSTRAINT "admin_amount_captures_purpose_check";--> statement-breakpoint
ALTER TABLE "admin_amount_captures" DROP CONSTRAINT "admin_amount_captures_purpose_column_check";--> statement-breakpoint
ALTER TABLE "admin_amount_captures" ADD COLUMN "client_app_id" uuid;--> statement-breakpoint
ALTER TABLE "client_app_videos" ADD CONSTRAINT "client_app_videos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_app_videos" ADD CONSTRAINT "client_app_videos_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_app_videos" ADD CONSTRAINT "client_app_videos_app_fk" FOREIGN KEY ("tenant_id","client_app_id") REFERENCES "public"."client_apps"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_app_videos" ADD CONSTRAINT "client_app_videos_admin_fk" FOREIGN KEY ("tenant_id","set_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "client_app_videos_app_bot_key" ON "client_app_videos" USING btree ("tenant_id","client_app_id","bot_instance_id");--> statement-breakpoint
ALTER TABLE "admin_amount_captures" ADD CONSTRAINT "admin_amount_captures_client_app_fk" FOREIGN KEY ("tenant_id","client_app_id") REFERENCES "public"."client_apps"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_amount_captures" ADD CONSTRAINT "admin_amount_captures_target_check" CHECK ((purpose IN ('RECEIPT_CREDIT_AMOUNT', 'RECEIPT_BLOCK_REASON', 'RECEIPT_REJECT_REASON')
            AND payment_id IS NOT NULL AND customer_id IS NULL AND service_refund_request_id IS NULL
            AND client_app_id IS NULL)
          OR (purpose = 'CUSTOMER_BLOCK_REASON' AND customer_id IS NOT NULL AND payment_id IS NULL
            AND service_refund_request_id IS NULL AND client_app_id IS NULL)
          OR (purpose IN ('SERVICE_REFUND_AMOUNT', 'SERVICE_REFUND_REJECT_REASON')
            AND service_refund_request_id IS NOT NULL AND payment_id IS NULL AND customer_id IS NULL
            AND client_app_id IS NULL)
          OR (purpose = 'CLIENT_APP_VIDEO' AND client_app_id IS NOT NULL AND payment_id IS NULL
            AND customer_id IS NULL AND service_refund_request_id IS NULL));--> statement-breakpoint
ALTER TABLE "admin_amount_captures" ADD CONSTRAINT "admin_amount_captures_confirmed_check" CHECK (close_reason IS DISTINCT FROM 'CONFIRMED'
          OR (purpose IN ('RECEIPT_CREDIT_AMOUNT', 'SERVICE_REFUND_AMOUNT') AND amount_minor IS NOT NULL)
          OR (purpose IN ('RECEIPT_BLOCK_REASON', 'RECEIPT_REJECT_REASON', 'CUSTOMER_BLOCK_REASON', 'SERVICE_REFUND_REJECT_REASON') AND reason IS NOT NULL)
          OR purpose = 'CLIENT_APP_VIDEO');--> statement-breakpoint
ALTER TABLE "admin_amount_captures" ADD CONSTRAINT "admin_amount_captures_purpose_check" CHECK (purpose IN ('RECEIPT_CREDIT_AMOUNT', 'RECEIPT_BLOCK_REASON', 'RECEIPT_REJECT_REASON', 'CUSTOMER_BLOCK_REASON', 'SERVICE_REFUND_AMOUNT', 'SERVICE_REFUND_REJECT_REASON', 'CLIENT_APP_VIDEO'));--> statement-breakpoint
ALTER TABLE "admin_amount_captures" ADD CONSTRAINT "admin_amount_captures_purpose_column_check" CHECK ((purpose IN ('RECEIPT_CREDIT_AMOUNT', 'SERVICE_REFUND_AMOUNT') AND reason IS NULL)
          OR (purpose IN ('RECEIPT_BLOCK_REASON', 'RECEIPT_REJECT_REASON', 'CUSTOMER_BLOCK_REASON', 'SERVICE_REFUND_REJECT_REASON') AND amount_minor IS NULL)
          OR (purpose = 'CLIENT_APP_VIDEO' AND amount_minor IS NULL AND reason IS NULL));