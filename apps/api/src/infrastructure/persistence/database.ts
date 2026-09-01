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

export function createDatabase(connectionString: string, poolMax: number): DatabaseHandle {
  applyPgTypeParsers();

  const pool = new Pool({ connectionString, max: poolMax });
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
