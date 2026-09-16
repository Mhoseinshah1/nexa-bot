-- A customer's claim to have paid cannot be stamped onto a payment that is already over.
--
-- 0057 adds `customer_signalled_at`. `nexa_payments_confirmation_guard` froze every
-- other column whose late change would be a lie, and this one belongs in the same list
-- for the same reason: a signal written after the outcome says a customer claimed to
-- have sent money at a moment when the payment was already confirmed, rejected,
-- withdrawn or expired. An operator reading the row afterwards could not tell that from
-- a claim made while it was live, and the claim is the only thing this column is for.
--
-- The application does not do that — `PaymentRepository.signalSent` is a conditional
-- UPDATE naming `state = 'PENDING'` and `customer_signalled_at IS NULL` — and that is
-- not sufficient, for the reason 0052 records at length: `botctl rollback` never
-- restores the database, so an installation rolled back to yesterday's image keeps
-- today's rows and the binary writing them predates the rule. A guard in the schema is
-- the only one an old binary cannot be missing.
--
-- `CREATE OR REPLACE`, so the trigger created by 0033 is untouched and this is a
-- forward-only replacement of the function body. Everything 0052, 0053 and 0054 put in
-- the two branches is carried across unchanged and verbatim: a replacement that
-- restated it from memory is a chance to drop a column from the list.
--
-- `customer_signalled_at` is added to BOTH branches. A confirmed payment is the case
-- that matters most — a signal appearing after an operator approved the transfer would
-- read as though the approval preceded the claim it rests on.
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
    OR NEW.customer_signalled_at IS DISTINCT FROM OLD.customer_signalled_at
    OR NEW.state IS DISTINCT FROM OLD.state
  ) THEN
    RAISE EXCEPTION
      'a confirmed payment''s money, customer, order, method and evidence — including who confirmed it and what the customer claimed — are immutable.'
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
    OR NEW.customer_signalled_at IS DISTINCT FROM OLD.customer_signalled_at
  ) THEN
    RAISE EXCEPTION
      'a payment that was rejected, withdrawn or expired cannot be reopened, and its money, customer, order, evidence, resolution and the customer''s own claim are immutable.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
