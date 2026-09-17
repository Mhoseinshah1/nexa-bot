-- Phase 5B: what makes a wallet top-up credit exactly one credit.
--
-- Generated from `schema.ts`, so the drift check covers all three statements.
--
-- WHY THE UNIQUE INDEX IS IN THE MIGRATION AND NOT IN `ONLINE_INDEXES`
--
-- That list exists because `botctl update` migrates while the OUTGOING release is
-- still serving, and an ordinary CREATE INDEX holds a SHARE lock for the whole build.
-- Every index there is a PERFORMANCE index, and a query that is briefly slow is a
-- different thing from a rule that is briefly absent: this one enforces "one
-- TOPUP_RECEIPT credit per payment", and the code that relies on it ships in the same
-- release. Built concurrently after the fact it could also finish INVALID, which is a
-- uniqueness rule that looks present and enforces nothing.
--
-- The cost is bounded and stated: the predicate matches NO existing row on any
-- installation — `TOPUP_RECEIPT` has been in `LEDGER_REASONS` since Phase 0 with no
-- producer — so the build is a single scan with nothing to sort.
--
-- The CHECK widening is the notification lane admitting `WALLET_TOPUP_CREDITED`. Drop
-- and re-add is how a CHECK changes; both halves are in this one transaction, so no
-- window exists in which the column accepts a kind outside the enum.

ALTER TABLE "customer_notifications" DROP CONSTRAINT "customer_notifications_kind_check";--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_entries_topup_payment_key" ON "wallet_entries" USING btree ("tenant_id","payment_id") WHERE reason = 'TOPUP_RECEIPT';--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_kind_check" CHECK (kind IN ('PAYMENT_REJECTED', 'PAYMENT_EXPIRED', 'ORDER_EXPIRED', 'SERVICE_ACTION_SUCCEEDED', 'SERVICE_ACTION_FAILED', 'SERVICE_PROVISION_DELAYED', 'PAYMENT_TRANSFER_RECORDED', 'ORDER_CANCELLED', 'WALLET_TOPUP_CREDITED'));--> statement-breakpoint
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_topup_payment_check" CHECK (reason <> 'TOPUP_RECEIPT' OR payment_id IS NOT NULL);