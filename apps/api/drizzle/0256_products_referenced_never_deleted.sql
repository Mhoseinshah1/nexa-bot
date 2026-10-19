-- A product that any order or service references is never deleted. Hand-written: drizzle-kit
-- does not model triggers, so no snapshot accompanies it.
--
-- No surface deletes a product (there is no route, command or repository method for it), and
-- `orders_product_fk` already refuses the delete of a product an order names. `services` has no
-- foreign key to `products` (its `product_id` is navigation beside the order's snapshot), so a
-- product only a service still names — the import's historical products stand behind ended
-- and adopted services — was protected by nothing but the absence of a delete path. This makes
-- the rule the database's own, for both tables, with one message.
--
-- Rollback: dropping the trigger and the function restores the release before this one
-- exactly; no row is rewritten.

CREATE OR REPLACE FUNCTION nexa_product_referenced_never_deleted() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM orders o WHERE o.tenant_id = OLD.tenant_id AND o.product_id = OLD.id
  ) OR EXISTS (
    SELECT 1 FROM services s WHERE s.tenant_id = OLD.tenant_id AND s.product_id = OLD.id
  ) THEN
    RAISE EXCEPTION
      'product % is referenced by an order or a service and can never be deleted', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS nexa_product_referenced_never_deleted ON products;--> statement-breakpoint
CREATE TRIGGER nexa_product_referenced_never_deleted
  BEFORE DELETE ON products
  FOR EACH ROW
  EXECUTE FUNCTION nexa_product_referenced_never_deleted();
