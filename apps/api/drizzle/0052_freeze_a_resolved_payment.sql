-- A payment that ended is frozen, whichever way it ended.
--
-- `nexa_payments_confirmation_guard` has opened with `IF OLD.state = 'CONFIRMED'`
-- since 0033. Until this release that covered every terminal state a payment could
-- actually reach, because CONFIRMED was the only one anything could produce:
-- `PaymentRepository` offered `confirm` and no other write.
--
-- 4G makes FAILED, CANCELLED and EXPIRED reachable, and the guard's condition stops
-- being complete the moment it does. A resolved payment left unguarded can be moved
-- back to PENDING by any UPDATE — `payments_state_check` is an enum membership test
-- and would not notice — and a rejected transfer that is PENDING again is a transfer
-- an operator can be asked to approve for a second time.
--
-- The application does not do that: every transition 4G adds is a conditional UPDATE
-- naming its `from` states, which is the rule this repository holds everywhere. The
-- reason that is not sufficient is `botctl rollback`, which never restores the
-- database. An installation rolled back to yesterday's image keeps today's rows, so
-- the binary writing them is one that predates the rule. A guard in the schema is the
-- only one an old binary cannot be missing — the same argument 0049 and 0050 record
-- for the commercial actions.
--
-- `CREATE OR REPLACE`, so this is a forward-only replacement of the function body and
-- the trigger created by 0033 is untouched. The CONFIRMED branch is carried across
-- unchanged, including 0035's reviewer and note: a replacement that restated it would
-- be a chance to drop a field from the list.
--
-- `external_reference` is not frozen in either branch, for 0035's stated reason: an
-- identifier learned during a later reconciliation is the one fact that legitimately
-- arrives after the outcome.
--
-- The function keeps its name. It guards resolution as well as confirmation now and a
-- more accurate one exists, but renaming it means dropping and recreating the trigger
-- in the same migration that changes what it enforces — two things to get right where
-- there was one, on the object that stands between a rolled-back binary and somebody's
-- money.
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
  ) THEN
    RAISE EXCEPTION
      'a payment that was rejected, withdrawn or expired cannot be reopened, and its money, customer, order and resolution are immutable.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
