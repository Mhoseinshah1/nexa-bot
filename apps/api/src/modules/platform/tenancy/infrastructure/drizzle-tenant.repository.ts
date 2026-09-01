import { and, eq } from 'drizzle-orm';
import {
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
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { botInstances, tenants } from '../../../../infrastructure/persistence/schema.js';
import { requireTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';
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

export class DrizzleTenantRepository implements TenantRepository {
  constructor(private readonly db: Database) {}

  async findById(id: TenantId): Promise<Tenant | null> {
    const [row] = await this.db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    return row ? toTenant(row) : null;
  }

  async findBySlug(slug: string): Promise<Tenant | null> {
    const [row] = await this.db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
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
}
