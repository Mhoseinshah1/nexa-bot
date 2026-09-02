import { Pool, type PoolClient } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { applyPgTypeParsers } from './pg-type-parsers.js';
import { schema } from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

/**
 * A handle to either the pool or an open transaction. Repositories accept this
 * so the same method works inside and outside a unit of work — there is no
 * "transactional variant" of a repository to forget to use.
 */
export type Executor = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

export interface DatabaseHandle {
  readonly db: Database;
  readonly pool: Pool;
  withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Server-side bounds on how long a connection may wait or work.
 *
 * This branch made the tenant row the serialization boundary: every
 * administrator mutation takes `FOR UPDATE` on it, every login and every
 * webhook write takes `FOR SHARE`, and the API takes it again at boot to sync
 * roles. That is right, and it concentrated the whole installation onto one
 * row — measured, a burst of 16 mutations puts every concurrent login behind
 * them, from ~43ms to ~263ms.
 *
 * Waiting is fine. Waiting FOREVER is not, and Postgres defaults all three of
 * these to 0, which means exactly that: one transaction that stalls while
 * holding the tenant row blocks every login for that installation with no
 * error and no bound, until the pool fills with waiters and the API stops
 * serving anything at all. A bounded wait fails one request loudly instead.
 *
 * `idle_in_transaction_session_timeout` is the one that matters most here,
 * because the dangerous case is not a slow query — it is application code that
 * opened a transaction, took the lock, and then stalled.
 *
 * Deliberately NOT applied to migrations, which open their own handle: a long
 * index build is not a stuck transaction, and killing one halfway is worse
 * than waiting for it.
 */
export interface DatabaseTimeouts {
  /** Cap on a single statement. */
  readonly statementTimeoutMs: number;
  /** Cap on waiting for a lock. Shorter: waiting this long is already wrong. */
  readonly lockTimeoutMs: number;
  /** Cap on a transaction held open while the application does nothing. */
  readonly idleInTransactionTimeoutMs: number;
}

export function createDatabase(
  connectionString: string,
  poolMax: number,
  timeouts?: DatabaseTimeouts,
): DatabaseHandle {
  applyPgTypeParsers();

  const pool = new Pool({
    connectionString,
    max: poolMax,
    // Set as connection options rather than a `SET` per checkout: it costs no
    // round trip and cannot be skipped by a code path that forgot to run it.
    ...(timeouts
      ? {
          options: [
            `-c statement_timeout=${timeouts.statementTimeoutMs}`,
            `-c lock_timeout=${timeouts.lockTimeoutMs}`,
            `-c idle_in_transaction_session_timeout=${timeouts.idleInTransactionTimeoutMs}`,
          ].join(' '),
        }
      : {}),
  });
  const db = drizzle(pool, { schema });

  return {
    db,
    pool,
    async withClient(fn) {
      const client = await pool.connect();
      try {
        return await fn(client);
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

export const DATABASE = Symbol('DATABASE');
