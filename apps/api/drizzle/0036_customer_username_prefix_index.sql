-- The username prefix index becomes READABLE.
--
-- `/users?username=` is a prefix search, and `lower(username) LIKE 'x%'` cannot use a
-- default-collation btree at all. Measured on 20 000 customers in one tenant: the planner
-- ignored this index, walked `customers_tenant_created_idx` instead, and discarded 12 289
-- rows to return 26 at 364 shared buffers. With `text_pattern_ops` the prefix range is an
-- Index Cond — 111 rows, 31 buffers — and the gap grows with the tenant's size.
--
-- So the index existed and had no reader, while `drizzle-customer.repository.ts` said in a
-- comment that the search used it. `tests/integration/customers-plan.test.ts` now reads the
-- plan, because a claim about an index that no test checks is the claim that drifts.
--
-- DROP and CREATE rather than CONCURRENTLY, deliberately. `customers` is introduced by this
-- unreleased phase, so no installation has a row in it and there is no write traffic for the
-- ShareLock to block. A later index change on a populated table belongs in
-- `infrastructure/persistence/online-indexes.ts`, which is where the panels pagination index
-- is built for exactly that reason.
DROP INDEX "customers_tenant_username_idx";--> statement-breakpoint
CREATE INDEX "customers_tenant_username_idx" ON "customers" USING btree ("tenant_id",lower(username) text_pattern_ops);
