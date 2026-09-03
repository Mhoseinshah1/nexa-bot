import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { TenantContext } from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { auditLogs } from '../../../../infrastructure/persistence/schema.js';
import type { BootstrapRecordReader } from '../application/ports.js';

/**
 * The installer's proof that it, and not somebody else, created this
 * installation's administrators.
 *
 * The row is written by `BootstrapOwnerService` in the SAME transaction as the
 * owner, so there is no window in which the owner exists and this says no. That
 * matters more than it sounds: the real staging failure interrupted the install
 * between the owner being committed and the release pointers being written, and
 * a marker file the installer wrote after the CLI returned would have been
 * missing in exactly that case — the one it exists to recognise.
 *
 * `audit_logs` refuses DELETE at the database level (0001_append_only_guards)
 * and the retention sweeper touches only sessions and login attempts, so the
 * answer does not expire.
 */
export class DrizzleBootstrapRecordReader implements BootstrapRecordReader {
  constructor(private readonly db: Database) {}

  async wasBootstrapped(scope: TenantContext): Promise<boolean> {
    const where: SQL | undefined = and(
      eq(auditLogs.tenantId, scope.tenantId),
      eq(auditLogs.action, 'admin.bootstrap'),
      eq(auditLogs.result, 'SUCCESS'),
    );
    const rows = await this.db
      .select({ one: sql<number>`1` })
      .from(auditLogs)
      .where(where)
      .limit(1);
    return rows.length > 0;
  }
}
