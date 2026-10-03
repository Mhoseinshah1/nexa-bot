-- Program Item 14 (`docs/legacy-migration/hidden-legacy-products.md` §4), review of 0182.
-- Hand-written, so no snapshot accompanies it.
--
-- 0182 kept a legacy shape's product HIDDEN and uncategorised, but left its traffic and
-- duration editable. Those two ARE the shape: `legacy_product_shapes` records them, the
-- current-tariff resolution matches public products on them, and a renewal buys the
-- product's own figures. An edit to either would make the shape row, its tariff and what
-- a renewal provisions three different answers. So the guard now also refuses a CHANGE
-- to `duration_days` or `traffic_bytes` on a product a shape stands on. (The shape's
-- other dimensions — the legacy panel code and the custom flag — live only on the shape
-- row.) Price, status, title and the rest stay editable: price and status are what a
-- resolution writes.
--
-- A new migration rather than an edit of 0182: 0182 has been applied to databases
-- already, and an applied migration is never edited.
--
-- Rollback: restoring 0182's function body and trigger restores the previous guard; no
-- row is rewritten.

CREATE OR REPLACE FUNCTION nexa_legacy_shape_product_hidden() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM legacy_product_shapes s
     WHERE s.tenant_id = NEW.tenant_id AND s.product_id = NEW.id
  ) THEN
    RAISE EXCEPTION
      'product % stands for a legacy shape: it must stay HIDDEN and uncategorised, and its traffic and duration cannot change', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS nexa_legacy_shape_product_hidden ON products;--> statement-breakpoint
CREATE TRIGGER nexa_legacy_shape_product_hidden
  BEFORE UPDATE OF audience, category_id, duration_days, traffic_bytes ON products
  FOR EACH ROW
  WHEN (
    NEW.audience IS DISTINCT FROM 'HIDDEN'
    OR NEW.category_id IS NOT NULL
    OR NEW.duration_days IS DISTINCT FROM OLD.duration_days
    OR NEW.traffic_bytes IS DISTINCT FROM OLD.traffic_bytes
  )
  EXECUTE FUNCTION nexa_legacy_shape_product_hidden();
