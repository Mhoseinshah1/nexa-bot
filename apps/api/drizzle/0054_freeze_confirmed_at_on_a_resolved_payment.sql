-- 0053 closed three of the four columns 0052 left open, and missed the fourth.
--
-- The resolved branch now freezes `evidence_kind`, `evidence_note` and
-- `confirmed_by_admin_id` — and not `confirmed_at`. An UPDATE that changes only that
-- one passes the trigger, and passes `payments_confirmed_check` too: that constraint is
-- `(state = 'CONFIRMED') = (confirmed_at IS NOT NULL AND evidence_kind IS NOT NULL)`,
-- and with `evidence_kind` still NULL the right-hand side stays false for a FAILED,
-- CANCELLED or EXPIRED row however the timestamp moves.
--
-- What that leaves is a terminal payment carrying a confirmation time — a rejected
-- transfer that reads as though somebody confirmed it at a moment somebody chose. It is
-- the same defect 0053 was written for, one column further along, and it is the second
-- time this guard's column list has been shorter than the rule its message states.
--
-- Found by the Codex review of PR #29, after the self-review had found the other three.
-- Recorded that way because the pattern is the finding: a guard that enumerates columns
-- is a guard whose omissions are invisible until somebody lists them against the table.
--
-- CREATE OR REPLACE, forward-only, the trigger from 0033 untouched, and 0033/0035's
-- CONFIRMED branch carried across verbatim for the third time — a replacement that
-- restated it would be a chance to drop a field from it.
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
    OR NEW.evidence_kind IS DISTINCT FROM OLD.evidence_kind
    OR NEW.evidence_note IS DISTINCT FROM OLD.evidence_note
    OR NEW.confirmed_by_admin_id IS DISTINCT FROM OLD.confirmed_by_admin_id
    -- The one 0053 missed. A resolved payment never had a confirmation time, and
    -- acquiring one is the appearance of a confirmation that never happened.
    OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
  ) THEN
    RAISE EXCEPTION
      'a payment that was rejected, withdrawn or expired cannot be reopened, and its money, customer, order, evidence and resolution are immutable.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
