--
-- Every tenant gets a first category — including the ones 0097's predicate missed.
--
-- 0097 backfilled `FROM (SELECT DISTINCT tenant_id FROM products)`, so a tenant that
-- existed at migration time with ZERO products got nothing. Its operator's first
-- product would then be refused by `PRODUCT_NOT_CATEGORISED` naming a rule they had no
-- way to satisfy: no category to pick, and no reason to suspect one was needed.
--
-- 0097 is NOT edited to fix this. It has shipped as a numbered migration and the
-- forward-only rule does not get an exception for a case that looks harmless —
-- `0002_drop_callback_refs.sql` is the worked example. This is the correction, applied
-- forward.
--
-- Idempotent on "this tenant has ANY category", the same predicate the application's
-- `ensureDefault` uses. That is deliberately not "has a category named X": a tenant
-- whose operator already renamed 0097's row keeps the rename, because the question
-- asked is whether one exists at all.
--
-- Three populations, all covered after this runs:
--   * migrated tenants WITH products      — 0097 gave them one; this finds it and skips
--   * migrated tenants with ZERO products — this gives them one
--   * tenants created after 0097          — `provision-installation` gives them one in
--                                           the transaction that creates the tenant
--
INSERT INTO "product_categories" ("id", "tenant_id", "name", "status", "visibility", "sort_order")
SELECT gen_random_uuid(), t."id", 'عمومی', 'ACTIVE', 'VISIBLE', 0
FROM "tenants" AS t
WHERE NOT EXISTS (
  SELECT 1 FROM "product_categories" AS c WHERE c."tenant_id" = t."id"
);
