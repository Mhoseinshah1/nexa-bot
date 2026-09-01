-- Scope operational-event deduplication per tenant.
--
-- `operational_events.dedupe_key` was globally unique. Two tenants recording the
-- same code — `panel.unreachable`, say — collapsed onto ONE row, and the upsert
-- overwrote `context` and `correlation_id` with the second tenant's values. The
-- immutability trigger from 0001 pinned `tenant_id` to whoever inserted first,
-- so tenant A's row ended up carrying tenant B's payload.
--
-- That is a cross-tenant write, and no repository predicate could have caught
-- it: the collision happened in the index rather than in a query. It is the one
-- place the ADR-0004 discipline — every tenant-owned row carries `tenant_id`,
-- enforced in the repository layer — had a hole the application could not close.
--
-- Adding `dedupe_scope` mirrors `request_idempotency.scope_ref`: the tenant id,
-- or the literal 'SYSTEM' for genuinely tenant-less events. Existing rows
-- default to 'SYSTEM', which is correct — nothing has run in production, and a
-- development row's dedupe namespace does not matter.

DROP INDEX "operational_events_dedupe_key";--> statement-breakpoint
ALTER TABLE "operational_events" ADD COLUMN "dedupe_scope" text DEFAULT 'SYSTEM' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "operational_events_dedupe_key" ON "operational_events" USING btree ("dedupe_scope","dedupe_key");
