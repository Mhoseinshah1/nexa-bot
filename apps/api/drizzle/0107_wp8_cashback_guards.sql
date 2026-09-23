-- WP8: the three new money records refuse what would make them stop being records.
-- `docs/wp8-pricing-audit.md` P6 and P9.
--
-- 1. `discount_redemptions` is append-only. A redemption is the fact that a rule took
--    an amount off a confirmed order; whether it is LIVE is decided by its order's
--    state, never by editing or deleting the row. So nothing ever needs to change one.
--    `nexa_reject_mutation` is the function `audit_logs`, `processed_messages` and
--    `service_commercial_actions` already use.
--
-- 2. `cashback_reversals` is append-only for the same reason: it is the record of what
--    a refund took back and what it could not. An edited reversal is a second answer
--    to "how much cashback does this customer still hold".
--
-- 3. `order_cashback` is a PROMISE, and its terms are frozen from the moment it is
--    written: the rule, the percent, the amount and the currency the customer saw.
--    What may change is its state, forward only — PENDING to EARNED or to VOID, once —
--    together with the columns that record how it ended. EARNED and VOID rows are
--    frozen entirely, and no row may be deleted. The application already moves state
--    with a conditional UPDATE naming its `from` state; this makes a convenience
--    setter unable to undo that.
--
-- Tests reset with TRUNCATE, which bypasses row triggers, deliberately.
--
-- Hand-written because drizzle-kit does not model triggers, and it adds nothing the
-- schema file describes, so it does not affect the drift check.

CREATE TRIGGER discount_redemptions_no_update
  BEFORE UPDATE ON discount_redemptions
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER discount_redemptions_no_delete
  BEFORE DELETE ON discount_redemptions
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER cashback_reversals_no_update
  BEFORE UPDATE ON cashback_reversals
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER cashback_reversals_no_delete
  BEFORE DELETE ON cashback_reversals
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION nexa_order_cashback_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'order_cashback rows are never deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.rule_id IS DISTINCT FROM OLD.rule_id
     OR NEW.rule_label IS DISTINCT FROM OLD.rule_label
     OR NEW.percent IS DISTINCT FROM OLD.percent
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'the terms of an order''s cashback are frozen once promised'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.state <> 'PENDING' THEN
    RAISE EXCEPTION 'an order''s cashback that is % does not change again', OLD.state
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.state NOT IN ('EARNED', 'VOID') THEN
    RAISE EXCEPTION 'an order''s cashback moves from PENDING to EARNED or VOID, not to %', NEW.state
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER order_cashback_guard
  BEFORE UPDATE OR DELETE ON order_cashback
  FOR EACH ROW EXECUTE FUNCTION nexa_order_cashback_guard();
