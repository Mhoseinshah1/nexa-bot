-- `reason` joins the frozen set, which is what 0073 already claimed it had done.
--
-- 0073's own exception message reads "refunds rows are immutable except for state,
-- completion and updated_at", and `reason` is none of those three — but it was left out
-- of the comparison, so a hand-written `UPDATE refunds SET reason = ...` rewrote the
-- operator's recorded justification for a refund already requested, or already completed
-- and paid out. A guard whose message overstates what it enforces is worse than one that
-- enforces nothing, because a reader stops checking.
--
-- `reason` is why money left, recorded by the person who authorised it leaving. It is
-- exactly the financial evidence this trigger exists to protect from writers that bypass
-- the service, and `RefundRepository.transition` never touches it — the only columns it
-- sets are `state`, the three completion fields and `updated_at`. So nothing in the
-- application is refused by this, and no backfill is needed.
--
-- Forward-only: 0073 is not edited. `CREATE OR REPLACE FUNCTION` re-points the existing
-- `refunds_freeze` trigger, which keeps its name and its timing. The second IF is
-- restated verbatim rather than referenced, because a replaced body is the WHOLE body:
-- dropping that half here would silently un-enforce it.

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
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.requested_by_admin_id IS DISTINCT FROM OLD.requested_by_admin_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'refunds rows are immutable except for state, completion and updated_at.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.state IN ('COMPLETED', 'FAILED') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION
      'refund % is already terminal (%); it cannot move to %.', OLD.id, OLD.state, NEW.state
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
