import { and, asc, eq, isNotNull, notInArray, sql } from 'drizzle-orm';
import { RECOVERY_TERMINAL_STATES, type InstallationKeySource } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  installationKeys,
  recoveryRequests,
} from '../../../../infrastructure/persistence/schema.js';
import { SECRET_COLUMNS } from '../../../../infrastructure/crypto/secret-registry.js';
import type {
  InstallationKeyRepository,
  InstallationKeyRow,
} from '../application/installation-key.ports.js';

/**
 * The advisory-lock class every writer of `installation_keys` takes.
 *
 * ASCII "IK". One lock for the table, not one per key: an import decides about
 * several ids at once, and a collision check that locked them one at a time
 * could interleave with another import's.
 */
export const INSTALLATION_KEY_LOCK_CLASS = 0x494b;

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
  };
}

export class DrizzleInstallationKeyRepository implements InstallationKeyRepository {
  constructor(private readonly db: Database) {}

  async all(tx?: unknown): Promise<readonly InstallationKeyRow[]> {
    const rows = await executorOf(this.db, tx)
      .select()
      .from(installationKeys)
      .orderBy(asc(installationKeys.importedAt), asc(installationKeys.keyId));
    return rows.map(toRow);
  }

  async lock(tx: unknown): Promise<void> {
    await executorOf(this.db, tx).execute(
      sql`SELECT pg_advisory_xact_lock(${INSTALLATION_KEY_LOCK_CLASS}, 0)`,
    );
  }

  async insert(tx: unknown, row: InstallationKeyRow): Promise<void> {
    await executorOf(this.db, tx).insert(installationKeys).values({
      id: row.id,
      keyId: row.keyId,
      fingerprint: row.fingerprint,
      wrappedMaterial: row.wrappedMaterial,
      wrappedUnderKeyId: row.wrappedUnderKeyId,
      source: row.source,
      kitId: row.kitId,
      importedAt: row.importedAt,
      importedByAdminId: row.importedByAdminId,
      importedByLabel: row.importedByLabel,
    });
  }

  async deleteIfUnchanged(tx: unknown, keyId: string, fingerprint: string): Promise<boolean> {
    const deleted = await executorOf(this.db, tx)
      .delete(installationKeys)
      .where(and(eq(installationKeys.keyId, keyId), eq(installationKeys.fingerprint, fingerprint)))
      .returning({ id: installationKeys.id });
    return deleted.length > 0;
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

  async secretCountsByKeyId(): Promise<ReadonlyMap<string, number>> {
    // The registry IS the coverage claim (`secret-registry.ts`): a column it does
    // not name is invisible here exactly as it is to `secrets retire-check`, and
    // its unit test fails the build when one is missing.
    const counts = new Map<string, number>();
    for (const column of SECRET_COLUMNS) {
      for (const row of await column.all(this.db)) {
        counts.set(row.keyId, (counts.get(row.keyId) ?? 0) + 1);
      }
    }
    return counts;
  }

  async openRecoveryWorkspaces(tx?: unknown): Promise<readonly string[]> {
    const rows = await executorOf(this.db, tx)
      .select({ path: recoveryRequests.workspacePath })
      .from(recoveryRequests)
      .where(
        and(
          notInArray(recoveryRequests.state, [...RECOVERY_TERMINAL_STATES]),
          isNotNull(recoveryRequests.workspacePath),
        ),
      );
    return rows.map((row) => row.path).filter((path): path is string => path !== null);
  }

  /** For `secrets status`: imported keys grouped by the configured key that wraps them. */
  async countsByWrappingKey(): Promise<ReadonlyMap<string, number>> {
    const rows = await this.db
      .select({ keyId: installationKeys.wrappedUnderKeyId, count: sql<number>`count(*)::int` })
      .from(installationKeys)
      .groupBy(installationKeys.wrappedUnderKeyId);
    return new Map(rows.map((row) => [row.keyId, row.count]));
  }
}
