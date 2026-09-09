import type { PoolClient } from 'pg';
import type { DatabaseHandle } from './database.js';

/**
 * Indexes built OUTSIDE the migrator, concurrently.
 *
 * Drizzle runs every pending migration inside one transaction, and
 * `CREATE INDEX CONCURRENTLY` is refused inside a transaction block. An
 * ordinary `CREATE INDEX` in a migration takes a SHARE lock on the table for
 * the whole build, which blocks every insert, update and status change on it.
 * That matters here because of WHEN migrations run: `botctl update` migrates
 * while the OUTGOING release is still serving, so the lock lands on an
 * installation that is up and taking operator writes.
 *
 * So these live here instead. They are deliberately NOT declared in
 * `schema.ts`: drizzle-kit would then generate a migration for each one and the
 * drift check would never come back clean. That is the same arrangement as the
 * hand-written guard migrations — the schema file describes what drizzle-kit
 * models, and what it does not model is described where it is applied.
 *
 * The cost of that arrangement, stated rather than glossed: `pnpm db:check`
 * cannot see these, so an index removed from this list is not a drift failure.
 * The integration suite asserts each one exists and is valid after migrating,
 * which is the check that does catch it.
 */
export interface OnlineIndex {
  /** The index name. Also the recovery key, so it never changes casually. */
  readonly name: string;
  /** Everything after `CREATE INDEX CONCURRENTLY <name>`. */
  readonly definition: string;
}

export const ONLINE_INDEXES: readonly OnlineIndex[] = [
  {
    // The panel pagination keyset: `(tenant_id, created_at, id)` filtered to
    // the live list, which is exactly what `pageKeysQuery` walks. Serves it as
    // an index-only scan with the `ROW(created_at, id) > ROW(...)`
    // continuation inside the Index Cond.
    name: 'panels_tenant_created_page_idx',
    definition:
      'ON "panels" USING btree ("tenant_id","created_at","id") WHERE status <> \'ARCHIVED\'',
  },
  {
    /*
     * The alerts pagination keyset: `(tenant_id, first_seen_at, id)`.
     *
     * The owner's decision moved that traversal off `last_seen_at`, which every
     * repeat occurrence of a deduped condition rewrites. The KEYSET moved and
     * its index did not — the only index on this table was
     * `operational_events_tenant_seen_idx` on `(tenant_id, last_seen_at)`, so
     * the new `ORDER BY first_seen_at DESC, id DESC` matched nothing and the
     * alerts page sorted the tenant's whole event history on every request.
     * That is this branch's own recurring shape: the rule applied where the
     * author was looking and absent one expression over.
     *
     * A btree serves a DESC scan of an ASC index backwards, so one index
     * covers the ordering and the `ROW(first_seen_at, id) < ROW(...)`
     * continuation. Not partial: unlike panels there is no status split here,
     * and `resolved_at` deliberately carries no index (see the schema).
     *
     * The `(tenant_id, last_seen_at)` index stays — `since`/`until` remain an
     * ACTIVITY filter on `last_seen_at` and still use it.
     */
    name: 'operational_events_tenant_first_seen_page_idx',
    definition: 'ON "operational_events" USING btree ("tenant_id","first_seen_at","id")',
  },
  {
    // The same keyset for the OTHER side of the archive. The live index above
    // is partial on `status <> 'ARCHIVED'`, so the archive browser — added so a
    // retired panel can be found and restored — matched no index at all and
    // paged by sequential scan over the whole table. Its own partial index
    // costs nothing on the live path and is small, because the archive is
    // where panels go to stop being many.
    name: 'panels_tenant_archived_page_idx',
    definition:
      'ON "panels" USING btree ("tenant_id","created_at","id") WHERE status = \'ARCHIVED\'',
  },
];

/** Index names are code constants; this refuses one that stopped being one. */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

type IndexState = 'MISSING' | 'VALID' | 'INVALID';

/**
 * Whether the index is there, and whether PostgreSQL trusts it.
 *
 * `indisvalid = false` is what a `CREATE INDEX CONCURRENTLY` interrupted part
 * way through leaves behind: the index exists, the planner ignores it, and
 * `CREATE INDEX CONCURRENTLY IF NOT EXISTS` sees the name and does nothing. An
 * installation whose migration was cancelled would otherwise keep the broken
 * index for ever and pay a sequential scan per page, with nothing saying so.
 */
async function indexState(client: PoolClient, name: string): Promise<IndexState> {
  const result = await client.query<{ valid: boolean }>(
    `SELECT i.indisvalid AS valid
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = $1 AND n.nspname = ANY (current_schemas(false))`,
    [name],
  );
  const row = result.rows[0];
  if (row === undefined) return 'MISSING';
  return row.valid ? 'VALID' : 'INVALID';
}

/**
 * Brings every online index into existence, idempotently.
 *
 * Safe to run on every migration, which is how it is run: an index that is
 * already valid costs one catalogue lookup. Safe to run after an interrupted
 * one, which is the case that needed thinking about — the leftover invalid
 * index is dropped concurrently and rebuilt rather than being left to look
 * like a healthy one.
 *
 * Returns the names it actually built, so a caller can say so.
 */
export async function ensureOnlineIndexes(handle: DatabaseHandle): Promise<string[]> {
  const built: string[] = [];
  for (const index of ONLINE_INDEXES) {
    if (!SAFE_IDENTIFIER.test(index.name)) {
      throw new Error(`${index.name} is not a plain index name.`);
    }
    // One checkout per index, with no deadline: `withClient` sets a
    // statement_timeout only when it is given one, and a concurrent build on a
    // large table legitimately outlasts any bound the application uses for its
    // own queries.
    await handle.withClient(async (client) => {
      // One builder at a time, across processes.
      //
      // Two migrators is what a `botctl update` retried before the first
      // finished looks like, and two `CREATE INDEX CONCURRENTLY` on one table
      // do not merely race: each waits for the other and PostgreSQL reports a
      // DEADLOCK, failing a migration run whose migrations had all applied.
      //
      // TRY and poll, never a blocking `pg_advisory_lock`. A blocking wait is
      // itself an open transaction, and a concurrent build waits for every
      // transaction that can see the table — so the waiter waits for the
      // builder's lock while the builder waits for the waiter's transaction,
      // which is the same deadlock by another route. It was measured, not
      // reasoned about: the blocking version deadlocked on every run of the
      // test below. Each attempt here is its own instantaneous statement.
      const lockKey = `nexa.online-index.${index.name}`;
      const held = await pollForLock(client, lockKey);
      if (!held) {
        throw new Error(
          `another migrator has been building ${index.name} for longer than ${BUILD_LOCK_WAIT_MS}ms.`,
        );
      }
      try {
        await buildIfNeeded(client, index, built);
      } finally {
        await client.query(`SELECT pg_advisory_unlock(hashtext($1)::bigint)`, [lockKey]);
      }
    });
  }
  return built;
}

/**
 * How long to wait for another migrator's build before giving up.
 *
 * Generous: what is being waited for is a concurrent index build on a table
 * that may be large, and the alternative to waiting is two builders
 * deadlocking.
 */
const BUILD_LOCK_WAIT_MS = 30 * 60 * 1000;
const BUILD_LOCK_POLL_MS = 250;

/** Takes the build lock without ever holding a transaction open to wait. */
async function pollForLock(client: PoolClient, key: string): Promise<boolean> {
  const deadline = Date.now() + BUILD_LOCK_WAIT_MS;
  for (;;) {
    const result = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS locked`,
      [key],
    );
    if (result.rows[0]?.locked === true) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, BUILD_LOCK_POLL_MS));
  }
}

/** The build itself, with the advisory lock already held. */
async function buildIfNeeded(
  client: PoolClient,
  index: OnlineIndex,
  built: string[],
): Promise<void> {
  let state = await indexState(client, index.name);
  if (state === 'INVALID') {
    await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${index.name}"`);
    state = 'MISSING';
  }
  if (state === 'VALID') return;
  try {
    await client.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${index.name}" ${index.definition}`,
    );
  } catch (error) {
    // `IF NOT EXISTS` resolves at statement start, so two builders that
    // begin before either has its catalogue entry both proceed and the
    // loser gets a duplicate name. That is somebody else building the same
    // index, not a failure — `botctl update` retries are meant to be safe,
    // and reporting it would fail a migration run whose migrations all
    // applied. The validity check below is what decides either way.
    const code = (error as { code?: string }).code;
    if (code !== '42P07' && code !== '23505') throw error;
  }
  const after = await indexState(client, index.name);
  if (after !== 'VALID') {
    // The build finished without throwing and left something the planner
    // will not use. Loud, because the alternative is an update that reports
    // success and an installation that silently scans.
    throw new Error(`${index.name} was built but is not valid; re-run the migration.`);
  }
  built.push(index.name);
}
