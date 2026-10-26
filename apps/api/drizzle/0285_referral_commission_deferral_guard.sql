-- R10 D5 (b): the referral commission guard learns ONE new update, and only one.
--
-- With `referral_abuse_guard` on and a daily commission cap set, a commission over the
-- cap is DEFERRED, never voided: it stays PENDING and `not_before` is set to the start of
-- the referrer's next local day, so the earner's discovery skips it until then instead of
-- returning it at the head of the queue on every tick.
--
-- The guard (0108) allowed a PENDING row to move only to EARNED or VOID. This replaces the
-- function with the same rules plus one: a PENDING row may stay PENDING when the ONLY
-- columns that change are `not_before` and `updated_at`. Everything else is as before —
-- the terms stay frozen, EARNED and VOID rows never change again, nothing is deleted, and
-- a PENDING -> PENDING update that touches an earned or voided column is still refused.
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

  -- R10 D5: the deferral. PENDING stays PENDING, and only the hold moves.
  IF NEW.state = 'PENDING' THEN
    IF NEW.earned_amount IS DISTINCT FROM OLD.earned_amount
       OR NEW.earned_entry_id IS DISTINCT FROM OLD.earned_entry_id
       OR NEW.earned_at IS DISTINCT FROM OLD.earned_at
       OR NEW.voided_at IS DISTINCT FROM OLD.voided_at
       OR NEW.not_before IS NULL THEN
      RAISE EXCEPTION 'a pending referral commission changes only its not_before while it stays pending'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.state NOT IN ('EARNED', 'VOID') THEN
    RAISE EXCEPTION 'a referral commission moves from PENDING to EARNED or VOID, not to %', NEW.state
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
