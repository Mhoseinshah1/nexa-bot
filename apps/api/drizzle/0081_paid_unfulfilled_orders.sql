ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_check";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_state_check";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_settled_at_check";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "unfulfilled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "unfulfilled_reason" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_check" CHECK (kind IN ('OPERATIONAL_EVENT', 'OPERATIONS_TEST', 'RECEIPT_AWAITING_REVIEW', 'ORDER_PAID_UNFULFILLED'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_unfulfilled_at_check" CHECK (state <> 'PAID_UNFULFILLED' OR unfulfilled_at IS NOT NULL);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_unfulfilled_reason_check" CHECK (state <> 'PAID_UNFULFILLED' OR unfulfilled_reason IS NOT NULL);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_state_check" CHECK (state IN ('DRAFT', 'AWAITING_PAYMENT', 'PAID', 'PAID_UNFULFILLED', 'CANCELLED', 'EXPIRED', 'REFUNDED'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_settled_at_check" CHECK ((state IN ('PAID', 'PAID_UNFULFILLED', 'REFUNDED')) = (settled_at IS NOT NULL));