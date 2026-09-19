-- The order's third outcome is removed: FULFILLED or REFUNDED, and no other.
--
-- FORWARD-ONLY, not an edit of 0081. `0002_drop_callback_refs` is the worked
-- example and made exactly this argument for exactly this case — a shape added
-- in a migration that had not deployed, removed by a new migration rather than
-- by editing the old one, "even though nothing had deployed it and editing
-- would have left a cleaner history. The rule does not get an exception because
-- the case looks harmless."
--
-- WHY NO DATA STATEMENT PRECEDES THE CHECKS
--
-- Narrowing `orders_state_check` and `notifications_kind_check` fails if a row
-- holds a value they no longer admit. No released version can hold one:
-- `PAID_UNFULFILLED` and `ORDER_PAID_UNFULFILLED` were introduced by 0081 on
-- this branch and have never been merged or tagged, so the only databases that
-- can carry such a row are a developer's own and CI's, both of which are built
-- from zero. A backfill here would have to decide an outcome for money — and
-- deciding an outcome for money that does not exist is how a migration comes to
-- write a refund nobody owed.
--
-- The two columns 0081 added go with the state. `unfulfilled_at` and
-- `unfulfilled_reason` described a condition that no longer has a state to be
-- true in, and a nullable column with no writer is a column the next reader
-- believes.

ALTER TABLE "customer_notifications" DROP CONSTRAINT "customer_notifications_kind_check";--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_check";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_unfulfilled_at_check";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_unfulfilled_reason_check";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_state_check";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_settled_at_check";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "unfulfilled_at";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "unfulfilled_reason";--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_kind_check" CHECK (kind IN ('PAYMENT_REJECTED', 'PAYMENT_EXPIRED', 'ORDER_EXPIRED', 'SERVICE_ACTION_SUCCEEDED', 'SERVICE_ACTION_FAILED', 'SERVICE_PROVISION_DELAYED', 'PAYMENT_TRANSFER_RECORDED', 'ORDER_CANCELLED', 'WALLET_TOPUP_CREDITED', 'ORDER_REFUNDED_TO_WALLET'));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_check" CHECK (kind IN ('OPERATIONAL_EVENT', 'OPERATIONS_TEST', 'RECEIPT_AWAITING_REVIEW'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_state_check" CHECK (state IN ('DRAFT', 'AWAITING_PAYMENT', 'PAID', 'CANCELLED', 'EXPIRED', 'REFUNDED'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_settled_at_check" CHECK ((state IN ('PAID', 'REFUNDED')) = (settled_at IS NOT NULL));