import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import type { InstallationKeySource } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { installationKeys } from '../../../../infrastructure/persistence/schema.js';
import { SECRET_COLUMNS } from '../../../../infrastructure/crypto/secret-registry.js';
import type {
  InstallationKeyRepository,
  InstallationKeyRow,
} from '../application/installation-key.ports.js';
import { ScopeBound } from '../../../../infrastructure/persistence/database-scope.js';

/** A physical identifier from the registry, checked before it is interpolated. */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function executorOf(db: Database, tx: unknown): Executor {
  // A `TransactionScope` from the unit of work, unwrapped — the same convention
  // every `tx?: unknown` parameter in this codebase follows.
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

function toRow(row: typeof installationKeys.$inferSelect): InstallationKeyRow {
  return {
    id: row.id,
    keyId: row.keyId,
    fingerprint: row.fingerprint,
    wrappedMaterial: row.wrappedMaterial,
    wrappedUnderKeyId: row.wrappedUnderKeyId,
    source: row.source as InstallationKeySource,
    kitId: row.kitId,
    importedAt: row.importedAt,
    importedByAdminId: row.importedByAdminId,
    importedByLabel: row.importedByLabel,
    removedAt: row.removedAt,
    removedByLabel: row.removedByLabel,
    restoredAt: row.restoredAt,
  };
}

@ScopeBound({ installation: true })
export class DrizzleInstallationKeyRepository implements InstallationKeyRepository {
  constructor(private readonly db: Database) {}

  async all(tx?: unknown): Promise<readonly InstallationKeyRow[]> {
    const rows = await executorOf(this.db, tx)
      .select()
      .from(installationKeys)
      .orderBy(asc(installationKeys.importedAt), asc(installationKeys.keyId));
    return rows.map(toRow);
  }

  async rewrap(
    tx: unknown,
    keyId: string,
    expectedWrapped: string,
    next: { wrappedMaterial: string; wrappedUnderKeyId: string },
  ): Promise<boolean> {
    const updated = await executorOf(this.db, tx)
      .update(installationKeys)
      .set({ wrappedMaterial: next.wrappedMaterial, wrappedUnderKeyId: next.wrappedUnderKeyId })
      .where(
        and(
          eq(installationKeys.keyId, keyId),
          eq(installationKeys.wrappedMaterial, expectedWrapped),
        ),
      )
      .returning({ id: installationKeys.id });
    return updated.length > 0;
  }

  /**
   * Stored secrets by recorded key id: one `GROUP BY` per registered column.
   *
   * The registry IS the coverage claim (`secret-registry.ts`): a column it does
   * not name is invisible here exactly as it is to `secrets retire-check`, and
   * its unit test fails the build when one is missing. Counted in the database,
   * not by reading every ciphertext into this process.
   */
  async secretCountsByKeyId(): Promise<ReadonlyMap<string, number>> {
    const counts = new Map<string, number>();
    for (const column of SECRET_COLUMNS) {
      if (!IDENTIFIER.test(column.table) || !IDENTIFIER.test(column.keyIdColumn)) {
        throw new Error(`unexpected identifier in the secret registry: ${column.table}`);
      }
      const result = await this.db.execute(
        sql.raw(
          `SELECT "${column.keyIdColumn}" AS key_id, count(*)::int AS n FROM "${column.table}" ` +
            `WHERE "${column.keyIdColumn}" IS NOT NULL GROUP BY 1`,
        ),
      );
      for (const row of result.rows as { key_id: string; n: number }[]) {
        counts.set(row.key_id, (counts.get(row.key_id) ?? 0) + Number(row.n));
      }
    }
    return counts;
  }

  /** For `secrets status`: live imported keys grouped by the configured key that wraps them. */
  async countsByWrappingKey(): Promise<ReadonlyMap<string, number>> {
    const rows = await this.db
      .select({ keyId: installationKeys.wrappedUnderKeyId, count: sql<number>`count(*)::int` })
      .from(installationKeys)
      .where(isNotNull(installationKeys.wrappedUnderKeyId))
      .groupBy(installationKeys.wrappedUnderKeyId);
    return new Map(
      rows
        .filter((row): row is { keyId: string; count: number } => row.keyId !== null)
        .map((row) => [row.keyId, row.count]),
    );
  }
}
