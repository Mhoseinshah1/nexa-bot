ALTER TABLE "service_refund_requests" ALTER COLUMN "bot_instance_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "service_refund_requests" ALTER COLUMN "reason" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "service_refund_requests" ADD COLUMN "origin" text DEFAULT 'CUSTOMER' NOT NULL;--> statement-breakpoint
ALTER TABLE "service_refund_requests" ADD CONSTRAINT "service_refund_requests_origin_check" CHECK (origin IN ('CUSTOMER', 'OPERATOR'));--> statement-breakpoint
ALTER TABLE "service_refund_requests" ADD CONSTRAINT "service_refund_requests_origin_shape_check" CHECK ((origin = 'CUSTOMER' AND reason IS NOT NULL AND bot_instance_id IS NOT NULL)
          OR (origin = 'OPERATOR' AND reason IS NULL AND bot_instance_id IS NULL
              AND state <> 'REJECTED'));