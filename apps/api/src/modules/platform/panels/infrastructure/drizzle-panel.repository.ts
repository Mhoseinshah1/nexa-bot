import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { errors, PANEL_ERROR_CODES } from '@nexa/contracts';
import type {
  PanelHealthState,
  PanelStatus,
  ProviderFailureKind,
  ProviderType,
  TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  panelCredentials,
  panelHealth,
  panels,
} from '../../../../infrastructure/persistence/schema.js';
import { isUniqueViolation } from '../../../../infrastructure/persistence/sqlstate.js';
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
/**
 * The transaction's connection when there is one, the pool otherwise.
 *
 * A read issued on the pool from inside a transaction takes a SECOND
 * connection while already holding one. At `DATABASE_POOL_MAX` concurrent
 * mutations every connection is held by a transaction waiting for a connection
 * that will never come, and the process deadlocks until the idle-transaction
 * timeout unwinds it. `authorized-mutation.ts` names that hazard exactly; these
 * reads used to walk into it.
 */
function executorOf(db: Database, tx?: TransactionScope): Executor {
  return tx?.tx ?? db;
}

export class DrizzlePanelRepository implements PanelRepository {
  constructor(private readonly db: Database) {}

  async list(
    scope: TenantContext,
    options: { includeArchived: boolean },
    tx?: TransactionScope,
  ): Promise<PanelView[]> {
    const rows = await executorOf(this.db, tx)
      .select({
        panel: panels,
        // FLAT, not a nested group. See `toView` for why.
        usernameSetAt: panelCredentials.usernameSetAt,
        passwordSetAt: panelCredentials.passwordSetAt,
        apiTokenSetAt: panelCredentials.apiTokenSetAt,
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

  async find(
    scope: TenantContext,
    panelId: string,
    tx?: TransactionScope,
  ): Promise<PanelView | null> {
    const [row] = await executorOf(this.db, tx)
      .select({
        panel: panels,
        // FLAT, not a nested group. See `toView` for why.
        usernameSetAt: panelCredentials.usernameSetAt,
        passwordSetAt: panelCredentials.passwordSetAt,
        apiTokenSetAt: panelCredentials.apiTokenSetAt,
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
    let row: typeof panels.$inferSelect | undefined;
    try {
      [row] = await tx.tx
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
    } catch (error) {
      // Restoring an archived panel makes it live again, and the name it had
      // may since have been taken by another panel — archiving RELEASES a name
      // on purpose, so this is an ordinary thing for an operator to hit. The
      // partial unique index catches it either way; without this it escaped as
      // an unhandled 500 rather than the conflict the API documents.
      //
      // Named constraint, not bare 23505: `panels` can grow another unique
      // index, and mapping an unrelated violation to "name taken" would be a
      // confident wrong answer instead of an honest error.
      if (isUniqueViolation(error, 'panels_tenant_name_live_key')) {
        throw errors.conflict(
          PANEL_ERROR_CODES.PANEL_NAME_TAKEN,
          'Another panel of this tenant already uses that name. Rename it before restoring this one.',
        );
      }
      throw error;
    }
    return row === undefined ? null : toRecord(row);
  }

  async nameTaken(
    scope: TenantContext,
    name: string,
    exceptPanelId: string | null,
    tx?: TransactionScope,
  ): Promise<boolean> {
    const [row] = await executorOf(this.db, tx)
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
  usernameSetAt: Date | null;
  passwordSetAt: Date | null;
  apiTokenSetAt: Date | null;
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

/**
 * A joined row as a view.
 *
 * The three credential timestamps are selected FLAT rather than as a nested
 * group, and that is load-bearing rather than stylistic.
 *
 * Drizzle collapses a nested selection to `null` when the FIRST column in the
 * group is null — not when they are all null, which is what the shape suggests
 * and what this file originally assumed. Grouped as
 * `{ usernameSetAt, passwordSetAt, apiTokenSetAt }`, a panel with a password
 * and no username came back with the whole group null, so the API reported
 * every credential as NOT CONFIGURED while the row plainly held one. An
 * operator would have re-entered a password that was already right; a
 * token-only provider — which never has a username — would have reported
 * itself unconfigured forever, and Sanaei is exactly that shape.
 *
 * Selecting flat removes the inference entirely: three nullable columns, each
 * meaning what it says, with no library rule between the row and the answer.
 * Reordering the group to put a non-null column first would also have worked
 * and was rejected: it would leave the next author one innocuous reordering
 * away from the same bug, with nothing in the file to warn them.
 *
 * `health` is still a whole-table reference. That case is well defined —
 * Drizzle knows the table and returns null only when the joined row is absent —
 * and its first column is the non-null primary key, so it is correct under
 * either rule. The regression tests pin both directions regardless.
 */
function toView(row: Row): PanelView {
  return {
    panel: toRecord(row.panel),
    credentials: {
      usernameSetAt: row.usernameSetAt,
      passwordSetAt: row.passwordSetAt,
      apiTokenSetAt: row.apiTokenSetAt,
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
