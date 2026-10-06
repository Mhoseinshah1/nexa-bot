import { Client } from 'pg';
import type { LegacyImportProcessLease, LegacyImportProcessLock } from '../application/ports.js';

/** `pg_try_advisory_lock` class of the importer's per-tenant process claim ('LI'). */
export const LEGACY_IMPORT_PROCESS_LOCK_CLASS = 0x4c49;

/**
 * The importer's process claim as a SESSION advisory lock on a connection of its own.
 *
 * Its own `pg.Client`, never one checked out of the pool: the claim is held for the whole
 * import, and a pooled connection held that long starves the pool the import itself
 * writes through (at `DATABASE_POOL_MAX=1`, completely — `permission-guard.ts` records that
 * deadlock). A session lock and not a transaction one, because no transaction spans an
 * import. When the process dies the server ends the session and the lock goes with it, so
 * a resume after a crash is never refused by a dead holder.
 */
export class PgLegacyImportProcessLock implements LegacyImportProcessLock {
  constructor(private readonly databaseUrl: string) {}

  async tryAcquire(tenantId: string): Promise<LegacyImportProcessLease | null> {
    const client = new Client({ connectionString: this.databaseUrl });
    // A connection-level failure must not escape as an unhandled 'error' event.
    client.on('error', () => undefined);
    await client.connect();
    let held = false;
    try {
      const result = await client.query<{ ok: boolean }>(
        'SELECT pg_try_advisory_lock($1::int, hashtext($2::text)) AS ok',
        [LEGACY_IMPORT_PROCESS_LOCK_CLASS, tenantId],
      );
      held = result.rows[0]?.ok === true;
    } finally {
      if (!held) await client.end().catch(() => undefined);
    }
    if (!held) return null;
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        // Ending the session releases the lock; the explicit unlock only makes it prompt.
        await client
          .query('SELECT pg_advisory_unlock($1::int, hashtext($2::text))', [
            LEGACY_IMPORT_PROCESS_LOCK_CLASS,
            tenantId,
          ])
          .catch(() => undefined);
        await client.end().catch(() => undefined);
      },
    };
  }
}
