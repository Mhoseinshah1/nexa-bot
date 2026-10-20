import type { PoolClient } from 'pg';
import type { DatabaseHandle } from './database.js';

/**
 * The backfill of short public codes (Round 4, PR-C) onto every row that existed before
 * migration 0260 — the imported history included: about 198k customers' worth of orders,
 * 82k services and 213k payments on the owner's test server.
 *
 * Every INSERT since 0261 is coded by the database itself (`nexa_assign_public_code`), so
 * this only ever has the rows from before to reach. It runs AFTER the migrator, from
 * `runMigrations`, for the reason `online-indexes.ts` gives: drizzle runs every pending
 * migration in ONE transaction, and an `UPDATE` of every payment inside it would hold a row
 * lock on every payment until the whole release's migrations commit — while the outgoing
 * release is still serving (`botctl update` migrates beside it).
 *
 * So, instead:
 *
 * - **Keyset batches**, each its own short transaction: the next `BATCH` ids after the
 *   cursor, in primary-key order, whose code is still NULL. The lock a batch takes is held
 *   for one batch, and a live transaction waits at most one batch for it (`lock_timeout`
 *   bounds the other direction).
 * - **Idempotent**: only `code IS NULL` is ever written, and 0261 refuses changing a code
 *   that is set, so a second run writes nothing and an earlier run's codes are never redrawn.
 * - **Resumable**: there is no progress row to trust. An interrupted run leaves some rows
 *   coded and some NULL; the next run starts its cursor at the beginning and the `code IS
 *   NULL` predicate is the progress.
 * - **A collision is retried, never resolved by hand**: a batch that drew a code another
 *   row holds (or two of its rows drew the same one) is refused by `<table>_tenant_code_key`,
 *   rolled back whole, and drawn again. A deadlock against a live transaction and a lock
 *   wait past the bound are retried the same way.
 * - **Nothing else happens**: no outbox row, no audit row, no notification, no panel call.
 *   A code is presentation, and no consumer reacts to its arrival.
 *
 * Products are numbered (`P-101`, `P-102`, …) per tenant, oldest first, under the same
 * per-tenant advisory lock the insert trigger takes, so a product created while the backfill
 * runs cannot take a number the backfill is giving out. A catalogue is tens of rows, so one
 * short transaction per tenant.
 */
export const PUBLIC_CODE_TABLES = ['orders', 'payments', 'services', 'tickets'] as const;
export type PublicCodeTable = (typeof PUBLIC_CODE_TABLES)[number];

export const PUBLIC_CODE_BACKFILL_BATCH = 500;
const MAX_BATCH_ATTEMPTS = 8;
/** SQLSTATEs a batch is rolled back and drawn again on. */
const RETRYABLE = new Set(['23505', '40P01', '55P03', '40001']);

export interface PublicCodeBackfillOptions {
  readonly batchSize?: number;
  /**
   * Stop after this many batches in all (tests: an interrupted run). The report then says
   * `complete: false` for the table it stopped in and every table after it.
   */
  readonly maxBatches?: number;
}

export interface PublicCodeBackfillReport {
  readonly table: PublicCodeTable | 'products';
  readonly filled: number;
  readonly complete: boolean;
}

export async function backfillPublicCodes(
  handle: DatabaseHandle,
  options: PublicCodeBackfillOptions = {},
): Promise<PublicCodeBackfillReport[]> {
  const batchSize = options.batchSize ?? PUBLIC_CODE_BACKFILL_BATCH;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('batchSize must be >= 1.');
  let budget = options.maxBatches ?? Number.POSITIVE_INFINITY;
  const reports: PublicCodeBackfillReport[] = [];
  await handle.withClient(async (client) => {
    for (const table of PUBLIC_CODE_TABLES) {
      let filled = 0;
      let cursor: string | null = null;
      let complete = false;
      while (budget > 0) {
        budget -= 1;
        const batch = await codeBatch(client, table, cursor, batchSize);
        filled += batch.filled;
        if (batch.last === null) {
          complete = true;
          break;
        }
        cursor = batch.last;
      }
      reports.push({ table, filled, complete });
    }
    if (budget > 0) {
      reports.push({ table: 'products', filled: await numberProducts(client), complete: true });
    } else {
      reports.push({ table: 'products', filled: 0, complete: false });
    }
  });
  return reports;
}

/**
 * One batch, in its own transaction: lock the next ids after the cursor whose code is NULL,
 * give each a fresh draw, commit. `last` is null when there was nothing left after the cursor.
 */
async function codeBatch(
  client: PoolClient,
  table: PublicCodeTable,
  cursor: string | null,
  batchSize: number,
): Promise<{ filled: number; last: string | null }> {
  // The table name is one of four literals above, never input.
  for (let attempt = 1; ; attempt += 1) {
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL lock_timeout = '5s'`);
      const ids = await client.query<{ id: string }>(
        `SELECT id FROM "${table}"
          WHERE code IS NULL AND ($1::uuid IS NULL OR id > $1::uuid)
          ORDER BY id
          LIMIT $2
          FOR UPDATE`,
        [cursor, batchSize],
      );
      const last = ids.rows.at(-1)?.id ?? null;
      let filled = 0;
      if (last !== null) {
        const updated = await client.query(
          `UPDATE "${table}" SET code = nexa_public_code()
            WHERE id = ANY($1::uuid[]) AND code IS NULL`,
          [ids.rows.map((row) => row.id)],
        );
        filled = updated.rowCount ?? 0;
      }
      await client.query('COMMIT');
      return { filled, last };
    } catch (error) {
      await client.query('ROLLBACK');
      const code = (error as { code?: unknown }).code;
      if (typeof code !== 'string' || !RETRYABLE.has(code) || attempt >= MAX_BATCH_ATTEMPTS) {
        throw error;
      }
    }
  }
}

/** Every tenant's un-numbered products, oldest first, after the tenant's highest number. */
async function numberProducts(client: PoolClient): Promise<number> {
  const tenants = await client.query<{ tenant_id: string }>(
    `SELECT DISTINCT tenant_id FROM products WHERE code_number IS NULL`,
  );
  let filled = 0;
  for (const { tenant_id: tenantId } of tenants.rows) {
    await client.query('BEGIN');
    try {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext('nexa.product-code'), hashtext($1::text))`,
        [tenantId],
      );
      const updated = await client.query(
        `UPDATE products AS p
            SET code_number = base.n + ranked.position
           FROM (SELECT coalesce(max(code_number), 100) AS n
                   FROM products WHERE tenant_id = $1) AS base,
                (SELECT id, row_number() OVER (ORDER BY created_at, id) AS position
                   FROM products WHERE tenant_id = $1 AND code_number IS NULL) AS ranked
          WHERE p.id = ranked.id AND p.code_number IS NULL`,
        [tenantId],
      );
      await client.query('COMMIT');
      filled += updated.rowCount ?? 0;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  return filled;
}
