import { and, asc, eq, sql } from 'drizzle-orm';
import {
  asId,
  type BotInstanceId,
  type BotInstanceStatus,
  type BotOperatorStatus,
  type ScopeContext,
  type SecretCipher,
  type TenantKind,
  type TenantStatus,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import { botInstances, tenants } from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  BotManagementRecord,
  BotManagementRepository,
} from '../application/bot-management-ports.js';
import type { DrizzleBotInstanceRepository } from './drizzle-tenant.repository.js';

function executorOf(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

/**
 * The bot-management projection (WP13), and the two writes it makes.
 *
 * Every SELECT here names its columns. `token_ciphertext`, `token_key_id` and the stored
 * `webhook_secret_fingerprint` are never among them: the fingerprint is COMPARED in SQL
 * against the digest the caller hands in, and only the boolean comes back. So no view
 * built from this repository can carry a credential or a value derived from one — the
 * panel-credential rule (ADR-0023), applied to the other credential this installation
 * holds.
 *
 * Decryption is delegated to `DrizzleBotInstanceRepository`, which already owns the
 * cipher context (`purpose`, tenant, row). A second copy of that context would be a
 * second place where it could disagree with the one that encrypted.
 */
export class DrizzleBotManagementRepository implements BotManagementRepository {
  constructor(
    private readonly db: Database,
    private readonly cipher: SecretCipher,
    private readonly bots: Pick<
      DrizzleBotInstanceRepository,
      'resolveToken' | 'tokenForBotInstance'
    >,
  ) {}

  async listManaged(
    scope: ScopeContext,
    currentFingerprint: string | null,
  ): Promise<BotManagementRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select(this.columns(currentFingerprint))
      .from(botInstances)
      .innerJoin(tenants, eq(tenants.id, botInstances.tenantId))
      .where(eq(botInstances.tenantId, tenantId))
      .orderBy(asc(botInstances.createdAt), asc(botInstances.id));
    return rows.map(toRecord);
  }

  async findManaged(
    scope: ScopeContext,
    id: BotInstanceId,
    currentFingerprint: string | null,
    tx?: unknown,
  ): Promise<BotManagementRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .select(this.columns(currentFingerprint))
      .from(botInstances)
      .innerJoin(tenants, eq(tenants.id, botInstances.tenantId))
      .where(and(eq(botInstances.tenantId, tenantId), eq(botInstances.id, id)))
      .limit(1);
    return row === undefined ? null : toRecord(row);
  }

  async lockManaged(
    scope: ScopeContext,
    id: BotInstanceId,
    tx: unknown,
  ): Promise<{ readonly status: BotInstanceStatus; readonly telegramBotId: string | null } | null> {
    const tenantId = requireTenantId(scope);
    // The BOT row, and only it: `scopeIsActive` has already taken the tenant row FOR SHARE
    // in this transaction, and a stop and a token replacement of one bot are what must
    // serialise with each other.
    const [row] = await executorOf(this.db, tx)
      .select({ status: botInstances.status, telegramBotId: botInstances.telegramBotId })
      .from(botInstances)
      .where(and(eq(botInstances.tenantId, tenantId), eq(botInstances.id, id)))
      .for('update');
    return row === undefined
      ? null
      : { status: row.status as BotInstanceStatus, telegramBotId: row.telegramBotId };
  }

  async transitionStatus(
    scope: ScopeContext,
    id: BotInstanceId,
    change: {
      readonly from: BotInstanceStatus;
      readonly to: BotOperatorStatus;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const updated = await executorOf(this.db, tx)
      .update(botInstances)
      .set({ status: change.to, updatedAt: change.now })
      .where(
        and(
          eq(botInstances.tenantId, tenantId),
          eq(botInstances.id, id),
          eq(botInstances.status, change.from),
        ),
      )
      .returning({ id: botInstances.id });
    return updated.length === 1;
  }

  async replaceToken(
    scope: ScopeContext,
    id: BotInstanceId,
    input: { readonly token: string; readonly telegramBotId: string; readonly now: Date },
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    // Encrypted HERE, bound to this row and tenant — the same context the bootstrap's
    // `createFromBootstrap` binds, so every reader decrypts it exactly as before.
    const secret = this.cipher.encrypt(input.token, {
      purpose: 'bot_instance.token',
      tenantId,
      entityId: id,
    });
    const updated = await executorOf(this.db, tx)
      .update(botInstances)
      .set({
        tokenCiphertext: secret.ciphertext,
        tokenKeyId: secret.keyId,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(botInstances.tenantId, tenantId),
          eq(botInstances.id, id),
          // The identity getMe proved. A row that names another bot is not replaced —
          // a replacement never repoints (ADR-0029).
          eq(botInstances.telegramBotId, input.telegramBotId),
        ),
      )
      .returning({ id: botInstances.id });
    return updated.length === 1;
  }

  resolveToken(scope: ScopeContext, id: BotInstanceId): Promise<string> {
    return this.bots.resolveToken(scope, id);
  }

  tokenForBotInstance(scope: ScopeContext, id: BotInstanceId): Promise<string | null> {
    return this.bots.tokenForBotInstance(scope, id);
  }

  private columns(currentFingerprint: string | null) {
    return {
      id: botInstances.id,
      username: botInstances.username,
      telegramBotId: botInstances.telegramBotId,
      status: botInstances.status,
      webhookRegisteredAt: botInstances.webhookRegisteredAt,
      webhookUrl: botInstances.webhookUrl,
      // The comparison, never the digest. NULL stays NULL (unknown); with no current
      // secret configured the answer is irrelevant and the service reports NOT_CONFIGURED.
      webhookSecretMatches: sql<boolean | null>`CASE
          WHEN ${botInstances.webhookSecretFingerprint} IS NULL THEN NULL
          ELSE ${botInstances.webhookSecretFingerprint} = ${currentFingerprint ?? ''}
        END`,
      commandsRevision: botInstances.commandsRevision,
      createdAt: botInstances.createdAt,
      updatedAt: botInstances.updatedAt,
      tenantId: tenants.id,
      tenantSlug: tenants.slug,
      tenantDisplayName: tenants.displayName,
      tenantKind: tenants.kind,
      tenantStatus: tenants.status,
    };
  }
}

interface ManagedRow {
  readonly id: string;
  readonly username: string;
  readonly telegramBotId: string | null;
  readonly status: string;
  readonly webhookRegisteredAt: Date | null;
  readonly webhookUrl: string | null;
  readonly webhookSecretMatches: boolean | null;
  readonly commandsRevision: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly tenantDisplayName: string;
  readonly tenantKind: string;
  readonly tenantStatus: string;
}

function toRecord(row: ManagedRow): BotManagementRecord {
  return {
    id: asId<'BotInstanceId'>(row.id),
    username: row.username,
    telegramBotId: row.telegramBotId,
    status: row.status as BotInstanceStatus,
    webhookRegisteredAt: row.webhookRegisteredAt,
    webhookUrl: row.webhookUrl,
    webhookSecretMatches: row.webhookSecretMatches,
    commandsRevision: row.commandsRevision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    tenant: {
      id: row.tenantId,
      slug: row.tenantSlug,
      displayName: row.tenantDisplayName,
      kind: row.tenantKind as TenantKind,
      status: row.tenantStatus as TenantStatus,
    },
  };
}
