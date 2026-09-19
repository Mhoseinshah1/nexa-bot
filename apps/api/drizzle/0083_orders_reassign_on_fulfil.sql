-- The ONE edit to a confirmed order's line this product allows, and its bound.
--
-- Hand-written because `drizzle-kit` does not model triggers — `0033` created
-- this guard the same way, and `nexa-migrations` records the convention.
--
-- WHAT 0033 FROZE, AND WHY IT STILL HOLDS
--
-- A confirmed order's line, totals, quote and customer are the facts a report,
-- a refund and an audit all read. Editing any of them rewrites history, which
-- is the legacy defect «محصول حذف‌شده» in another column. None of that changes.
--
-- WHAT THIS RELEASE ADDS
--
-- `PAID_UNFULFILLED`: the money arrived and no service could be created on the
-- panel the order was sold on. An operator's two ways out are to retry that
-- panel or to move the order to one that works — and the second is impossible
-- while `panel_id` is frozen, which would leave a refund as the only exit from
-- a state whose whole purpose is to keep both exits open.
--
-- So `panel_id` may change, and ONLY:
--
--   * out of `PAID_UNFULFILLED` (`OLD.state`), which is the one state where no
--     service exists for the order, so nothing is orphaned by the move; and
--   * into `PAID` (`NEW.state`), which is the `FULFIL` edge and the only
--     transition that writes the service — the panel the row names and the
--     panel the service is created on are therefore the same, in one
--     transaction, under that panel's lock.
--
-- Every other column 0033 named stays frozen in every state, this one
-- included: the amount, the customer, the product and the quote are untouched
-- by a reassignment. What moves is where the thing the customer already paid
-- for will be created.
--
-- A move in any other direction — a PAID order re-pointed, an
-- `AWAITING_PAYMENT` one edited — still raises, which is what the test
-- `refuses to re-point a PAID order's panel` asserts against the live trigger.

CREATE OR REPLACE FUNCTION nexa_orders_snapshot_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.confirmed_at IS NOT NULL AND (
       NEW.product_id IS DISTINCT FROM OLD.product_id
    OR (
         NEW.panel_id IS DISTINCT FROM OLD.panel_id
         AND NOT (OLD.state = 'PAID_UNFULFILLED' AND NEW.state = 'PAID')
       )
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
      'a confirmed order''s line, totals, quote and customer are immutable; only its lifecycle may change, and its panel only when an unfulfilled order is being fulfilled elsewhere.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
