import { sql } from 'drizzle-orm';
import type { TenantContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  AdminReadWindowStore,
  KnownAdminIpStore,
  KnownIpVerdict,
} from '../application/ports.js';

function executorOf(db: Database, tx: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

/** How long a finished read window is kept before the same administrator's next read removes it. */
const READ_WINDOW_KEEP = '1 day';

/**
 * Phase 6A D0: the remembered sign-in addresses and the per-administrator read windows.
 * Each method is one statement, so concurrent callers serialise on the primary key rather
 * than on a read-then-write in JavaScript.
 */
export class DrizzleOwnerAlertStore implements KnownAdminIpStore, AdminReadWindowStore {
  constructor(private readonly db: Database) {}

  async remember(
    scope: TenantContext,
    input: { readonly adminId: string; readonly ip: string; readonly now: Date },
    tx: unknown,
  ): Promise<KnownIpVerdict> {
    const tenantId = requireTenantId(scope);
    // `prior` is read in the same statement, from the snapshot BEFORE the upsert, so the
    // first-ever sign-in is told apart from a new address without a second round trip.
    // `xmax = 0` is PostgreSQL's mark of a row this statement INSERTED (vs. updated).
    const result = await executorOf(this.db, tx).execute(sql`
      WITH prior AS (
        SELECT count(*)::int AS n FROM admin_known_ips
        WHERE tenant_id = ${tenantId} AND admin_id = ${input.adminId}
      ), upserted AS (
        INSERT INTO admin_known_ips (tenant_id, admin_id, ip, first_seen_at, last_seen_at)
        VALUES (${tenantId}, ${input.adminId}, ${input.ip}, ${input.now}, ${input.now})
        ON CONFLICT (tenant_id, admin_id, ip) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at
        RETURNING (xmax = 0) AS inserted
      )
      SELECT upserted.inserted AS inserted, prior.n AS prior FROM upserted, prior
    `);
    const [row] = result.rows as unknown as { inserted: boolean; prior: number }[];
    if (row === undefined || !row.inserted) return 'KNOWN';
    return Number(row.prior) === 0 ? 'FIRST_EVER' : 'NEW';
  }

  async add(
    scope: TenantContext,
    input: {
      readonly adminId: string;
      readonly windowStart: Date;
      readonly rows: number;
      readonly threshold: number;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<{ readonly rowsInWindow: number; readonly claimedAlert: boolean }> {
    const tenantId = requireTenantId(scope);
    const executor = executorOf(this.db, tx);
    const upserted = await executor.execute(sql`
      INSERT INTO admin_read_windows (tenant_id, admin_id, window_start, rows_read, updated_at)
      VALUES (${tenantId}, ${input.adminId}, ${input.windowStart}, ${input.rows}, ${input.now})
      ON CONFLICT (tenant_id, admin_id, window_start) DO UPDATE SET
        rows_read = admin_read_windows.rows_read + EXCLUDED.rows_read,
        updated_at = EXCLUDED.updated_at
      RETURNING rows_read AS rows_in_window
    `);
    const [row] = upserted.rows as unknown as { rows_in_window: number | string }[];
    const rowsInWindow = Number(row?.rows_in_window ?? 0);
    // The claim is its own conditional UPDATE: the row lock re-checks `alerted_at IS NULL`,
    // so of two replicas crossing the threshold together exactly one is told it claimed it.
    let claimedAlert = false;
    if (input.threshold > 0 && rowsInWindow > input.threshold) {
      const claimed = await executor.execute(sql`
        UPDATE admin_read_windows SET alerted_at = ${input.now}
        WHERE tenant_id = ${tenantId} AND admin_id = ${input.adminId}
          AND window_start = ${input.windowStart} AND alerted_at IS NULL
          AND rows_read > ${input.threshold}
        RETURNING 1 AS claimed
      `);
      claimedAlert = claimed.rows.length > 0;
    }
    // The same administrator's finished windows, older than a day, go with this read.
    await executor.execute(sql`
      DELETE FROM admin_read_windows
      WHERE tenant_id = ${tenantId} AND admin_id = ${input.adminId}
        AND window_start < ${input.now}::timestamptz - ${READ_WINDOW_KEEP}::interval
    `);
    return { rowsInWindow, claimedAlert };
  }
}
