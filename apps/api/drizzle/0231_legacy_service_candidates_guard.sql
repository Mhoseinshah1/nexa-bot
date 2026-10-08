-- Mirza migration PR5: what `drizzle-kit` does not model for 0229.
-- Hand-written, so no snapshot accompanies it.
--
-- A legacy service candidate is re-decided by every import run, so most of its columns move.
-- Four things never do, and each is a way to lose a fact or invent one:
--
-- * Its identity: the tenant, the invoice key, the source class (`synthetic`) and when it was
--   first decided. A synthetic row is never turned into a real one (or back): a real
--   snapshot's decision is never written over test data, and test data never passes for a
--   real decision.
-- * An ADOPTED candidate stays adopted, naming the SAME service. A later snapshot that no
--   longer shows the account, or a person's click, never "unadopts" a service — that is a
--   question for a person, outside this table (owner constraint 4: reported, never undone).
-- * The row is never deleted: an invoice that was not adopted is archived history.
--
-- The triggers fire for every role, the table owner included (the 0001 append-only guards'
-- rule). Rollback: dropping the two triggers and the function restores the release before
-- this one exactly; no row is rewritten.

CREATE OR REPLACE FUNCTION nexa_legacy_service_candidate_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.invoice_key IS DISTINCT FROM OLD.invoice_key
     OR NEW.synthetic IS DISTINCT FROM OLD.synthetic
     OR NEW.first_decided_at IS DISTINCT FROM OLD.first_decided_at THEN
    RAISE EXCEPTION
      'legacy service candidate % keeps its identity; only its outcome and review may change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.review_state = 'ADOPTED'
     AND (NEW.review_state IS DISTINCT FROM 'ADOPTED'
          OR NEW.service_id IS DISTINCT FROM OLD.service_id) THEN
    RAISE EXCEPTION
      'legacy service candidate % is an adopted service; it is never unadopted or re-pointed', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS legacy_service_candidates_guard ON legacy_service_candidates;--> statement-breakpoint
CREATE TRIGGER legacy_service_candidates_guard
  BEFORE UPDATE ON legacy_service_candidates
  FOR EACH ROW EXECUTE FUNCTION nexa_legacy_service_candidate_guard();
--> statement-breakpoint

CREATE TRIGGER legacy_service_candidates_no_delete
  BEFORE DELETE ON legacy_service_candidates
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
