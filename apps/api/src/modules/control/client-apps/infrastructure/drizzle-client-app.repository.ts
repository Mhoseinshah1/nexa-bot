import { and, asc, count, eq, sql } from 'drizzle-orm';
import {
  CLIENT_APP_PLATFORMS,
  type ClientAppDeliveryKind,
  type ClientAppInput,
  type ClientAppPlatform,
  type ClientAppProtocol,
  type ClientAppStatus,
  type ProviderType,
  type ScopeContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { clientApps } from '../../../../infrastructure/persistence/schema.js';
import type { ClientAppRecord, ClientAppRepository } from '../application/ports.js';

/** The columns the record is built from. Selected explicitly, in one place. */
const COLUMNS = {
  id: clientApps.id,
  platform: clientApps.platform,
  name: clientApps.name,
  icon: clientApps.icon,
  description: clientApps.description,
  officialUrl: clientApps.officialUrl,
  alternativeUrl: clientApps.alternativeUrl,
  helpUrl: clientApps.helpUrl,
  guide: clientApps.guide,
  deliveryKinds: clientApps.deliveryKinds,
  protocols: clientApps.protocols,
  providerTypes: clientApps.providerTypes,
  status: clientApps.status,
  sortOrder: clientApps.sortOrder,
  version: clientApps.version,
  createdAt: clientApps.createdAt,
  updatedAt: clientApps.updatedAt,
} as const;

interface Row {
  readonly id: string;
  readonly platform: string;
  readonly name: string;
  readonly icon: string | null;
  readonly description: string;
  readonly officialUrl: string;
  readonly alternativeUrl: string | null;
  readonly helpUrl: string | null;
  readonly guide: string;
  readonly deliveryKinds: string[];
  readonly protocols: string[];
  readonly providerTypes: string[];
  readonly status: string;
  readonly sortOrder: number;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function toRecord(row: Row): ClientAppRecord {
  // Casts rather than re-validation: every enum-valued column is pinned by a CHECK built
  // from the contract, and the database is the boundary that guarantees it.
  return {
    id: row.id,
    platform: row.platform as ClientAppPlatform,
    name: row.name,
    icon: row.icon,
    description: row.description,
    officialUrl: row.officialUrl,
    alternativeUrl: row.alternativeUrl,
    helpUrl: row.helpUrl,
    guide: row.guide,
    deliveryKinds: row.deliveryKinds as ClientAppDeliveryKind[],
    protocols: row.protocols as ClientAppProtocol[],
    providerTypes: row.providerTypes as ProviderType[],
    status: row.status as ClientAppStatus,
    sortOrder: row.sortOrder,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mutable(input: ClientAppInput) {
  return {
    platform: input.platform,
    name: input.name,
    icon: input.icon,
    description: input.description,
    officialUrl: input.officialUrl,
    alternativeUrl: input.alternativeUrl,
    helpUrl: input.helpUrl,
    guide: input.guide,
    deliveryKinds: [...input.deliveryKinds],
    protocols: [...input.protocols],
    providerTypes: [...input.providerTypes],
    sortOrder: input.sortOrder,
  };
}

const PLATFORM_RANK = new Map<string, number>(
  CLIENT_APP_PLATFORMS.map((platform, index) => [platform, index]),
);

/**
 * The client app rows, in PostgreSQL.
 *
 * Every query carries `eq(clientApps.tenantId, …)`. The service answers another tenant's
 * id as "no such entry" only because this predicate makes it so.
 */
export class DrizzleClientAppRepository implements ClientAppRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async list(
    scope: ScopeContext,
    options: { readonly platform?: ClientAppPlatform; readonly status?: ClientAppStatus } = {},
    tx?: unknown,
  ): Promise<readonly ClientAppRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select(COLUMNS)
      .from(clientApps)
      .where(
        and(
          eq(clientApps.tenantId, tenantId),
          options.platform === undefined ? undefined : eq(clientApps.platform, options.platform),
          options.status === undefined ? undefined : eq(clientApps.status, options.status),
        ),
      )
      .orderBy(asc(clientApps.sortOrder), asc(clientApps.createdAt), asc(clientApps.id));
    // Platforms in the contract's order rather than alphabetically; a stable sort keeps
    // the operator's order inside each.
    return rows
      .map(toRecord)
      .sort((a, b) => (PLATFORM_RANK.get(a.platform) ?? 0) - (PLATFORM_RANK.get(b.platform) ?? 0));
  }

  async find(scope: ScopeContext, id: string, tx?: unknown): Promise<ClientAppRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select(COLUMNS)
      .from(clientApps)
      .where(and(eq(clientApps.tenantId, tenantId), eq(clientApps.id, id)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async insert(
    scope: ScopeContext,
    input: ClientAppInput & {
      readonly id: string;
      readonly status: ClientAppStatus;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<ClientAppRecord> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(clientApps)
      .values({
        ...mutable(input),
        id: input.id,
        tenantId,
        status: input.status,
        version: 1,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning(COLUMNS);
    const row = rows[0];
    if (row === undefined) throw new Error('INSERT … RETURNING produced no row.');
    return toRecord(row);
  }

  /** The version is in the WHERE, never checked and then written — `SupportFaqRepository`'s rule. */
  async update(
    scope: ScopeContext,
    id: string,
    input: ClientAppInput & { readonly expectedVersion: number },
    now: Date,
    tx: unknown,
  ): Promise<ClientAppRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(clientApps)
      .set({ ...mutable(input), version: sql`${clientApps.version} + 1`, updatedAt: now })
      .where(
        and(
          eq(clientApps.tenantId, tenantId),
          eq(clientApps.id, id),
          eq(clientApps.version, input.expectedVersion),
        ),
      )
      .returning(COLUMNS);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async setStatus(
    scope: ScopeContext,
    id: string,
    input: {
      readonly from: ClientAppStatus;
      readonly to: ClientAppStatus;
      readonly expectedVersion: number;
    },
    now: Date,
    tx: unknown,
  ): Promise<ClientAppRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(clientApps)
      .set({ status: input.to, version: sql`${clientApps.version} + 1`, updatedAt: now })
      .where(
        and(
          eq(clientApps.tenantId, tenantId),
          eq(clientApps.id, id),
          eq(clientApps.status, input.from),
          eq(clientApps.version, input.expectedVersion),
        ),
      )
      .returning(COLUMNS);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async remove(
    scope: ScopeContext,
    id: string,
    expectedVersion: number,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .delete(clientApps)
      .where(
        and(
          eq(clientApps.tenantId, tenantId),
          eq(clientApps.id, id),
          eq(clientApps.version, expectedVersion),
        ),
      )
      .returning({ id: clientApps.id });
    return rows.length > 0;
  }

  async count(scope: ScopeContext, tx?: unknown): Promise<number> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ total: count() })
      .from(clientApps)
      .where(eq(clientApps.tenantId, tenantId));
    return Number(rows[0]?.total ?? 0);
  }
}
