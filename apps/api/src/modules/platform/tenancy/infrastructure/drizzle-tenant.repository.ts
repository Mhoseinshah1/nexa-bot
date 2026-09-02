import { and, eq } from 'drizzle-orm';
import {
  isSystemContext,
  asId,
  errors,
  PLATFORM_ERROR_CODES,
  type BotInstance,
  type BotInstanceId,
  type Calendar,
  type CurrencyCode,
  type ScopeContext,
  type SecretCipher,
  type Tenant,
  type TenantId,
  type TenantKind,
  type TenantStatus,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import { botInstances, tenants } from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type { BotInstanceRepository, TenantRepository } from '../application/ports.js';

type TenantRow = typeof tenants.$inferSelect;
type BotInstanceRow = typeof botInstances.$inferSelect;

function toTenant(row: TenantRow): Tenant {
  return {
    id: asId<'TenantId'>(row.id),
    kind: row.kind as TenantKind,
    parentTenantId: row.parentTenantId === null ? null : asId<'TenantId'>(row.parentTenantId),
    slug: row.slug,
    displayName: row.displayName,
    status: row.status as TenantStatus,
    locale: row.locale,
    displayTimezone: row.displayTimezone,
    calendar: row.calendar as Calendar,
    currency: row.currency as CurrencyCode,
  };
}

function toBotInstance(row: BotInstanceRow): BotInstance {
  return {
    id: asId<'BotInstanceId'>(row.id),
    tenantId: asId<'TenantId'>(row.tenantId),
    username: row.username,
    status: row.status as BotInstance['status'],
    // A reference, never the token. Surfaces receive this and can do nothing with it.
    tokenSecretRef: `secret:${row.tokenKeyId}`,
  };
}

function executorOf(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

export class DrizzleTenantRepository implements TenantRepository {
  constructor(private readonly db: Database) {}

  /**
   * Holds this scope's tenant and bot rows still, and says whether both are
   * ACTIVE.
   *
   * A surface checks these when the request arrives, which is a snapshot: a
   * stop can commit in between, return to the operator, and the write still
   * lands — audit, idempotency and outbox rows created for an installation
   * somebody had already switched off. `FOR SHARE` holds the answer for the
   * rest of the transaction, and lets concurrent writers read it at once; only
   * a status change waits.
   *
   * A system scope has no tenant to be inactive, so it passes.
   */
  async scopeIsActive(scope: ScopeContext, tx?: unknown): Promise<boolean> {
    if (isSystemContext(scope)) return true;
    const executor = executorOf(this.db, tx);

    const [tenant] = await executor
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, scope.tenantId))
      .for('share');
    if (tenant?.status !== 'ACTIVE') return false;

    if (scope.botInstanceId === null) return true;

    const [bot] = await executor
      .select({ status: botInstances.status })
      .from(botInstances)
      .where(eq(botInstances.id, scope.botInstanceId))
      .for('share');
    return bot?.status === 'ACTIVE';
  }

  async findById(id: TenantId): Promise<Tenant | null> {
    const [row] = await this.db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    return row ? toTenant(row) : null;
  }

  async findBySlug(slug: string): Promise<Tenant | null> {
    const [row] = await this.db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
    return row ? toTenant(row) : null;
  }

  async findPrimary(): Promise<Tenant | null> {
    // Ordered by creation so a deployment that somehow acquired two primary
    // tenants resolves the same one on every boot rather than whichever the
    // planner returned first.
    const [row] = await this.db
      .select()
      .from(tenants)
      .where(eq(tenants.kind, 'PRIMARY'))
      .orderBy(tenants.createdAt, tenants.id)
      .limit(1);
    return row ? toTenant(row) : null;
  }

  async findInScope(scope: ScopeContext): Promise<Tenant | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    return row ? toTenant(row) : null;
  }
}

export class DrizzleBotInstanceRepository implements BotInstanceRepository {
  constructor(
    private readonly db: Database,
    private readonly cipher: SecretCipher,
  ) {}

  /**
   * Unscoped by necessity, and safe for the same reason `TenantRepository`'s is:
   * it resolves WHICH tenant an inbound update belongs to. It returns no secret
   * — `tokenSecretRef` is a reference — and everything downstream runs under the
   * tenant it yields.
   */
  async findById(id: BotInstanceId): Promise<BotInstance | null> {
    const [row] = await this.db.select().from(botInstances).where(eq(botInstances.id, id)).limit(1);
    return row ? toBotInstance(row) : null;
  }

  async listForTenant(scope: ScopeContext): Promise<BotInstance[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select()
      .from(botInstances)
      .where(eq(botInstances.tenantId, tenantId));
    return rows.map(toBotInstance);
  }

  async findByUsername(scope: ScopeContext, username: string): Promise<BotInstance | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.db
      .select()
      .from(botInstances)
      .where(and(eq(botInstances.tenantId, tenantId), eq(botInstances.username, username)))
      .limit(1);
    return row ? toBotInstance(row) : null;
  }

  async resolveToken(scope: ScopeContext, id: BotInstanceId): Promise<string> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.db
      .select()
      .from(botInstances)
      .where(and(eq(botInstances.tenantId, tenantId), eq(botInstances.id, id)))
      .limit(1);

    if (!row) {
      throw errors.notFound(
        PLATFORM_ERROR_CODES.TENANT_NOT_FOUND,
        'No bot instance with that id in this tenant.',
      );
    }
    return this.cipher.decrypt({ keyId: row.tokenKeyId, ciphertext: row.tokenCiphertext });
  }

  /**
   * The token of the tenant's active bot, for sending on the tenant's behalf.
   *
   * Returns null rather than throwing when the tenant has no active bot: that is
   * a configuration state an operator can be told about, not an exception. A
   * suspended bot is not used — stopping a bot should stop it sending.
   *
   * Ordered by creation so a tenant with several bots resolves the same one on
   * every call instead of whichever the planner happened to return.
   */
  async activeTokenForTenant(scope: ScopeContext): Promise<string | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.db
      .select()
      .from(botInstances)
      .where(and(eq(botInstances.tenantId, tenantId), eq(botInstances.status, 'ACTIVE')))
      .orderBy(botInstances.createdAt, botInstances.id)
      .limit(1);
    if (!row) return null;
    return this.cipher.decrypt({ keyId: row.tokenKeyId, ciphertext: row.tokenCiphertext });
  }
}
