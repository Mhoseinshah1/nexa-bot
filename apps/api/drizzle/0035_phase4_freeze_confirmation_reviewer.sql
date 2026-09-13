-- The reviewer is part of the evidence.
--
-- 0033's payment guard froze a confirmed payment's money, customer, order, method,
-- reference, evidence kind and confirmation time — and left `confirmed_by_admin_id`
-- and `evidence_note` editable. That undoes the thing the guard exists for.
--
-- The guard's own reason, quoted from the schema: the legacy receipt review records
-- neither the reviewer nor the time (UNK-PR-010), so "was this approved by a human"
-- is unanswerable there. A reviewer id that can be reassigned after the fact answers
-- that question with whoever was written last, which is worse than not answering: it
-- looks like a record.
--
-- `evidence_note` goes too. A note that can be rewritten after the money moved is not
-- evidence of why it moved. There is no legitimate caller that needs to: a
-- reconciliation writes its note while the payment is still UNKNOWN, so this guard does
-- not apply to it.
--
-- `external_reference` stays mutable, for that same reason stated the other way round:
-- a gateway identifier learned during reconciliation is the one fact that legitimately
-- arrives after confirmation.
--
-- Found by the automated security review of the schema commit. CREATE OR REPLACE, so
-- this is a forward-only replacement of the function body and no trigger is touched.
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
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
