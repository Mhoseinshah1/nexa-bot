-- `orders.fulfil` and the order-snapshot exception it needed, both removed.
--
-- Hand-written, like 0011, 0031 and 0082, because `drizzle-kit` generates from
-- `schema.ts` and looks at neither data nor triggers. No snapshot accompanies
-- it for the same reason: it changes no table shape, so the drift check has
-- nothing to compare.
--
-- PART ONE: the permission
--
-- 0082 backfilled `orders.fulfil` into the seeded owner and finance roles so
-- that installations predating it would render a working retry control. There
-- is no retry control any more, and `PERMISSION_CATALOG` no longer declares the
-- key, so every row naming it is a grant of a permission that does not exist —
-- invisible to `resolveEffectivePermissions`, and present in the Web Admin's
-- role editor as a key nothing can explain.
--
-- Deleting a grant is the direction the create-only rule in
-- `ensureSystemRoles` exists to protect against, and this is the one case it
-- does not cover: the permission is being retired, not withdrawn from somebody.
-- A DENY override naming it is left alone — it denies nothing, costs nothing,
-- and removing an operator's recorded decision is not this migration's business.
--
-- PART TWO: the snapshot guard
--
-- 0083 carved one exception into `nexa_orders_snapshot_guard`: `panel_id` could
-- change on the `PAID_UNFULFILLED -> PAID` edge, because reassigning a stranded
-- order to a working panel was one of its two exits. That edge is gone, so the
-- exception now names a state no row can hold — which reads, to the next person
-- editing this function, as "a confirmed order's panel is sometimes mutable".
-- It is not. This restores the guard to what 0033 froze: every column it names
-- is immutable once `confirmed_at` is set, the panel included.

DELETE FROM "role_permissions" WHERE "permission_key" = 'orders.fulfil';
--> statement-breakpoint
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
