-- WP9-A: the referral records refuse what would make them stop being records.
-- `docs/wp9-referral-audit.md` F2, F3, F7 and F8.
--
-- 1. `referrals` is append-only. An attribution is made once, at registration, and is
--    immutable (F2): an edited referral is somebody else being owed a referee's
--    commissions. It had no writer until this release and has no updater in it. The
--    Phase 0 `reward_entry_id` / `rewarded_at` pair stays null: a commission records its
--    own credit, per order, on `order_referral_commissions`.
--
-- 2. `referral_codes` is append-only. A code that changed would orphan every link
--    already shared, and a code that moved would hand them to somebody else.
--
-- 3. `referral_commission_reversals` is append-only, for the reason
--    `cashback_reversals` is: it is the record of what a refund took back and what it
--    could not.
--
-- 4. `order_referral_commissions` is a PROMISE, frozen from the moment it is written:
--    the referral, both parties, the scope, the rate, the basis, the amount and the
--    currency. Its state moves forward once, PENDING to EARNED or VOID, together with the
--    columns that record how it ended; EARNED and VOID rows are frozen entirely, and no
--    row is deleted. The same guard `order_cashback` has, for the same reason: the
--    application moves state with a conditional UPDATE naming its `from` state, and this
--    makes a convenience setter unable to undo that.
--
-- Tests reset with TRUNCATE, which bypasses row triggers, deliberately.
--
-- Hand-written because drizzle-kit does not model triggers, and it adds nothing the
-- schema file describes, so it does not affect the drift check.

CREATE TRIGGER referrals_no_update
  BEFORE UPDATE ON referrals
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER referrals_no_delete
  BEFORE DELETE ON referrals
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER referral_codes_no_update
  BEFORE UPDATE ON referral_codes
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER referral_codes_no_delete
  BEFORE DELETE ON referral_codes
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER referral_commission_reversals_no_update
  BEFORE UPDATE ON referral_commission_reversals
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER referral_commission_reversals_no_delete
  BEFORE DELETE ON referral_commission_reversals
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION nexa_order_referral_commission_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'order_referral_commissions rows are never deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.referral_id IS DISTINCT FROM OLD.referral_id
     OR NEW.referrer_id IS DISTINCT FROM OLD.referrer_id
     OR NEW.referee_id IS DISTINCT FROM OLD.referee_id
     OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.percent IS DISTINCT FROM OLD.percent
     OR NEW.basis_amount IS DISTINCT FROM OLD.basis_amount
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'the terms of a referral commission are frozen once promised'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.state <> 'PENDING' THEN
    RAISE EXCEPTION 'a referral commission that is % does not change again', OLD.state
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.state NOT IN ('EARNED', 'VOID') THEN
    RAISE EXCEPTION 'a referral commission moves from PENDING to EARNED or VOID, not to %', NEW.state
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER order_referral_commissions_guard
  BEFORE UPDATE OR DELETE ON order_referral_commissions
  FOR EACH ROW EXECUTE FUNCTION nexa_order_referral_commission_guard();
