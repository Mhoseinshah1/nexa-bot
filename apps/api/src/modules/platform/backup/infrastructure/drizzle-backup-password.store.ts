import { and, desc, eq, isNull } from 'drizzle-orm';
import type { ScopeContext, SecretCipher, TenantContext } from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { backupArchivePasswords } from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type { BackupArchivePasswordSource } from '../application/ports.js';
import type {
  BackupPasswordStore,
  StoredBackupPassword,
} from '../application/backup-password.service.js';

/**
 * The backup passwords table (E4): the writer the password service uses, and the
 * DECRYPTING source the archiver uses — on the installation tenant, which is the one a
 * backup belongs to (a backup is the whole database).
 *
 * The source decrypts on every call rather than caching: a password set from the Web
 * Admin applies to the next run in every process (the worker seals, the api verifies an
 * upload, the recovery executor re-opens) with no restart and no cache to invalidate.
 */
export class DrizzleBackupPasswordStore implements BackupPasswordStore {
  constructor(
    private readonly db: Database,
    private readonly cipher: SecretCipher,
    /** The installation's tenant, or null before provisioning (no password can exist). */
    private readonly installation: () => ScopeContext | null,
  ) {}

  async current(scope: TenantContext, tx?: TransactionScope): Promise<StoredBackupPassword | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await (tx?.tx ?? this.db)
      .select({ id: backupArchivePasswords.id, createdAt: backupArchivePasswords.createdAt })
      .from(backupArchivePasswords)
      .where(
        and(
          eq(backupArchivePasswords.tenantId, tenantId),
          isNull(backupArchivePasswords.supersededAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async replace(
    scope: TenantContext,
    input: { id: string; ciphertext: string; keyId: string; now: Date; adminId: string | null },
    tx: TransactionScope,
  ): Promise<{ supersededId: string | null }> {
    const tenantId = requireTenantId(scope);
    const db = tx?.tx ?? this.db;
    // Supersede first, so the partial unique index ("one current per tenant") holds at
    // every statement; two concurrent replacements serialise on that row.
    const superseded = await db
      .update(backupArchivePasswords)
      .set({ supersededAt: input.now })
      .where(
        and(
          eq(backupArchivePasswords.tenantId, tenantId),
          isNull(backupArchivePasswords.supersededAt),
        ),
      )
      .returning({ id: backupArchivePasswords.id });
    await db.insert(backupArchivePasswords).values({
      id: input.id,
      tenantId,
      passwordCiphertext: input.ciphertext,
      passwordKeyId: input.keyId,
      createdAt: input.now,
      createdByAdminId: input.adminId,
      supersededAt: null,
    });
    return { supersededId: superseded[0]?.id ?? null };
  }

  /** The password new archives are sealed with. */
  async currentDecrypted(): Promise<{ id: string; password: string } | null> {
    return (await this.decryptAll(true))[0] ?? null;
  }

  async all(): Promise<readonly { id: string; password: string }[]> {
    return this.decryptAll(false);
  }

  private async decryptAll(currentOnly: boolean): Promise<{ id: string; password: string }[]> {
    const scope = this.installation();
    if (scope === null || !('tenantId' in scope)) return [];
    const tenantId = scope.tenantId;
    const rows = await this.db
      .select({
        id: backupArchivePasswords.id,
        ciphertext: backupArchivePasswords.passwordCiphertext,
        keyId: backupArchivePasswords.passwordKeyId,
      })
      .from(backupArchivePasswords)
      .where(
        currentOnly
          ? and(
              eq(backupArchivePasswords.tenantId, tenantId),
              isNull(backupArchivePasswords.supersededAt),
            )
          : eq(backupArchivePasswords.tenantId, tenantId),
      )
      .orderBy(desc(backupArchivePasswords.createdAt), desc(backupArchivePasswords.id));
    return rows.map((row) => ({
      id: row.id,
      password: this.cipher.decrypt(
        { ciphertext: row.ciphertext, keyId: row.keyId },
        { purpose: 'backup.archive_password', tenantId, entityId: row.id },
      ),
    }));
  }
}

/**
 * The archiver's view of the store: `current()` here means the DECRYPTED current password,
 * which is a different method from the writer's `current(scope)` above — so it is a
 * separate object rather than an overload nobody can read.
 */
export function backupArchivePasswordSource(
  store: DrizzleBackupPasswordStore,
): BackupArchivePasswordSource {
  return {
    current: () => store.currentDecrypted(),
    all: () => store.all(),
  };
}
