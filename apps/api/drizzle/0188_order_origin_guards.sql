-- Migration P3 (`docs/migration-order-origin.md`): what `drizzle-kit` does not model for
-- 0187 — `orders.origin` is fixed at INSERT and never rewritten. Hand-written, so no
-- snapshot accompanies it.
--
-- WHY: the origin decides whether an order is a sale. An UPDATE that turned a STANDARD
-- order into a LEGACY_ADOPTION would erase a real sale from every report after the fact,
-- and the reverse would invent revenue for an adopted legacy service. Neither is a
-- correction anybody may make in place; a wrong origin is a new order, as a wrong
-- settlement is a refund plus a new order.
--
-- The 0187 column default already backfilled every existing row to STANDARD.

CREATE OR REPLACE FUNCTION nexa_orders_origin_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.origin IS DISTINCT FROM OLD.origin THEN
    RAISE EXCEPTION 'orders.origin is fixed when the order is written.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS orders_origin_immutable ON orders;--> statement-breakpoint
CREATE TRIGGER orders_origin_immutable
  BEFORE UPDATE OF origin ON orders
  FOR EACH ROW EXECUTE FUNCTION nexa_orders_origin_guard();
