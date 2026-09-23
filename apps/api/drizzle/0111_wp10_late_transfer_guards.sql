-- WP10 P1: a late-transfer decision is a record, made once, about the right payment.
-- `docs/wp10-payments-audit.md` P1.
--
-- 1. `late_transfer_decisions` is append-only: no UPDATE, no DELETE. A decision is made
--    once and every item leaves the late-review lane through exactly one; an edited
--    decision is money that moved on one answer and is recorded under another. A wrong
--    credit is corrected by a new ledger entry, never by rewriting this row.
--
-- 2. A decision is refused on a payment that is not an EXPIRED manual transfer. The lane
--    is defined in the service; this is the same rule where a writer that skipped the
--    service meets it. An EXPIRED payment is terminal, so the fact cannot change after
--    the insert that checked it.
--
-- 3. A CREDIT carries the payment's own amount and currency, and names a LATE_TRANSFER
--    ledger entry for that payment of that same amount. A CHECK cannot read another
--    table, which is why this is a trigger: it is what makes "the payment's exact amount"
--    a property of the data rather than of one code path.
--
-- Tests reset with TRUNCATE, which bypasses row triggers, deliberately.
--
-- Hand-written because drizzle-kit does not model triggers, and it adds nothing the
-- schema file describes, so it does not affect the drift check.

CREATE TRIGGER late_transfer_decisions_no_update
  BEFORE UPDATE ON late_transfer_decisions
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER late_transfer_decisions_no_delete
  BEFORE DELETE ON late_transfer_decisions
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION nexa_late_transfer_decision_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  paid RECORD;
  entry RECORD;
BEGIN
  SELECT state, method, amount, currency
    INTO paid
    FROM payments
   WHERE tenant_id = NEW.tenant_id AND id = NEW.payment_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'a late-transfer decision names a payment that does not exist'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF paid.state <> 'EXPIRED' OR paid.method <> 'MANUAL_TRANSFER' THEN
    RAISE EXCEPTION 'a late-transfer decision is made only about an EXPIRED manual transfer, not a % % payment',
      paid.state, paid.method
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.decision = 'CREDITED' THEN
    IF NEW.amount IS DISTINCT FROM paid.amount OR NEW.currency IS DISTINCT FROM paid.currency THEN
      RAISE EXCEPTION 'a late-transfer credit is the payment''s exact amount'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT reason, payment_id, direction, amount, currency
      INTO entry
      FROM wallet_entries
     WHERE tenant_id = NEW.tenant_id AND id = NEW.wallet_entry_id;

    IF NOT FOUND
       OR entry.reason <> 'LATE_TRANSFER'
       OR entry.direction <> 'CREDIT'
       OR entry.payment_id IS DISTINCT FROM NEW.payment_id
       OR entry.amount IS DISTINCT FROM NEW.amount
       OR entry.currency IS DISTINCT FROM NEW.currency THEN
      RAISE EXCEPTION 'a late-transfer credit names the LATE_TRANSFER credit it wrote for this payment'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER late_transfer_decisions_guard
  BEFORE INSERT ON late_transfer_decisions
  FOR EACH ROW EXECUTE FUNCTION nexa_late_transfer_decision_guard();
