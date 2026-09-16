-- 0052's resolved branch was narrower than the rule it states.
--
-- It freezes a resolved payment's state, money, customer, order, method, reference and
-- the three resolution columns, and leaves `evidence_kind`, `evidence_note` and
-- `confirmed_by_admin_id` writable on a FAILED, CANCELLED or EXPIRED row.
--
-- `payments_confirmed_check` does not close that: it is an equality between `state =
-- 'CONFIRMED'` and `confirmed_at IS NOT NULL AND evidence_kind IS NOT NULL`, so setting
-- `evidence_kind` alone, or an `evidence_note`, on a resolved row satisfies it — both
-- sides stay false while the row acquires the appearance of a review that never
-- happened. A rejected payment reading `evidence_kind = 'OPERATOR_REVIEW'` with a note
-- beside it is exactly the shape an operator would read as an approval.
--
-- No binary in this release writes that. The whole argument for 0052 is the binary that
-- is NOT this release: `botctl rollback` never restores the database, so the process
-- writing today's rows may predate the rule, and a guard that lists eight of eleven
-- columns is a guard whose omissions are the ones an old binary can still reach.
--
-- Found by the self-review of the Phase 4G diff, which is the round that also found the
-- guard's message claiming more than its condition did.
--
-- CREATE OR REPLACE, forward-only, the trigger from 0033 untouched, and 0033/0035's
-- CONFIRMED branch carried across verbatim — a replacement that restated it would be a
-- chance to drop a field from it.
--
-- `external_reference` stays writable in both branches, for 0035's stated reason: an
-- identifier learned during a later reconciliation is the one fact that legitimately
-- arrives after the outcome.
CREATE OR REPLACE FUNCTION nexa_payments_confirmation_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.state = 'CONFIRMED' AND (
       NEW.amount IS DISTINCT FROM OLD.amount
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
    OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.method IS DISTINCT FROM OLD.method
    OR NEW.reference IS DISTINCT FROM OLD.reference
    OR NEW.evidence_kind IS DISTINCT FROM OLD.evidence_kind
    OR NEW.evidence_note IS DISTINCT FROM OLD.evidence_note
    OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
    OR NEW.confirmed_by_admin_id IS DISTINCT FROM OLD.confirmed_by_admin_id
    OR NEW.state IS DISTINCT FROM OLD.state
  ) THEN
    RAISE EXCEPTION
      'a confirmed payment''s money, customer, order, method and evidence — including who confirmed it — are immutable.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.state IN ('FAILED', 'CANCELLED', 'EXPIRED') AND (
       NEW.state IS DISTINCT FROM OLD.state
    OR NEW.amount IS DISTINCT FROM OLD.amount
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
    OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.method IS DISTINCT FROM OLD.method
    OR NEW.reference IS DISTINCT FROM OLD.reference
    OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
    OR NEW.resolved_by_admin_id IS DISTINCT FROM OLD.resolved_by_admin_id
    OR NEW.resolution_note IS DISTINCT FROM OLD.resolution_note
    -- The three 0052 left out. A resolved payment never acquired any of them, and
    -- acquiring one later is the appearance of a review that did not happen.
    OR NEW.evidence_kind IS DISTINCT FROM OLD.evidence_kind
    OR NEW.evidence_note IS DISTINCT FROM OLD.evidence_note
    OR NEW.confirmed_by_admin_id IS DISTINCT FROM OLD.confirmed_by_admin_id
  ) THEN
    RAISE EXCEPTION
      'a payment that was rejected, withdrawn or expired cannot be reopened, and its money, customer, order, evidence and resolution are immutable.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
