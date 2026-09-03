import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type {
  PanelHealthState,
  PanelStatus,
  ProviderFailureKind,
  ProviderType,
  TenantContext,
} from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import {
  panelCredentials,
  panelHealth,
  panels,
} from '../../../../infrastructure/persistence/schema.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  CreatePanelInput,
  PanelHealthRecord,
  PanelRecord,
  PanelRepository,
  PanelView,
  UpdatePanelInput,
} from '../application/ports.js';

/**
 * Panels, in PostgreSQL.
 *
 * Every query in this file has `eq(panels.tenantId, scope.tenantId)` in its
 * WHERE clause, including the ones that also have a primary key. That looks
 * redundant and is not: a primary-key lookup that omits the tenant returns
 * another tenant's row, and the caller then decides what to do with something
 * it should never have seen. Filtering in the query means the row never leaves
 * the database, so there is no later check to forget.
 *
 * The same applies to the writes. `update … where id = ? and tenant_id = ?`
 * affects zero rows for another tenant's panel, which the caller reads as "no
 * such panel" — the same answer it gets for an id that never existed. Nothing
 * distinguishes the two, which is deliberate: a distinguishable "forbidden"
 * turns any panel id into an oracle for whether it exists somewhere on the
 * installation.
 */
export class DrizzlePanelRepository implements PanelRepository {
  constructor(private readonly db: Database) {}

  async list(scope: TenantContext, options: { includeArchived: boolean }): Promise<PanelView[]> {
    const rows = await this.db
      .select({
        panel: panels,
        credentials: {
          usernameSetAt: panelCredentials.usernameSetAt,
          passwordSetAt: panelCredentials.passwordSetAt,
          apiTokenSetAt: panelCredentials.apiTokenSetAt,
        },
        health: panelHealth,
      })
      .from(panels)
      // The credential row is joined for its TIMESTAMPS only. The ciphertext
      // columns are not in the projection, so a list response cannot carry one
      // even if a future author adds a field to the view type.
      .leftJoin(panelCredentials, eq(panelCredentials.panelId, panels.id))
      .leftJoin(panelHealth, eq(panelHealth.panelId, panels.id))
      .where(
        options.includeArchived
          ? eq(panels.tenantId, scope.tenantId)
          : and(eq(panels.tenantId, scope.tenantId), ne(panels.status, 'ARCHIVED')),
      )
      .orderBy(asc(panels.name));
    return rows.map((row) => toView(row));
  }

  async find(scope: TenantContext, panelId: string): Promise<PanelView | null> {
    const [row] = await this.db
      .select({
        panel: panels,
        credentials: {
          usernameSetAt: panelCredentials.usernameSetAt,
          passwordSetAt: panelCredentials.passwordSetAt,
          apiTokenSetAt: panelCredentials.apiTokenSetAt,
        },
        health: panelHealth,
      })
      .from(panels)
      .leftJoin(panelCredentials, eq(panelCredentials.panelId, panels.id))
      .leftJoin(panelHealth, eq(panelHealth.panelId, panels.id))
      .where(and(eq(panels.id, panelId), eq(panels.tenantId, scope.tenantId)))
      .limit(1);
    return row === undefined ? null : toView(row);
  }

  async create(
    scope: TenantContext,
    input: CreatePanelInput,
    tx: TransactionScope,
  ): Promise<PanelRecord> {
    const [row] = await tx.tx
      .insert(panels)
      .values({
        id: input.id,
        tenantId: scope.tenantId,
        name: input.name,
        providerType: input.providerType,
        baseUrl: input.baseUrl,
        status: 'ACTIVE',
      })
      .returning();
    if (row === undefined) throw new Error('panel insert returned no row');
    return toRecord(row);
  }

  async update(
    scope: TenantContext,
    panelId: string,
    input: UpdatePanelInput,
    tx: TransactionScope,
  ): Promise<PanelRecord | null> {
    const changes: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name !== undefined) changes['name'] = input.name;
    if (input.baseUrl !== undefined) changes['baseUrl'] = input.baseUrl;

    const [row] = await tx.tx
      .update(panels)
      .set(changes)
      .where(and(eq(panels.id, panelId), eq(panels.tenantId, scope.tenantId)))
      .returning();
    return row === undefined ? null : toRecord(row);
  }

  async setStatus(
    scope: TenantContext,
    panelId: string,
    status: PanelStatus,
    at: Date,
    tx: TransactionScope,
  ): Promise<PanelRecord | null> {
    const [row] = await tx.tx
      .update(panels)
      .set({
        status,
        // The CHECK constraint requires these to agree, so they are set
        // together rather than left to a caller to remember.
        archivedAt: status === 'ARCHIVED' ? at : null,
        updatedAt: at,
      })
      .where(and(eq(panels.id, panelId), eq(panels.tenantId, scope.tenantId)))
      .returning();
    return row === undefined ? null : toRecord(row);
  }

  async nameTaken(
    scope: TenantContext,
    name: string,
    exceptPanelId: string | null,
  ): Promise<boolean> {
    const [row] = await this.db
      .select({ id: panels.id })
      .from(panels)
      .where(
        and(
          eq(panels.tenantId, scope.tenantId),
          eq(panels.name, name),
          ne(panels.status, 'ARCHIVED'),
          exceptPanelId === null ? undefined : ne(panels.id, exceptPanelId),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  async recordHealth(
    scope: TenantContext,
    panelId: string,
    health: PanelHealthRecord,
    tx: TransactionScope,
  ): Promise<void> {
    await tx.tx
      .insert(panelHealth)
      .values({
        panelId,
        tenantId: scope.tenantId,
        state: health.state,
        checkedAt: health.checkedAt,
        latencyMs: health.latencyMs,
        failure: health.failure,
        statusCode: health.statusCode,
        providerVersion: health.providerVersion,
        lastHealthyAt: health.lastHealthyAt,
      })
      .onConflictDoUpdate({
        target: panelHealth.panelId,
        set: {
          state: health.state,
          checkedAt: health.checkedAt,
          latencyMs: health.latencyMs,
          failure: health.failure,
          statusCode: health.statusCode,
          providerVersion: health.providerVersion,
          lastHealthyAt: health.lastHealthyAt,
        },
        // Belt and braces on a conflict path: the row being updated must belong
        // to this tenant. Unreachable through the service, which resolves the
        // panel first — and unreachable is where a guard belongs, because the
        // reachable ones get exercised and noticed.
        setWhere: sql`${panelHealth.tenantId} = ${scope.tenantId}`,
      });
  }
}

interface Row {
  panel: typeof panels.$inferSelect;
  credentials: {
    usernameSetAt: Date | null;
    passwordSetAt: Date | null;
    apiTokenSetAt: Date | null;
  } | null;
  health: typeof panelHealth.$inferSelect | null;
}

function toRecord(row: typeof panels.$inferSelect): PanelRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    // Narrowed from the database's `text`. The CHECK constraint is what makes
    // this safe, and `providerAdapter` refuses anything that got past it — so
    // a bad value fails at the adapter with a precise message rather than
    // here with a cast error.
    providerType: row.providerType as ProviderType,
    baseUrl: row.baseUrl,
    status: row.status as PanelStatus,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toView(row: Row): PanelView {
  return {
    panel: toRecord(row.panel),
    credentials: {
      usernameSetAt: row.credentials?.usernameSetAt ?? null,
      passwordSetAt: row.credentials?.passwordSetAt ?? null,
      apiTokenSetAt: row.credentials?.apiTokenSetAt ?? null,
    },
    health:
      row.health === null
        ? null
        : {
            state: row.health.state as PanelHealthState,
            checkedAt: row.health.checkedAt,
            latencyMs: row.health.latencyMs,
            failure: row.health.failure as ProviderFailureKind | null,
            statusCode: row.health.statusCode,
            providerVersion: row.health.providerVersion,
            lastHealthyAt: row.health.lastHealthyAt,
          },
  };
}
