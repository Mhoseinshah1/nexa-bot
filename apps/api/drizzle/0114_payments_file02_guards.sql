-- Payment File 02: the guards drizzle-kit does not model (`docs/payments-file02-design.md`).
--
-- 1. `receipt_credits` is append-only: no UPDATE, no DELETE. A disposition is made once
--    and is the receipt's final one; an edited disposition is money that moved on one
--    answer and is recorded under another. A wrong credit is corrected by a new ledger
--    entry, never by rewriting this row.
--
-- 2. A disposition is refused unless it describes what actually happened, in the same
--    transaction that did it: the payment is a FAILED manual transfer resolved by the
--    same administrator, and the entry is that payment's `RECEIPT_CREDIT` CREDIT, to the
--    payment's customer, of exactly this amount in exactly the payment's currency. A CHECK
--    cannot read another table, which is why this is a trigger: it is what makes "the
--    amount the reviewer entered is the amount on the wallet" a property of the data
--    rather than of one code path.
--
-- 3. A payment's route snapshot — `gateway_provider` and `topup_cashback_percent` — is
--    frozen after insert, in EVERY state (D5). Payment File 02 §17: the terms a payment
--    was created under must not change under it, and a PENDING top-up is exactly the one
--    whose promise has not yet been paid out. `CREATE OR REPLACE` of the function 0033
--    attached, carrying everything 0052, 0053, 0054 and 0058 put in its two branches
--    across unchanged and verbatim, and adding one clause before them.
--
-- 4. `payments` refuses DELETE. A payment is the record a ledger entry, a refund, a
--    receipt and an audit row all name; nothing in this codebase deletes one, and a
--    repair script that did would leave every one of them dangling.
--
-- Tests reset with TRUNCATE, which bypasses row triggers, deliberately.
--
-- Hand-written because drizzle-kit does not model triggers, and it adds nothing the
-- schema file describes, so it does not affect the drift check.

CREATE TRIGGER receipt_credits_no_update
  BEFORE UPDATE ON receipt_credits
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER receipt_credits_no_delete
  BEFORE DELETE ON receipt_credits
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION nexa_receipt_credit_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  paid RECORD;
  entry RECORD;
BEGIN
  SELECT state, method, customer_id, currency, resolved_by_admin_id
    INTO paid
    FROM payments
   WHERE tenant_id = NEW.tenant_id AND id = NEW.payment_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'a receipt credit names a payment that does not exist'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF paid.state <> 'FAILED' OR paid.method <> 'MANUAL_TRANSFER' THEN
    RAISE EXCEPTION 'a receipt credit disposes of a FAILED manual transfer, not a % % payment',
      paid.state, paid.method
      USING ERRCODE = 'check_violation';
  END IF;

  IF paid.resolved_by_admin_id IS DISTINCT FROM NEW.decided_by_admin_id THEN
    RAISE EXCEPTION 'a receipt credit is decided by the administrator who resolved the payment'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.currency IS DISTINCT FROM paid.currency THEN
    RAISE EXCEPTION 'a receipt credit is in the payment''s own currency'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT reason, payment_id, customer_id, direction, amount, currency
    INTO entry
    FROM wallet_entries
   WHERE tenant_id = NEW.tenant_id AND id = NEW.wallet_entry_id;

  IF NOT FOUND
     OR entry.reason <> 'RECEIPT_CREDIT'
     OR entry.direction <> 'CREDIT'
     OR entry.payment_id IS DISTINCT FROM NEW.payment_id
     OR entry.customer_id IS DISTINCT FROM paid.customer_id
     OR entry.amount IS DISTINCT FROM NEW.amount
     OR entry.currency IS DISTINCT FROM NEW.currency THEN
    RAISE EXCEPTION 'a receipt credit names the RECEIPT_CREDIT credit it wrote for this payment, of this amount'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER receipt_credits_guard
  BEFORE INSERT ON receipt_credits
  FOR EACH ROW EXECUTE FUNCTION nexa_receipt_credit_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION nexa_payments_confirmation_guard() RETURNS trigger AS $$
BEGIN
  -- Payment File 02 §17 (D5): the route snapshot is frozen in every state.
  IF NEW.gateway_provider IS DISTINCT FROM OLD.gateway_provider
    OR NEW.topup_cashback_percent IS DISTINCT FROM OLD.topup_cashback_percent THEN
    RAISE EXCEPTION
      'a payment''s route and the top-up gift it promised are fixed when it is created.'
      USING ERRCODE = 'check_violation';
  END IF;

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
--> statement-breakpoint

CREATE TRIGGER payments_no_delete
  BEFORE DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
