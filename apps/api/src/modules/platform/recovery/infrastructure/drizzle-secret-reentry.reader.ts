import { sql } from 'drizzle-orm';
import {
  unreadableSecretKindOf,
  type ScopeContext,
  type SecretCipher,
  type SecretPurpose,
  type SecretReentryItem,
  type SecretReentryPlace,
} from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { ScopeBound } from '../../../../infrastructure/persistence/database-scope.js';
import { requireTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { SecretReentryReader } from '../application/secret-reentry.service.js';

/**
 * The Web Admin's attention strip (NEXA-FIX-RESTORE-SECRETS §2.3): every secret a restore
 * cleared that is STILL not set or not readable, decided NOW.
 *
 * Nothing marks an item done. Each one is checked against its entity's column at read
 * time — set and authenticated-decryptable means re-entered — so the ordinary pages
 * (bots, panels, payment methods, backup, support AI, account) remove items by writing
 * the value as they always do, without knowing this table exists.
 *
 * Tenant-scoped twice: `requireTenantId` in every predicate, and row-level security on
 * the bound connection (ADR-0037). Never returns a value, a ciphertext or a key id; the
 * cipher is asked only whether a value decrypts.
 *
 * Not listed: `legacy_migration.package_key` and `gift_card.batch_export` — nothing can
 * be re-entered for them (a package is imported again; a sealed export expires), so an
 * item could never leave the strip. Their re-entry rows still record the clearing.
 *
 * Not listed either, on purpose: `reseller_web.totp_secret` (PR-4). A reseller's panel factor
 * is re-entered by the RESELLER, from their own panel, never on a Web Admin page, so an item
 * on the operator's strip would name work the operator cannot do. Its clearing deletes the
 * factor (the reseller signs in without a code until they enrol again) and the re-entry row
 * records it, naming the reseller's customer (`secret-clearing.ts`).
 */

const PLACES: Readonly<Partial<Record<SecretPurpose, SecretReentryPlace>>> = {
  'bot_instance.token': 'bots',
  'panel.username': 'panels',
  'panel.password': 'panels',
  'panel.api_token': 'panels',
  'payment_gateway.api_key': 'payment-gateways',
  'payment_gateway.webhook_secret': 'payment-gateways',
  'payment_gateway.verify_key': 'payment-gateways',
  'backup.archive_password': 'recovery',
  'support_ai_provider.api_key': 'support-ai',
  'admin.totp_secret': 'account',
  'hosting.totp_secret': 'hosting',
  // `reseller_web.totp_secret` is deliberately absent: see the docblock above.
};

const PANEL_COLUMNS: Readonly<Record<string, readonly [string, string]>> = {
  'panel.username': ['username_ciphertext', 'username_key_id'],
  'panel.password': ['password_ciphertext', 'password_key_id'],
  'panel.api_token': ['api_token_ciphertext', 'api_token_key_id'],
};

const GATEWAY_COLUMNS: Readonly<Record<string, readonly [string, string]>> = {
  'payment_gateway.api_key': ['api_key_ciphertext', 'api_key_key_id'],
  'payment_gateway.webhook_secret': ['webhook_secret_ciphertext', 'webhook_secret_key_id'],
  'payment_gateway.verify_key': ['verify_key_ciphertext', 'verify_key_key_id'],
};

interface Stored {
  readonly id: string;
  readonly ciphertext: string | null;
  readonly key_id: string | null;
  readonly label: string | null;
}

interface ItemRow extends Record<string, unknown> {
  readonly purpose: SecretPurpose;
  readonly entity_table: string;
  readonly entity_id: string;
  readonly entity_key: string | null;
  readonly recovery_request_id: string;
  readonly cleared_at: Date | string;
}

@ScopeBound()
export class DrizzleSecretReentryReader implements SecretReentryReader {
  constructor(
    private readonly db: Database,
    /** The bare cipher: a check that a value reads is not a credential use to report. */
    private readonly cipher: SecretCipher,
  ) {}

  async outstanding(scope: ScopeContext): Promise<SecretReentryItem[]> {
    const tenantId = requireTenantId(scope);
    const result = await this.db.execute<ItemRow>(sql`
      SELECT DISTINCT ON (purpose, entity_table, entity_id, coalesce(entity_key, ''))
             purpose, entity_table, entity_id::text AS entity_id, entity_key,
             recovery_request_id::text AS recovery_request_id, cleared_at
        FROM secret_reentry_items
       WHERE tenant_id = ${tenantId}
       ORDER BY purpose, entity_table, entity_id, coalesce(entity_key, ''), cleared_at DESC`);
    const items: SecretReentryItem[] = [];
    for (const row of result.rows) {
      const place = PLACES[row.purpose];
      if (place === undefined) continue;
      const state = await this.current(tenantId, row);
      if (state.readable) continue;
      items.push({
        purpose: row.purpose,
        kind: unreadableSecretKindOf(row.purpose),
        entityId: row.entity_id,
        label: state.label,
        provider: place === 'payment-gateways' ? row.entity_key : null,
        reenterAt: place,
        clearedAt: new Date(row.cleared_at).toISOString(),
        recoveryId: row.recovery_request_id,
      });
    }
    items.sort((a, b) => (a.clearedAt < b.clearedAt ? 1 : a.clearedAt > b.clearedAt ? -1 : 0));
    return items;
  }

  /** The entity's value as it is now, and whether it reads. */
  private async current(
    tenantId: string,
    item: ItemRow,
  ): Promise<{ readable: boolean; label: string | null }> {
    const { purpose } = item;
    let stored: Stored | undefined;
    if (purpose === 'bot_instance.token') {
      stored = await this.one(sql`
        SELECT id::text AS id, token_ciphertext AS ciphertext, token_key_id AS key_id,
               username AS label
          FROM bot_instances WHERE tenant_id = ${tenantId} AND id::text = ${item.entity_id}`);
      // A bot deleted since needs nothing re-entered.
      if (stored === undefined) return { readable: true, label: null };
    } else if (PANEL_COLUMNS[purpose] !== undefined) {
      const [ciphertext, keyId] = PANEL_COLUMNS[purpose];
      stored = await this.one(sql`
        SELECT p.id::text AS id, c.${sql.identifier(ciphertext)} AS ciphertext,
               c.${sql.identifier(keyId)} AS key_id, p.name AS label
          FROM panels p
          LEFT JOIN panel_credentials c ON c.panel_id = p.id AND c.tenant_id = p.tenant_id
         WHERE p.tenant_id = ${tenantId} AND p.id::text = ${item.entity_id}`);
      if (stored === undefined) return { readable: true, label: null };
    } else if (GATEWAY_COLUMNS[purpose] !== undefined) {
      const [ciphertext, keyId] = GATEWAY_COLUMNS[purpose];
      // By provider: clearing an API key deletes the row, and re-entry makes a new one.
      stored = await this.one(sql`
        SELECT id::text AS id, ${sql.identifier(ciphertext)} AS ciphertext,
               ${sql.identifier(keyId)} AS key_id, provider AS label
          FROM payment_gateway_credentials
         WHERE tenant_id = ${tenantId} AND provider = ${item.entity_key ?? ''}`);
      if (stored === undefined) return { readable: false, label: item.entity_key };
    } else if (purpose === 'support_ai_provider.api_key') {
      stored = await this.one(sql`
        SELECT id::text AS id, api_key_ciphertext AS ciphertext, api_key_key_id AS key_id,
               provider AS label
          FROM support_ai_provider_credentials
         WHERE tenant_id = ${tenantId} AND provider = ${item.entity_key ?? ''}`);
      if (stored === undefined) return { readable: false, label: item.entity_key };
    } else if (purpose === 'backup.archive_password') {
      stored = await this.one(sql`
        SELECT id::text AS id, password_ciphertext AS ciphertext, password_key_id AS key_id,
               NULL::text AS label
          FROM backup_archive_passwords
         WHERE tenant_id = ${tenantId} AND superseded_at IS NULL`);
      if (stored === undefined) return { readable: false, label: null };
    } else if (purpose === 'admin.totp_secret' || purpose === 'hosting.totp_secret') {
      const table = purpose === 'admin.totp_secret' ? 'admin_totp_factors' : 'hosting_totp_factors';
      const admin = await this.one(sql`
        SELECT id::text AS id, NULL::text AS ciphertext, NULL::text AS key_id, username AS label
          FROM admins WHERE tenant_id = ${tenantId} AND id::text = ${item.entity_id}`);
      if (admin === undefined) return { readable: true, label: null };
      stored = await this.one(sql`
        SELECT id::text AS id, totp_secret_ciphertext AS ciphertext,
               totp_secret_key_id AS key_id, ${admin.label}::text AS label
          FROM ${sql.identifier(table)}
         WHERE tenant_id = ${tenantId} AND admin_id::text = ${item.entity_id}
           AND state = 'ACTIVE'`);
      if (stored === undefined) return { readable: false, label: admin.label };
    } else {
      return { readable: true, label: null };
    }
    return { readable: this.reads(purpose, tenantId, stored), label: stored.label };
  }

  private reads(purpose: SecretPurpose, tenantId: string, stored: Stored): boolean {
    if (stored.ciphertext === null || stored.key_id === null) return false;
    try {
      this.cipher.decrypt(
        { keyId: stored.key_id, ciphertext: stored.ciphertext },
        { purpose, tenantId, entityId: stored.id },
      );
      return true;
    } catch {
      // Not readable is the answer, not an error: the item stays on the strip.
      return false;
    }
  }

  private async one(query: ReturnType<typeof sql>): Promise<Stored | undefined> {
    const result = await this.db.execute<Stored & Record<string, unknown>>(query);
    return result.rows[0];
  }
}
