-- Track 3 §3: the services list orders by when a service was ORIGINALLY bought, newest first.
--
-- For a service this installation made that is created_at. For one the one-time import carried
-- over it is the purchase date the previous bot recorded, which the import wrote as its order's
-- settled_at — and for an adopted LIVE service created_at is the moment of the adoption, so
-- ordering by created_at put a year of imported history at the top of the list as "today".
-- original_started_at holds the original date only where it differs from created_at; the list
-- reads COALESCE(original_started_at, created_at), and its keyset indexes are built online
-- (online-indexes.ts), never here, because this table is large and serving while we migrate.
--
-- Expand-only: nullable, no default, unwritten by the application. The release running beside
-- this one inserts exactly as before, and the trigger below fills the column for its imports.
ALTER TABLE "services" ADD COLUMN "original_started_at" timestamp with time zone;
--> statement-breakpoint
-- The database fills it for an imported row whose writer left it out, so no importer has to
-- remember the rule: the import's order is written first (services_order_fk) and carries the
-- original date as settled_at. Only where it differs from created_at, the same rule the backfill
-- applies, so a row looks the same whichever of the two wrote it. A NEXA row is never touched.
CREATE FUNCTION nexa_services_original_started() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  original timestamptz;
BEGIN
  SELECT o.settled_at INTO original
    FROM orders o
   WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.order_id;
  IF original IS NOT NULL AND original IS DISTINCT FROM NEW.created_at THEN
    NEW.original_started_at := original;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER nexa_services_original_started
  BEFORE INSERT ON services
  FOR EACH ROW
  WHEN (NEW.source <> 'NEXA' AND NEW.original_started_at IS NULL)
  EXECUTE FUNCTION nexa_services_original_started();--> statement-breakpoint
-- The rows already imported. Only those whose order's date differs from created_at — the
-- adopted live services; an ended import already has created_at = its purchase — so this
-- touches the few rows that need it rather than rewriting the whole imported history.
-- No trigger fires on an UPDATE of this column.
UPDATE services s
   SET original_started_at = o.settled_at
  FROM orders o
 WHERE s.source <> 'NEXA'
   AND s.original_started_at IS NULL
   AND o.tenant_id = s.tenant_id
   AND o.id = s.order_id
   AND o.settled_at IS NOT NULL
   AND o.settled_at IS DISTINCT FROM s.created_at;
