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
      let state = await indexState(client, index.name);
      if (state === 'INVALID') {
        await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${index.name}"`);
        state = 'MISSING';
      }
      if (state === 'VALID') return;
      await client.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${index.name}" ${index.definition}`,
      );
      const after = await indexState(client, index.name);
      if (after !== 'VALID') {
        // The build finished without throwing and left something the planner
        // will not use. Loud, because the alternative is an update that reports
        // success and an installation that silently scans.
        throw new Error(`${index.name} was built but is not valid; re-run the migration.`);
      }
      built.push(index.name);
    });
  }
  return built;
}
