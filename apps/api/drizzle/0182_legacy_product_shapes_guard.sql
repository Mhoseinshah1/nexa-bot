-- Program Item 14 (`docs/legacy-migration/hidden-legacy-products.md`): what `drizzle-kit`
-- does not model for 0181. Hand-written, so no snapshot accompanies it.
--
-- A hidden legacy product is NEVER listed and NEVER sold as a new service. Both follow
-- from two columns: `audience = 'HIDDEN'` keeps it out of every catalogue query, and
-- `category_id IS NULL` makes a NEW_SERVICE order refuse it (`NOT_CATEGORISED`) while a
-- renewal — which reads the service's own product and no category — still prices it.
-- An ordinary product edit could change either, so the database refuses that edit for a
-- product a legacy shape stands on. Price and status stay editable: they are what a
-- current-tariff resolution writes.
--
-- Rollback: dropping the trigger and the function restores the release before this one
-- exactly; no row is rewritten.

CREATE OR REPLACE FUNCTION nexa_legacy_shape_product_hidden() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM legacy_product_shapes s
     WHERE s.tenant_id = NEW.tenant_id AND s.product_id = NEW.id
  ) THEN
    RAISE EXCEPTION
      'product % stands for a legacy shape and must stay HIDDEN and uncategorised', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS nexa_legacy_shape_product_hidden ON products;--> statement-breakpoint
CREATE TRIGGER nexa_legacy_shape_product_hidden
  BEFORE UPDATE OF audience, category_id ON products
  FOR EACH ROW
  WHEN (NEW.audience IS DISTINCT FROM 'HIDDEN' OR NEW.category_id IS NOT NULL)
  EXECUTE FUNCTION nexa_legacy_shape_product_hidden();
