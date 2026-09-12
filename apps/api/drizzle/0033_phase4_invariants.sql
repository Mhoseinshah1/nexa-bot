-- Phase 4 invariants the schema file cannot express.
--
-- drizzle-kit models tables, columns, indexes and CHECKs. It does not model
-- triggers, so everything here is hand-written and registered in
-- `meta/_journal.json` — and because it adds only things the schema file does not
-- describe, it does not affect the drift check.
--
-- Three guards, each protecting a rule that an application-only check would leave
-- one direct write, one future code path or one replica away from being broken.

-- 1. The wallet ledger is APPEND-ONLY.
--
-- `ledger.ts` says so, `CLAUDE.md` says never add a balance column, and the whole
-- design rests on a balance being `SUM` over immutable rows. An UPDATE on a ledger
-- entry is the legacy system's mutable balance with extra steps, and the 916,550
-- residual it produced is what an unconstrained amount column looks like after a
-- few years. A reversal is a NEW entry naming the original in `reverses_entry_id`.
--
-- `nexa_reject_mutation` already exists (0001) and is reused deliberately: a second
-- rejection function would be a second message to keep in step.
CREATE TRIGGER wallet_entries_no_update
  BEFORE UPDATE ON wallet_entries
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER wallet_entries_no_delete
  BEFORE DELETE ON wallet_entries
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

-- Tests reset with TRUNCATE, which bypasses row triggers. That is deliberate and
-- documented in `.claude/skills/nexa-migrations`: the guard stays in force for
-- application code, which is the only thing it is protecting against.

-- 2. An order's COMMERCIAL SNAPSHOT is frozen once it is confirmed.
--
-- The snapshot exists so that a purchase can be reconstructed after the product has
-- been renamed, re-priced or deleted. A snapshot that can be edited is not a
-- snapshot, and the place it would be edited is a well-meaning "fix the title"
-- admin action that silently rewrites what a customer agreed to pay.
--
-- Before confirmation the row is a draft and may change freely. After it, the line
-- and the totals are immutable and only the lifecycle columns move.
CREATE OR REPLACE FUNCTION nexa_orders_snapshot_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.confirmed_at IS NOT NULL AND (
       NEW.product_id IS DISTINCT FROM OLD.product_id
    OR NEW.panel_id IS DISTINCT FROM OLD.panel_id
    OR NEW.line_title IS DISTINCT FROM OLD.line_title
    OR NEW.line_duration_days IS DISTINCT FROM OLD.line_duration_days
    OR NEW.line_traffic_bytes IS DISTINCT FROM OLD.line_traffic_bytes
    OR NEW.line_device_limit IS DISTINCT FROM OLD.line_device_limit
    OR NEW.line_unit_price_amount IS DISTINCT FROM OLD.line_unit_price_amount
    OR NEW.line_quantity IS DISTINCT FROM OLD.line_quantity
    OR NEW.subtotal_amount IS DISTINCT FROM OLD.subtotal_amount
    OR NEW.discount_amount IS DISTINCT FROM OLD.discount_amount
    OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.quote IS DISTINCT FROM OLD.quote
    OR NEW.discount_code IS DISTINCT FROM OLD.discount_code
    OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
    OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
  ) THEN
    RAISE EXCEPTION
      'a confirmed order''s line, totals, quote and customer are immutable; only its lifecycle may change.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER orders_snapshot_frozen
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION nexa_orders_snapshot_guard();
--> statement-breakpoint

-- 3. A payment's MONEY and its CONFIRMATION are frozen once confirmed.
--
-- The amount, the currency, the customer, the order it settles and the evidence
-- behind it are the facts a refund, a reconciliation and an audit all read. A
-- confirmed payment whose amount can be edited is a confirmed payment whose refund
-- can be computed from a number nobody agreed to.
--
-- `external_reference` is deliberately NOT frozen: a reconciliation against a
-- gateway's own records is exactly the case where an identifier is learned after
-- confirmation, and refusing that would make the reconciliation unrecordable.
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
    OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
    OR NEW.state IS DISTINCT FROM OLD.state
  ) THEN
    RAISE EXCEPTION
      'a confirmed payment''s money, customer, order, method and evidence are immutable.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER payments_confirmation_frozen
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION nexa_payments_confirmation_guard();
