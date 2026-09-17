-- Phase 5T: the operator notification lane admits a receipt awaiting review.
--
-- Generated from `schema.ts`, so the drift check covers it.
--
-- Drop and re-add is how a CHECK changes, and both halves are in this one
-- transaction — there is no window in which the column accepts a kind outside the
-- enum. The predicate admits one more value and forbids nothing that was allowed, so
-- no existing row can violate it and the validation scan finds nothing to reject.
--
-- What this does NOT do is widen `customer_notifications_kind_check`. That enum is the
-- CUSTOMER lane's and this kind is addressed to an administrator; the two lanes have
-- separate tables, separate dispatchers and separate closed sets, and the whole point
-- of ADR 0030 is that the customer lane's set stays small.

ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_check";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_check" CHECK (kind IN ('OPERATIONAL_EVENT', 'OPERATIONS_TEST', 'RECEIPT_AWAITING_REVIEW'));