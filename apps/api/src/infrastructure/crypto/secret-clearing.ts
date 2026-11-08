import type { SecretPurpose } from '@nexa/contracts';
import type { SecretRowQueryable, UnreadableSecret } from './secret-trial.js';

/**
 * NEXA-FIX-RESTORE-SECRETS §2.3, choice 2 («ادامه؛ این‌ها را دوباره وارد می‌کنم»): makes
 * every secret a restore could not read READ AS NOT SET, in the candidate, before the
 * cut-over — and records one `secret_reentry_items` row per value.
 *
 * Runs on a connection to the CANDIDATE only (`PgCandidateKeyStore.use`, which refuses
 * the live name), in ONE transaction: the clearing and its records commit together or
 * not at all. It touches exactly the rows the trial named, matched by entity id AND
 * tenant id, so a value of another tenant is never cleared by an id collision.
 *
 * Per purpose, the representation this codebase already has for "not set" — never a
 * placeholder value, never a money movement, never a customer message:
 *
 * - `bot_instance.token` — NOT NULL, and a bot has no "no token" state. The bot is
 *   STOPPED (the operator status every token reader already honours: `activeTokenFor…`
 *   and `tokenForBotInstance` select ACTIVE only), and the unreadable ciphertext stays
 *   until the token is replaced on «ربات‌ها». It is returned as `kept`, so the rewrap and
 *   its proof leave exactly those rows alone.
 * - `panel.*`, `payment_gateway.webhook_secret`/`verify_key`, `gift_card.batch_export`,
 *   `legacy_migration.package_key` — nullable: ciphertext, key id (and set-at where the
 *   column has one) set to NULL, which is the column's own "not set".
 * - `payment_gateway.api_key`, `support_ai_provider.api_key` — NOT NULL on a pure
 *   credential row whose documented "not configured" is no row: the row is deleted. A
 *   gateway row holding ANOTHER secret that does read is refused instead (deleting it
 *   would lose a value nobody acknowledged).
 * - `backup.archive_password` — a pure credential row; "no backup password" is no
 *   current row: deleted.
 * - `admin.totp_secret`, `hosting.totp_secret` — disabling a factor DELETES its row
 *   (`admin_totp_factors` docblock); the item names the ADMIN, who enrols again.
 * - `payment_gateway.refund_card` — REFUSED. The sealed card exists exactly while a
 *   refund is REQUESTED (a CHECK), so clearing it means changing a refund's state, and a
 *   restore never moves money. The Recovery Kit is the only way through.
 */

export interface SecretClearingInput {
  readonly unreadable: readonly UnreadableSecret[];
  readonly recoveryId: string;
  readonly now: Date;
  readonly newId: () => string;
}

export interface SecretClearingReport {
  /** Values that now read as not set (or, for a bot token, whose bot is stopped). */
  readonly cleared: number;
  /** Rows left in place, unreadable, because their entity was disabled instead. */
  readonly kept: readonly UnreadableSecret[];
  /** `secret_reentry_items` rows written. */
  readonly items: number;
}

/** A value this step will not clear, with the reason as a machine code. */
export class SecretClearingRefused extends Error {
  constructor(
    readonly purpose: SecretPurpose,
    readonly reason: 'money_bound' | 'readable_sibling' | 'unknown_purpose',
  ) {
    super(`refusing to clear ${purpose}: ${reason}`);
    this.name = 'SecretClearingRefused';
  }
}

/** Purposes this step can never clear. Checked before anything is written. */
export const UNCLEARABLE_PURPOSES: readonly SecretPurpose[] = ['payment_gateway.refund_card'];

const NULLABLE_COLUMNS: Readonly<
  Partial<Record<SecretPurpose, { table: string; entity: string; columns: readonly string[] }>>
> = {
  'panel.username': {
    table: 'panel_credentials',
    entity: 'panel_id',
    columns: ['username_ciphertext', 'username_key_id', 'username_set_at'],
  },
  'panel.password': {
    table: 'panel_credentials',
    entity: 'panel_id',
    columns: ['password_ciphertext', 'password_key_id', 'password_set_at'],
  },
  'panel.api_token': {
    table: 'panel_credentials',
    entity: 'panel_id',
    columns: ['api_token_ciphertext', 'api_token_key_id', 'api_token_set_at'],
  },
  'payment_gateway.webhook_secret': {
    table: 'payment_gateway_credentials',
    entity: 'id',
    columns: ['webhook_secret_ciphertext', 'webhook_secret_key_id', 'webhook_secret_set_at'],
  },
  'payment_gateway.verify_key': {
    table: 'payment_gateway_credentials',
    entity: 'id',
    columns: ['verify_key_ciphertext', 'verify_key_key_id', 'verify_key_set_at'],
  },
  'legacy_migration.package_key': {
    table: 'legacy_nxpkg_imports',
    entity: 'id',
    columns: ['key_ciphertext', 'key_key_id'],
  },
  'gift_card.batch_export': {
    table: 'gift_card_batches',
    entity: 'id',
    columns: ['export_ciphertext', 'export_key_id'],
  },
};

/** The other secrets a payment gateway credential row carries, besides its API key. */
const GATEWAY_SIBLINGS = [
  { purpose: 'payment_gateway.webhook_secret', column: 'webhook_secret_ciphertext' },
  { purpose: 'payment_gateway.verify_key', column: 'verify_key_ciphertext' },
] as const;

interface ItemRow {
  readonly tenantId: string;
  readonly purpose: SecretPurpose;
  readonly entityTable: string;
  readonly entityId: string;
  readonly entityKey: string | null;
}

/** Clears every value in `input.unreadable` in one transaction on `db`. See the module docblock. */
export async function clearUnreadableSecrets(
  db: SecretRowQueryable,
  input: SecretClearingInput,
): Promise<SecretClearingReport> {
  for (const row of input.unreadable) {
    if (UNCLEARABLE_PURPOSES.includes(row.purpose)) {
      throw new SecretClearingRefused(row.purpose, 'money_bound');
    }
  }
  const unreadableKey = new Set(input.unreadable.map((row) => `${row.purpose}|${row.entityId}`));
  const items: ItemRow[] = [];
  const kept: UnreadableSecret[] = [];
  let cleared = 0;

  await db.query('BEGIN');
  try {
    // Gateway providers read BEFORE any write: clearing the API key deletes the row,
    // and its webhook/verify items still need the provider to say where to re-enter.
    const gatewayIds = input.unreadable
      .filter((row) => row.table === 'payment_gateway_credentials')
      .map((row) => row.entityId);
    const providers = new Map<string, string>();
    const deletedGatewayRows = new Set<string>();
    if (gatewayIds.length > 0) {
      const found = await db.query<{ id: string; provider: string }>(
        `SELECT id::text AS id, provider FROM payment_gateway_credentials
          WHERE id::text = ANY($1::text[])`,
        [gatewayIds],
      );
      for (const entry of found.rows) providers.set(entry.id, entry.provider);
    }
    for (const row of input.unreadable) {
      const where = [row.entityId, row.tenantId];
      const nullable = NULLABLE_COLUMNS[row.purpose];
      if (nullable !== undefined) {
        const sets = nullable.columns.map((column) => `"${column}" = NULL`).join(', ');
        const touched = await db.query(
          `UPDATE "${nullable.table}" SET ${sets}
            WHERE "${nullable.entity}"::text = $1 AND tenant_id::text = $2`,
          where,
        );
        // A gateway row this run's API-key clearing deleted took the value with it.
        if (touched.rowCount === 1 || deletedGatewayRows.has(`${row.entityId}|${row.tenantId}`)) {
          cleared += 1;
          items.push({
            tenantId: row.tenantId,
            purpose: row.purpose,
            // A panel's value is re-entered on the panel; the rest on their own row.
            entityTable: nullable.table === 'panel_credentials' ? 'panels' : nullable.table,
            entityId: row.entityId,
            entityKey: providers.get(row.entityId) ?? null,
          });
        }
        continue;
      }
      switch (row.purpose) {
        case 'bot_instance.token': {
          const bot = await db.query(
            'SELECT 1 FROM bot_instances WHERE id::text = $1 AND tenant_id::text = $2 FOR UPDATE',
            where,
          );
          if (bot.rowCount !== 1) break;
          // An already stopped (or DISABLED) bot stays as it is.
          await db.query(
            `UPDATE bot_instances SET status = 'STOPPED', updated_at = $3
              WHERE id::text = $1 AND tenant_id::text = $2 AND status = 'ACTIVE'`,
            [...where, input.now],
          );
          kept.push(row);
          cleared += 1;
          items.push({ ...identity(row, 'bot_instances'), entityKey: null });
          break;
        }
        case 'payment_gateway.api_key': {
          const siblings = await db.query<Record<string, string | null>>(
            `SELECT provider, webhook_secret_ciphertext, verify_key_ciphertext
               FROM payment_gateway_credentials WHERE id::text = $1 AND tenant_id::text = $2`,
            where,
          );
          const found = siblings.rows[0];
          if (found === undefined) break;
          for (const sibling of GATEWAY_SIBLINGS) {
            if (
              found[sibling.column] !== null &&
              !unreadableKey.has(`${sibling.purpose}|${row.entityId}`)
            ) {
              throw new SecretClearingRefused(row.purpose, 'readable_sibling');
            }
          }
          await db.query(
            'DELETE FROM payment_gateway_credentials WHERE id::text = $1 AND tenant_id::text = $2',
            where,
          );
          deletedGatewayRows.add(`${row.entityId}|${row.tenantId}`);
          cleared += 1;
          items.push({
            ...identity(row, 'payment_gateway_credentials'),
            entityKey: providers.get(row.entityId) ?? found.provider ?? null,
          });
          break;
        }
        case 'support_ai_provider.api_key': {
          const deleted = await db.query<{ provider: string }>(
            `DELETE FROM support_ai_provider_credentials
              WHERE id::text = $1 AND tenant_id::text = $2 RETURNING provider`,
            where,
          );
          if (deleted.rows[0] === undefined) break;
          cleared += 1;
          items.push({
            ...identity(row, 'support_ai_provider_credentials'),
            entityKey: deleted.rows[0].provider,
          });
          break;
        }
        case 'backup.archive_password': {
          const deleted = await db.query(
            'DELETE FROM backup_archive_passwords WHERE id::text = $1 AND tenant_id::text = $2',
            where,
          );
          if (deleted.rowCount !== 1) break;
          cleared += 1;
          items.push({ ...identity(row, 'backup_archive_passwords'), entityKey: null });
          break;
        }
        case 'admin.totp_secret':
        case 'hosting.totp_secret': {
          const table =
            row.purpose === 'admin.totp_secret' ? 'admin_totp_factors' : 'hosting_totp_factors';
          const deleted = await db.query<{ admin_id: string }>(
            `DELETE FROM ${table} WHERE id::text = $1 AND tenant_id::text = $2
              RETURNING admin_id::text AS admin_id`,
            where,
          );
          const adminId = deleted.rows[0]?.admin_id;
          if (adminId === undefined) break;
          cleared += 1;
          // The ADMIN is what re-enrols: a new factor gets a new id.
          items.push({
            tenantId: row.tenantId,
            purpose: row.purpose,
            entityTable: 'admins',
            entityId: adminId,
            entityKey: table,
          });
          break;
        }
        default:
          throw new SecretClearingRefused(row.purpose, 'unknown_purpose');
      }
    }
    for (const item of items) {
      await db.query(
        `INSERT INTO secret_reentry_items
           (id, tenant_id, purpose, entity_table, entity_id, entity_key, recovery_request_id, cleared_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          input.newId(),
          item.tenantId,
          item.purpose,
          item.entityTable,
          item.entityId,
          item.entityKey,
          input.recoveryId,
          input.now,
        ],
      );
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
  return { cleared, kept, items: items.length };
}

function identity(row: UnreadableSecret, entityTable: string): Omit<ItemRow, 'entityKey'> {
  return {
    tenantId: row.tenantId,
    purpose: row.purpose,
    entityTable,
    entityId: row.entityId,
  };
}
