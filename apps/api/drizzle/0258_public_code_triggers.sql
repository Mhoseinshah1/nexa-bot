-- Round 4, PR-C: short public codes. 0257 added the nullable columns, their format CHECKs and
-- the per-tenant unique keys; this file adds what drizzle-kit does not model.
--
-- The per-tenant unique keys are built ONLINE after the migrator (`online-indexes.ts`, Codex
-- review of #299). Nothing below depends on them: the trigger LOOKS a candidate up before
-- using it, and a race between two inserts drawing one code before the keys exist is
-- 1 in ~10^11 per pair; once built, the keys are the arbiter.
--
-- 1. `nexa_public_code()` draws one 8-character code: Crockford base32 without 0/O/1/I/L
--    (30 symbols, the alphabet `PUBLIC_CODE_ALPHABET` in @nexa/contracts). `random()` is the
--    source on purpose: a code is a presentation identity, never a secret and never something
--    anything authorises on, and `random()` is the one source `setseed()` can make repeatable,
--    which is what lets the collision retry below be tested against a real collision.
-- 2. `nexa_assign_public_code()` fills NEW.code on every INSERT whose writer left it NULL —
--    the application, the one-time import, a fixture, and the release running beside this
--    one during an update, none of which has to remember to ask. It looks the candidate up in
--    the tenant's rows of the same table and draws again on a collision (the retry), up to 16
--    times. `<table>_tenant_code_key` is the arbiter for the one race a lookup cannot see —
--    two transactions drawing the same code at once — which is a unique violation, never a
--    duplicate. A code a writer supplies (a restore) is kept as written.
-- 3. `nexa_assign_product_code()` gives a product the next per-tenant number (`P-101` first)
--    under a per-tenant transaction advisory lock, so two concurrent creates cannot take one
--    number, after numbering any of the tenant's older products still without one. The
--    backfill takes the same lock.
-- 4. A code, once written, never changes (`nexa_public_code_frozen`): a code a customer was
--    shown must keep naming the same record. NULL → code is the backfill and is allowed.
--
-- No row is updated here: the backfill of existing rows runs after the migrator, in keyset
-- batches of their own short transactions (`public-code-backfill.ts`), so this migration
-- holds no lock on a live row.
CREATE FUNCTION nexa_public_code() RETURNS text
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  result text := '';
BEGIN
  FOR i IN 1..8 LOOP
    result := result || substr(alphabet, 1 + floor(random() * 30)::int, 1);
  END LOOP;
  RETURN result;
END;
$$;--> statement-breakpoint
CREATE FUNCTION nexa_assign_public_code() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  candidate text;
  taken boolean;
BEGIN
  IF NEW.code IS NOT NULL THEN
    RETURN NEW;
  END IF;
  FOR attempt IN 1..16 LOOP
    candidate := nexa_public_code();
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE tenant_id = $1 AND code = $2)',
      TG_TABLE_SCHEMA, TG_TABLE_NAME
    ) INTO taken USING NEW.tenant_id, candidate;
    IF NOT taken THEN
      NEW.code := candidate;
      RETURN NEW;
    END IF;
  END LOOP;
  RAISE EXCEPTION 'no free public code for % after 16 draws', TG_TABLE_NAME
    USING ERRCODE = 'unique_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER nexa_orders_public_code BEFORE INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION nexa_assign_public_code();--> statement-breakpoint
CREATE TRIGGER nexa_payments_public_code BEFORE INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION nexa_assign_public_code();--> statement-breakpoint
CREATE TRIGGER nexa_services_public_code BEFORE INSERT ON services
  FOR EACH ROW EXECUTE FUNCTION nexa_assign_public_code();--> statement-breakpoint
CREATE TRIGGER nexa_tickets_public_code BEFORE INSERT ON tickets
  FOR EACH ROW EXECUTE FUNCTION nexa_assign_public_code();--> statement-breakpoint
CREATE FUNCTION nexa_assign_product_code() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code_number IS NOT NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('nexa.product-code'), hashtext(NEW.tenant_id::text));
  -- Codex review of #299: the tenant's products from before 0257 are numbered FIRST, oldest
  -- first, so a product created between this migration and the backfill never takes P-101
  -- ahead of the catalogue the operator already had. A catalogue is tens of rows, and only
  -- the first insert after the migration finds any.
  UPDATE products AS p
     SET code_number = base.n + ranked.position
    FROM (SELECT coalesce(max(code_number), 100) AS n
            FROM products WHERE tenant_id = NEW.tenant_id) AS base,
         (SELECT id, row_number() OVER (ORDER BY created_at, id) AS position
            FROM products WHERE tenant_id = NEW.tenant_id AND code_number IS NULL) AS ranked
   WHERE p.id = ranked.id AND p.code_number IS NULL;
  SELECT coalesce(max(code_number), 100) + 1 INTO NEW.code_number
    FROM products WHERE tenant_id = NEW.tenant_id;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER nexa_products_code_number BEFORE INSERT ON products
  FOR EACH ROW EXECUTE FUNCTION nexa_assign_product_code();--> statement-breakpoint
CREATE FUNCTION nexa_public_code_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the public code of % % is written once and never changes', TG_TABLE_NAME, OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER nexa_orders_public_code_frozen BEFORE UPDATE OF code ON orders
  FOR EACH ROW WHEN (OLD.code IS NOT NULL AND NEW.code IS DISTINCT FROM OLD.code)
  EXECUTE FUNCTION nexa_public_code_frozen();--> statement-breakpoint
CREATE TRIGGER nexa_payments_public_code_frozen BEFORE UPDATE OF code ON payments
  FOR EACH ROW WHEN (OLD.code IS NOT NULL AND NEW.code IS DISTINCT FROM OLD.code)
  EXECUTE FUNCTION nexa_public_code_frozen();--> statement-breakpoint
CREATE TRIGGER nexa_services_public_code_frozen BEFORE UPDATE OF code ON services
  FOR EACH ROW WHEN (OLD.code IS NOT NULL AND NEW.code IS DISTINCT FROM OLD.code)
  EXECUTE FUNCTION nexa_public_code_frozen();--> statement-breakpoint
CREATE TRIGGER nexa_tickets_public_code_frozen BEFORE UPDATE OF code ON tickets
  FOR EACH ROW WHEN (OLD.code IS NOT NULL AND NEW.code IS DISTINCT FROM OLD.code)
  EXECUTE FUNCTION nexa_public_code_frozen();--> statement-breakpoint
CREATE TRIGGER nexa_products_code_number_frozen BEFORE UPDATE OF code_number ON products
  FOR EACH ROW WHEN (OLD.code_number IS NOT NULL AND NEW.code_number IS DISTINCT FROM OLD.code_number)
  EXECUTE FUNCTION nexa_public_code_frozen();
