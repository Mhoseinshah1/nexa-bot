import { and, eq } from 'drizzle-orm';
import type { SecretCipher, SecretPurpose, TenantContext } from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { panelCredentials } from '../../../../infrastructure/persistence/schema.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  CredentialWrite,
  PanelCredentialStore,
  PanelCredentialSummary,
  PanelCredentialWrite,
} from '../application/ports.js';

/**
 * Panel credentials, encrypted at rest and bound to the row that owns them.
 *
 * The context passed to the cipher is `(purpose, tenantId, panelId)` and it is
 * rebuilt from the CALLER'S arguments on every read, never stored beside the
 * ciphertext. That is the whole transplant defence: a password ciphertext
 * copied into another panel's row, another tenant's row, or the username column
 * of its own row recomputes a different context and fails authentication. The
 * three purposes exist for the third case — same tenant, same entity, so the
 * purpose is the only thing left to separate them.
 *
 * This file is the only place a panel credential exists in plaintext, and it
 * exists there for the length of one expression. Nothing here logs, and the
 * values are returned to exactly one caller.
 */

interface CredentialField {
  readonly purpose: SecretPurpose;
  readonly ciphertext: string | null;
  readonly keyId: string | null;
}

export class DrizzlePanelCredentialStore implements PanelCredentialStore {
  constructor(
    private readonly db: Database,
    private readonly cipher: SecretCipher,
  ) {}

  async read(
    scope: TenantContext,
    panelId: string,
  ): Promise<{ username: string | null; password: string | null; apiToken: string | null } | null> {
    const [row] = await this.db
      .select()
      .from(panelCredentials)
      // Scoped, like every other query. A credential read that trusted the
      // panel id alone would be the single worst place in the codebase to
      // omit a tenant predicate.
      .where(
        and(eq(panelCredentials.panelId, panelId), eq(panelCredentials.tenantId, scope.tenantId)),
      )
      .limit(1);
    if (row === undefined) return null;

    const decrypt = (field: CredentialField): string | null => {
      if (field.ciphertext === null || field.keyId === null) return null;
      // The context is REBUILT here from the scope and the panel id. It is not
      // read from the row, because a stored context would be a stored claim
      // about where the ciphertext belongs — and an attacker who can write the
      // ciphertext can write the claim beside it.
      return this.cipher.decrypt(
        { keyId: field.keyId, ciphertext: field.ciphertext },
        { purpose: field.purpose, tenantId: scope.tenantId, entityId: panelId },
      );
    };

    return {
      username: decrypt({
        purpose: 'panel.username',
        ciphertext: row.usernameCiphertext,
        keyId: row.usernameKeyId,
      }),
      password: decrypt({
        purpose: 'panel.password',
        ciphertext: row.passwordCiphertext,
        keyId: row.passwordKeyId,
      }),
      apiToken: decrypt({
        purpose: 'panel.api_token',
        ciphertext: row.apiTokenCiphertext,
        keyId: row.apiTokenKeyId,
      }),
    };
  }

  async write(
    scope: TenantContext,
    panelId: string,
    write: PanelCredentialWrite,
    at: Date,
    tx: TransactionScope,
  ): Promise<PanelCredentialSummary> {
    /**
     * One credential's three columns, for one of the three write states.
     *
     * `undefined` returns an empty object, which is what makes "editing a
     * panel's name does not erase its password" true at the SQL level rather
     * than by a caller remembering to re-send it. `null` writes three NULLs,
     * which the table's CHECK constraints require to travel together.
     */
    const encode = (
      value: CredentialWrite,
      purpose: SecretPurpose,
      fields: { ciphertext: string; keyId: string; setAt: string },
    ): Record<string, unknown> => {
      if (value === undefined) return {};
      if (value === null) {
        return { [fields.ciphertext]: null, [fields.keyId]: null, [fields.setAt]: null };
      }
      const sealed = this.cipher.encrypt(value, {
        purpose,
        tenantId: scope.tenantId,
        entityId: panelId,
      });
      return {
        [fields.ciphertext]: sealed.ciphertext,
        [fields.keyId]: sealed.keyId,
        [fields.setAt]: at,
      };
    };

    const changes: Record<string, unknown> = {
      ...encode(write.username, 'panel.username', {
        ciphertext: 'usernameCiphertext',
        keyId: 'usernameKeyId',
        setAt: 'usernameSetAt',
      }),
      ...encode(write.password, 'panel.password', {
        ciphertext: 'passwordCiphertext',
        keyId: 'passwordKeyId',
        setAt: 'passwordSetAt',
      }),
      ...encode(write.apiToken, 'panel.api_token', {
        ciphertext: 'apiTokenCiphertext',
        keyId: 'apiTokenKeyId',
        setAt: 'apiTokenSetAt',
      }),
    };

    const [row] = await tx.tx
      .insert(panelCredentials)
      .values({ panelId, tenantId: scope.tenantId, ...changes })
      .onConflictDoUpdate({
        target: panelCredentials.panelId,
        set: { ...changes, updatedAt: at },
      })
      .returning({
        usernameSetAt: panelCredentials.usernameSetAt,
        passwordSetAt: panelCredentials.passwordSetAt,
        apiTokenSetAt: panelCredentials.apiTokenSetAt,
      });
    if (row === undefined) throw new Error('panel credential write returned no row');
    return row;
  }
}
