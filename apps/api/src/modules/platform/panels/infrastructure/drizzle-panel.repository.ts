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
  panelProbeBudgets,
  panelProbeClaims,
  panels,
} from '../../../../infrastructure/persistence/schema.js';
import { isUniqueViolation } from '../../../../infrastructure/persistence/sqlstate.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  CreatePanelInput,
  DuePanel,
  MonitorDueReason,
  PanelHealthRecord,
  PanelMonitorRepository,
  PanelRecord,
  PanelRepository,
  PanelView,
  ProbeBudget,
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
        createdAt: input.at,
        updatedAt: input.at,
      })
      .returning();
    if (row === undefined) throw new Error('panel insert returned no row');
    return toRecord(row);
  }

  async update(
    scope: TenantContext,
    panelId: string,
    input: UpdatePanelInput,
    at: Date,
    tx: TransactionScope,
  ): Promise<PanelRecord | null> {
    const changes: Record<string, unknown> = { updatedAt: at };
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
        consecutiveFailures: health.consecutiveFailures,
        nextProbeAt: health.nextProbeAt,
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
          consecutiveFailures: health.consecutiveFailures,
          nextProbeAt: health.nextProbeAt,
        },
        // Two conditions, and the second is the interesting one.
        //
        // The tenant predicate is belt and braces on a conflict path: the row
        // being updated must belong to this tenant. Unreachable through the
        // service, which resolves the panel first — and unreachable is where a
        // guard belongs, because the reachable ones get exercised and noticed.
        //
        // The timestamp predicate is stale-result protection. Probes run
        // outside the transaction that stores them, and a slow one can finish
        // after a later, faster one — an operator's manual test overtaking a
        // background probe that is still on the wire, or two monitor replicas
        // whose claims fell either side of a configuration change. Writing the
        // older answer last would move `checked_at` BACKWARDS and replace a
        // fresh verdict with a stale one, which is precisely the thing an
        // operator reads to decide whether their fix worked. The older result
        // is discarded instead: a no-op update, not an error, because nothing
        // is wrong — it simply is not the latest answer any more.
        //
        // `<=` rather than `<`, so a result written twice at the same instant
        // — an idempotent retry — still lands.
        setWhere: sql`
          ${panelHealth.tenantId} = ${scope.tenantId}
          AND ${panelHealth.checkedAt} <= ${health.checkedAt}`,
      });
  }

  /**
   * ONE statement, on the pool, outside any transaction.
   *
   * The insert covers the panel that has never been probed and the update
   * covers every panel after that, and PostgreSQL decides between them under a
   * row lock. On the conflict path it re-evaluates `setWhere` against the
   * row as it stands AFTER waiting for whoever held the lock, so of two
   * requests arriving together exactly one sees a claimable row — which is the
   * property a `SELECT` then an `UPDATE` cannot have and a process-local guard
   * cannot have across two containers.
   *
   * `RETURNING` is how the caller learns which happened. A claim it did not
   * take returns no row.
   */
  async claimProbe(
    scope: TenantContext,
    panelId: string,
    configuration: string,
    at: Date,
    notClaimedSince: Date,
    tx?: TransactionScope,
  ): Promise<boolean> {
    const claimed = await executorOf(this.db, tx)
      .insert(panelProbeClaims)
      .values({ panelId, tenantId: scope.tenantId, configuration, claimedAt: at })
      .onConflictDoUpdate({
        target: panelProbeClaims.panelId,
        set: { configuration, claimedAt: at },
        // Either the panel has changed since the claim was taken — in which
        // case whatever that probe is measuring is no longer the question
        // being asked — or the claim is old enough that a new probe is not a
        // repeat of it. The tenant predicate is belt and braces: the service
        // resolved the panel within the tenant before reaching here.
        setWhere: sql`
          ${panelProbeClaims.tenantId} = ${scope.tenantId}
          AND (
            ${panelProbeClaims.configuration} <> ${configuration}
            OR ${panelProbeClaims.claimedAt} <= ${notClaimedSince}
          )`,
      })
      .returning({ panelId: panelProbeClaims.panelId });
    return claimed.length > 0;
  }

  /**
   * ONE statement. The refill, the cap and the take happen inside it, and
   * the conflict path re-evaluates `WHERE` against the row as it stands after
   * the lock wait — so of N processes racing for the last token, exactly one
   * gets it. A `SELECT` then an `UPDATE` would let all of them read "one
   * left".
   *
   * `refilled_at` moves only on a successful take. A refused take leaves the
   * row alone, so the accrual it was refused against keeps accruing.
   */
  async takeProbeBudget(
    scope: TenantContext,
    bucket: ProbeBudget,
    at: Date,
    tx: TransactionScope,
    /**
     * Tokens this caller must leave behind.
     *
     * Zero for an operator, who may spend the tenant's capacity down to
     * nothing. Positive for the background monitor, which is thereby refused
     * while fewer than `reserve` tokens remain — so a tenant whose panels are
     * all failing and retrying still has capacity when somebody presses "Test
     * connection". It is a FLOOR on the same bucket, not a second budget: the
     * global bound is unchanged and there is no lane the monitor can spend
     * from that an operator cannot see.
     *
     * Enforced inside the same conditional write that takes the token, which
     * is what makes it hold across monitor replicas: two monitors racing on
     * the floor serialise on the tenant's row exactly as they do on the token.
     */
    reserve = 0,
  ): Promise<{ permitted: true; remaining: number } | { permitted: false; retryAfterMs: number }> {
    const { capacity, refillPerMs } = bucket;
    // Clamped HERE rather than trusted from the caller, because the two branches
    // below would otherwise disagree. A tenant with no row takes the insert
    // branch, which spends one token from a full bucket without consulting the
    // floor — correct only while the floor is reachable from a full bucket. A
    // reserve at or above capacity would make the very first probe succeed and
    // every one after it refuse, which is a configuration mistake that looks
    // exactly like a broken monitor. The container caps it too; this is the half
    // that cannot be got wrong by a new caller.
    const floor = Math.max(0, Math.min(reserve, capacity - 1));
    // Tokens as of `at`: what was there, plus what accrued since, capped.
    const accrued = sql`LEAST(
      ${capacity}::double precision,
      ${panelProbeBudgets.tokens}
        + GREATEST(0, EXTRACT(EPOCH FROM (${at}::timestamptz - ${panelProbeBudgets.refilledAt})) * 1000)
          * ${refillPerMs}::double precision
    )`;
    const taken = await tx.tx
      .insert(panelProbeBudgets)
      // A tenant with no row has a full bucket, so the floor is satisfied
      // whenever the capacity itself clears it. `onConflictDoNothing` is not
      // an option here: the insert IS the take.
      .values({ tenantId: scope.tenantId, tokens: capacity - 1, refilledAt: at })
      .onConflictDoUpdate({
        target: panelProbeBudgets.tenantId,
        set: { tokens: sql`${accrued} - 1`, refilledAt: at },
        setWhere: sql`${accrued} >= ${1 + floor}::double precision`,
      })
      .returning({ tokens: panelProbeBudgets.tokens });
    const row = taken[0];
    if (row !== undefined) return { permitted: true, remaining: Math.floor(row.tokens) };

    // Refused. Read what is there to say when a token will exist; informational
    // only, and read after the refusal rather than in the same statement so the
    // statement above stays a single conditional write.
    const [state] = await tx.tx
      .select({ tokens: panelProbeBudgets.tokens, refilledAt: panelProbeBudgets.refilledAt })
      .from(panelProbeBudgets)
      .where(eq(panelProbeBudgets.tenantId, scope.tenantId));
    const have =
      state === undefined
        ? 0
        : Math.min(
            capacity,
            state.tokens + Math.max(0, at.getTime() - state.refilledAt.getTime()) * refillPerMs,
          );
    // How long until this CALLER could take one, which for the monitor means
    // clearing its floor rather than reaching a single token.
    const retryAfterMs = Math.max(1, Math.ceil((1 + floor - have) / refillPerMs));
    return { permitted: false, retryAfterMs };
  }
}

/**
 * Discovery, and the only cross-tenant read in the panels module.
 *
 * A separate class from `DrizzlePanelRepository` because it implements a
 * separate port: everything on that repository filters by tenant, and this
 * deliberately does not. Keeping them apart means the cross-tenant query cannot
 * be reached from a tenant-scoped call site by passing one argument fewer.
 *
 * What it returns is two identifiers and a reason. No name, no address, no
 * credential, no health — the monitor takes the tenant id and does everything
 * else through the tenant-scoped repository, so the blast radius of this class
 * is a list of ids.
 */
export class DrizzlePanelMonitorRepository implements PanelMonitorRepository {
  constructor(private readonly db: Database) {}

  async dueForMonitoring(now: Date, limit: number): Promise<DuePanel[]> {
    /**
     * Whether the panel or its credentials changed after the last probe.
     *
     * The stored answer describes a configuration that no longer exists, so it
     * is not an answer about this panel any more. An operator who has just
     * corrected an address or replaced a password should not wait out a
     * backoff to learn whether the fix worked.
     *
     * Written as a comparison against the stored `checked_at` rather than by
     * clearing the health row: erasing the previous result to force a re-probe
     * would throw away `last_healthy_at` and the state an operator is looking
     * at, to communicate something the timestamps already say.
     *
     * `-infinity` for an absent credential timestamp, so `GREATEST` over three
     * columns of which two are null is the one that is set, and not null.
     */
    const reconfigured = sql`(
      ${panels.updatedAt} > ${panelHealth.checkedAt}
      OR GREATEST(
           COALESCE(${panelCredentials.usernameSetAt}, '-infinity'::timestamptz),
           COALESCE(${panelCredentials.passwordSetAt}, '-infinity'::timestamptz),
           COALESCE(${panelCredentials.apiTokenSetAt}, '-infinity'::timestamptz)
         ) > ${panelHealth.checkedAt}
    )`;

    const result = await this.db.execute<{
      tenant_id: string;
      panel_id: string;
      reason: string;
    }>(sql`
      WITH due AS (
        SELECT
          ${panels.tenantId} AS tenant_id,
          ${panels.id} AS panel_id,
          -- A panel that has never been probed sorts by when it was created,
          -- so the queue is deterministic for them too rather than depending
          -- on whatever order the scan happened to produce.
          COALESCE(${panelHealth.nextProbeAt}, ${panels.createdAt}) AS due_at,
          CASE
            WHEN ${panelHealth.panelId} IS NULL THEN 'NEVER_CHECKED'
            WHEN ${reconfigured} THEN 'CONFIGURATION_CHANGED'
            ELSE 'INTERVAL_ELAPSED'
          END AS reason
        FROM ${panels}
        LEFT JOIN ${panelHealth} ON ${panelHealth.panelId} = ${panels.id}
        LEFT JOIN ${panelCredentials} ON ${panelCredentials.panelId} = ${panels.id}
        -- ACTIVE only, and this predicate is also the partial index's
        -- predicate. A DISABLED or ARCHIVED panel is not skipped downstream;
        -- it is not in the index this query reads.
        WHERE ${panels.status} = 'ACTIVE'
          AND (
            ${panelHealth.panelId} IS NULL
            OR ${panelHealth.nextProbeAt} <= ${now}
            OR ${reconfigured}
          )
      ),
      ranked AS (
        SELECT
          due.*,
          -- Tenant fairness. Rank 1 is every tenant's most overdue panel, rank
          -- 2 their second, and the outer ORDER BY takes all the rank 1s
          -- before any rank 2. An ORDER BY due_at LIMIT n instead would let
          -- one tenant with a hundred overdue panels fill every cycle for
          -- ever. panel_id breaks the tie so the order is total and stable.
          row_number() OVER (
            PARTITION BY due.tenant_id
            ORDER BY due.due_at ASC, due.panel_id ASC
          ) AS rn
        FROM due
      )
      SELECT tenant_id, panel_id, reason
      FROM ranked
      ORDER BY rn ASC, due_at ASC, panel_id ASC
      LIMIT ${limit}
    `);
    return result.rows.map((row) => ({
      tenantId: row.tenant_id,
      panelId: row.panel_id,
      // Narrowed from the CASE above, which produces exactly these three.
      reason: row.reason as MonitorDueReason,
    }));
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
            consecutiveFailures: row.health.consecutiveFailures,
            nextProbeAt: row.health.nextProbeAt,
          },
  };
}
