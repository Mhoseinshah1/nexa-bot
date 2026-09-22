-- Every category id is a UUIDv7, including the ones two earlier migrations wrote.
--
-- 0097 (tenants that had products) and 0099 (tenants that had none) each backfilled a
-- default category with `gen_random_uuid()`, which is a version-4 UUID. Every reader of a
-- category id accepts only version 7: `productCategoryIdSchema`, which
-- `ProductCategoryService` and the HTTP contract parse with, and `uuidV7Schema`, which the
-- Telegram callback boundary parses `ck:` with. So on an installation upgraded into
-- categories, the ONE category each tenant had could not be opened by a customer, edited
-- or deleted by an operator, or chosen as a product's destination — the catalogue was
-- empty in every way that mattered while the row sat there looking correct.
--
-- Fixed here rather than in 0097 and 0099, because migrations are forward-only
-- (`nexa-migrations`): an edit would leave any database that already ran them holding
-- the v4 ids with nothing left to repair them. This statement repairs whatever it finds,
-- whichever migration or tool produced it.
--
-- Re-keyed rather than tolerated. Widening the id schema to accept v4 for one entity
-- would make "an id is a UUIDv7" false for every reader that relies on it, and a restore
-- or import could then introduce more of them silently. The row keeps everything else —
-- name, emoji, status, visibility, position, timestamps — so to an operator nothing
-- changes except that it now works.
--
-- The v7 is built from `gen_random_uuid()`: its first six bytes are overwritten with the
-- current Unix time in milliseconds, and bits 52 and 53 are set, turning the version
-- nibble 0100 into 0111. The variant bits are already 10 in a v4, which is what v7 needs.
-- `set_bit` numbers bits from the least significant end of each byte, so byte 6's high
-- nibble is bits 52 to 55.
--
-- The foreign key from `products` is dropped for the length of the re-key and restored
-- exactly as 0097 declared it, because `ON UPDATE no action` refuses to move a referenced
-- key. Both moves are ONE statement: the CTE is referenced twice, so PostgreSQL
-- materialises it once and each old id maps to exactly one new id in both tables.
--
-- `orders.line_category_id` is deliberately not touched. It is a snapshot with no foreign
-- key, never joined, and no order can hold a backfilled id: 0097, 0099 and this file ship
-- in the same release, so no order was placed between them.
--
-- Idempotent: a second run finds no id whose version nibble is not 7, and re-adds a
-- constraint it has just dropped.
ALTER TABLE "products" DROP CONSTRAINT "products_tenant_category_fk";--> statement-breakpoint
WITH "rekey" AS (
  SELECT
    c."tenant_id",
    c."id" AS "old_id",
    encode(
      set_bit(
        set_bit(
          overlay(
            uuid_send(gen_random_uuid())
            PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
            FROM 1 FOR 6
          ),
          52, 1
        ),
        53, 1
      ),
      'hex'
    )::uuid AS "new_id"
  FROM "product_categories" AS c
  WHERE substring(c."id"::text FROM 15 FOR 1) <> '7'
),
"moved_products" AS (
  UPDATE "products" AS p
  SET "category_id" = r."new_id"
  FROM "rekey" AS r
  WHERE p."tenant_id" = r."tenant_id" AND p."category_id" = r."old_id"
  RETURNING p."id"
)
UPDATE "product_categories" AS c
SET "id" = r."new_id"
FROM "rekey" AS r
WHERE c."tenant_id" = r."tenant_id" AND c."id" = r."old_id";--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_category_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "public"."product_categories"("tenant_id","id") ON DELETE no action ON UPDATE no action;
