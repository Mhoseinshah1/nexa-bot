-- Mirza migration PR4 (owner decision 6): what `drizzle-kit` does not model for 0226.
-- Hand-written, so no snapshot accompanies it.
--
-- A legacy wallet debt records what the legacy system said a customer owed, read from one
-- snapshot. Those facts are evidence: the amount, its currency, the legacy user, the
-- customer, the source fingerprint, the row checksum, the run and the time it was recorded
-- are never rewritten — a later snapshot with a different figure is reported, never
-- applied (owner constraint 4). Only the owner's decision moves (state, reason, who, when,
-- version), by a conditional UPDATE naming its from-state. The row is never deleted, so a
-- waived debt stays on the record as waived. The triggers fire for every role, the table
-- owner included (the 0001 append-only guards' rule).
--
-- Rollback: dropping the two triggers and the function restores the release before this
-- one exactly; no row is rewritten.

CREATE OR REPLACE FUNCTION nexa_legacy_wallet_debt_facts_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.legacy_user_id IS DISTINCT FROM OLD.legacy_user_id
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.source_fingerprint IS DISTINCT FROM OLD.source_fingerprint
     OR NEW.row_checksum IS DISTINCT FROM OLD.row_checksum
     OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION
      'legacy wallet debt % records a legacy fact; only its decision may change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS legacy_wallet_debts_facts_immutable ON legacy_wallet_debts;--> statement-breakpoint
CREATE TRIGGER legacy_wallet_debts_facts_immutable
  BEFORE UPDATE ON legacy_wallet_debts
  FOR EACH ROW EXECUTE FUNCTION nexa_legacy_wallet_debt_facts_immutable();
--> statement-breakpoint

CREATE TRIGGER legacy_wallet_debts_no_delete
  BEFORE DELETE ON legacy_wallet_debts
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
