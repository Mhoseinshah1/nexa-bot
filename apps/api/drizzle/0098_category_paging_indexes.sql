--
-- The indexes 0097 shipped no longer match the ordering the customer surfaces use.
--
-- 0097 led `(tenant_id, [category_id,] sort_order, created_at, id)`, which was right for
-- the ordering this package assumed before the paging decision. The owner then specified
-- `sort_order ASC, id ASC` — no `created_at` — so the planner would sort on `id` within
-- each `sort_order` group rather than walking the index. A new migration rather than an
-- edit to 0097: `nexa-migrations` says the forward-only rule does not get an exception
-- because the case looks harmless, and `0002_drop_callback_refs.sql` is the worked
-- example of the same restraint on a table that had never shipped either.
--
-- Dropping these is safe in a way dropping a CONSTRAINT would not be. No released
-- version has them — 0097 and 0098 reach `main` in the same pull request — so there is
-- no rolling-update window in which an older process depends on one. An index that
-- vanished under a running release costs query time; a constraint that vanished costs
-- an invariant, which is why `migration-compatibility.test.ts` guards the second and
-- not the first.
--
-- Plain `CREATE INDEX`, not `CONCURRENTLY`, and that differs from the `services` lookup
-- index deliberately. Drizzle runs migrations in one transaction, where `CONCURRENTLY`
-- is refused, so a table big enough to matter has to use the online lane instead —
-- which `services` did, being populated on any installation that has ever sold
-- anything. A product catalogue is tens of rows: the lock here is held for the time it
-- takes to read them.
--
DROP INDEX "product_categories_tenant_sort_idx";--> statement-breakpoint
DROP INDEX "products_tenant_category_sort_idx";--> statement-breakpoint
CREATE INDEX "product_categories_tenant_sort_id_idx" ON "product_categories" USING btree ("tenant_id","sort_order","id");--> statement-breakpoint
CREATE INDEX "products_tenant_category_sort_id_idx" ON "products" USING btree ("tenant_id","category_id","sort_order","id");