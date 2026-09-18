-- A refund's money is frozen; its lifecycle moves. Enforced in the database.
--
-- Hand-written, like 0001, 0063 and 0067, because `drizzle-kit` generates from
-- `schema.ts` and does not model triggers. No snapshot accompanies it: it changes no
-- schema, so the drift check has nothing to compare.
--
-- WHY THIS IS NOT `payment_receipts`
--
-- 0067 forbids UPDATE on receipts outright, because a receipt's whole content is
-- evidence somebody looked at. A refund is different in exactly one way: its STATE is
-- meant to change — REQUESTED to AWAITING_EXTERNAL to COMPLETED — and forbidding UPDATE
-- would make the lifecycle impossible. So this follows `nexa_operational_events_guard`
-- instead: freeze everything that says WHAT was refunded, and let the lifecycle columns
-- move.
--
-- WHAT IS FROZEN, AND WHY EACH ONE
--
-- The payment, the customer, the order, the amount, the currency and the channel are the
-- refund's identity. A row whose amount could be edited after the fact is a reviewer's
-- evidence changing underneath the decision made on it — and worse, it would silently
-- move the payment's refundable balance, because that balance is DERIVED by summing
-- these amounts. An edit here creates or destroys money.
--
-- `requested_by_admin_id` is frozen too. Who decided a refund is not a field that gets
-- corrected; a refund attributed to the wrong operator is the legacy `/admin/logs`
-- problem, and the remedy is a new row rather than a rewrite.
--
-- `created_at` is frozen because a refund that could be back-dated is a refund that can
-- be hidden from a report bounded by time.
--
-- WHAT MAY MOVE
--
-- `state`, `completed_by_admin_id`, `completed_at`, `external_reference`,
-- `completion_note` and `updated_at`. Every one of them is written by a completion or a
-- failure, and the service reaches them only through a conditional UPDATE naming the
-- state it moves FROM.
--
-- DELETE IS FORBIDDEN OUTRIGHT
--
-- A refund that could be deleted would release its amount back to the refundable balance
-- with no record that it ever existed, which is the over-refund this whole design
-- prevents — achieved by deleting the evidence instead of by exceeding a bound. A refund
-- that should not have happened is FAILED, which is terminal, visible, and releases the
-- amount on the record.
--
-- Tests reset with TRUNCATE, which bypasses row triggers. That is deliberate and 0001
-- records it: the guard stays in force for application code.

CREATE OR REPLACE FUNCTION nexa_refunds_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.payment_id IS DISTINCT FROM OLD.payment_id
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.requested_by_admin_id IS DISTINCT FROM OLD.requested_by_admin_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'refunds rows are immutable except for state, completion and updated_at.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- A terminal refund is finished. `REFUND_TRANSITIONS` says the same thing in the
  -- contract and the service checks it, but this is where a hand-written UPDATE meets
  -- it — and the two states mean opposite things for the refundable balance, so a
  -- COMPLETED row quietly moved to FAILED would release money that has already left.
  IF OLD.state IN ('COMPLETED', 'FAILED') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION
      'refund % is already terminal (%); it cannot move to %.', OLD.id, OLD.state, NEW.state
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER refunds_freeze
  BEFORE UPDATE ON refunds
  FOR EACH ROW EXECUTE FUNCTION nexa_refunds_guard();
--> statement-breakpoint

CREATE TRIGGER refunds_no_delete
  BEFORE DELETE ON refunds
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
