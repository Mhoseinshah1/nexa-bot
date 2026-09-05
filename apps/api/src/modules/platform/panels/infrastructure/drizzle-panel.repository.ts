import { and, asc, eq, ne, sql, type SQL } from 'drizzle-orm';
import { errors, PANEL_ERROR_CODES } from '@nexa/contracts';
import type {
  MonitorDeferralReason,
  PanelHealthState,
  PanelStatus,
  ProviderFailureKind,
  ProviderType,
  TenantContext,
} from '@nexa/contracts';
import { SCHEDULE_SUSPENDED_AT } from '../domain/monitor-cadence.js';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  panelCredentials,
  panelHealth,
  panelMonitorSchedule,
  panelMonitorTenants,
  panelProbeBudgets,
  panelProbeClaims,
  panels,
} from '../../../../infrastructure/persistence/schema.js';
import { isUniqueViolation } from '../../../../infrastructure/persistence/sqlstate.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  CreatePanelInput,
  DuePanel,
  HealthWriteOutcome,
  PanelHealthRecord,
  PanelMonitorRepository,
  PanelRecord,
  PanelRepository,
  PanelScheduleRecord,
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

/**
 * Turns the live-name unique violation into the conflict the API documents.
 *
 * Every live-name write pre-checks with `nameTaken`, and a pre-check cannot
 * prevent a race: two requests naming the same panel both pass it, one insert
 * wins and the other took an unhandled 23505 out through the error filter as a
 * 500. The index is the real rule; this is how the rule reaches the caller.
 *
 * Named constraint, not bare 23505: `panels` can grow another unique index, and
 * mapping an unrelated violation to "name taken" would be a confident wrong
 * answer instead of an honest error.
 */
function rethrowNameConflict(error: unknown, message: string): never {
  if (isUniqueViolation(error, 'panels_tenant_name_live_key')) {
    throw errors.conflict(PANEL_ERROR_CODES.PANEL_NAME_TAKEN, message);
  }
  throw error;
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
    let row;
    try {
      [row] = await tx.tx
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
    } catch (error) {
      rethrowNameConflict(
        error,
        'Another panel of this tenant already uses that name. Choose a different one.',
      );
    }
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

    let row;
    try {
      [row] = await tx.tx
        .update(panels)
        .set(changes)
        .where(and(eq(panels.id, panelId), eq(panels.tenantId, scope.tenantId)))
        .returning();
    } catch (error) {
      rethrowNameConflict(
        error,
        'Another panel of this tenant already uses that name. Choose a different one.',
      );
    }
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
  ): Promise<HealthWriteOutcome> {
    const columns = {
      state: health.state,
      checkedAt: health.checkedAt,
      latencyMs: health.latencyMs,
      failure: health.failure,
      statusCode: health.statusCode,
      providerVersion: health.providerVersion,
      lastHealthyAt: health.lastHealthyAt,
    };
    const written = await tx.tx
      .insert(panelHealth)
      .values({ panelId, tenantId: scope.tenantId, ...columns })
      .onConflictDoUpdate({
        target: panelHealth.panelId,
        set: columns,
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
        // operator reads to decide whether their fix worked.
        //
        // `<=` rather than `<`, so a result written twice at the same instant
        // — an idempotent retry — still lands.
        setWhere: sql`
          ${panelHealth.tenantId} = ${scope.tenantId}
          AND ${panelHealth.checkedAt} <= ${health.checkedAt}`,
      })
      // RETURNING is how the CALLER learns which happened. A refused write
      // returns no row, and the caller must not announce a transition to a
      // state the database declined to store.
      .returning({ panelId: panelHealth.panelId });
    return written.length > 0 ? 'APPLIED' : 'STALE_IGNORED';
  }

  async readSchedule(
    scope: TenantContext,
    panelId: string,
    tx?: TransactionScope,
  ): Promise<PanelScheduleRecord | null> {
    const [row] = await executorOf(this.db, tx)
      .select({
        nextEligibleAt: panelMonitorSchedule.nextEligibleAt,
        consecutiveFailures: panelMonitorSchedule.consecutiveFailures,
        deferredReason: panelMonitorSchedule.deferredReason,
      })
      .from(panelMonitorSchedule)
      .where(
        and(
          eq(panelMonitorSchedule.panelId, panelId),
          eq(panelMonitorSchedule.tenantId, scope.tenantId),
        ),
      )
      .limit(1);
    if (row === undefined) return null;
    return {
      nextEligibleAt: row.nextEligibleAt,
      consecutiveFailures: row.consecutiveFailures,
      deferredReason: row.deferredReason as MonitorDeferralReason | null,
    };
  }

  async scheduleNext(
    scope: TenantContext,
    panelId: string,
    next: {
      readonly nextEligibleAt: Date;
      readonly consecutiveFailures: number;
      readonly deferredReason: MonitorDeferralReason | null;
      readonly at: Date;
    },
    tx: TransactionScope,
  ): Promise<void> {
    await this.writeSchedule(
      scope,
      panelId,
      {
        nextEligibleAt: next.nextEligibleAt,
        consecutiveFailures: next.consecutiveFailures,
        deferredReason: next.deferredReason,
        at: next.at,
      },
      tx,
      // A deferral (`deferredReason` set) is monotonic; a probe result is not.
      next.deferredReason !== null,
    );
  }

  async setScheduleEligibility(
    scope: TenantContext,
    panelId: string,
    eligibility: 'ELIGIBLE_NOW' | 'SUSPENDED',
    at: Date,
    tx: TransactionScope,
  ): Promise<void> {
    await this.writeSchedule(
      scope,
      panelId,
      {
        nextEligibleAt: eligibility === 'SUSPENDED' ? SCHEDULE_SUSPENDED_AT : at,
        // An operator edit clears the backoff as well as the deferral. The
        // streak was evidence about a configuration that no longer exists.
        consecutiveFailures: 0,
        deferredReason: eligibility === 'SUSPENDED' ? 'STATUS_NOT_PROBEABLE' : null,
        at,
      },
      tx,
    );
  }

  /**
   * The one place a schedule row is written, and the tenant's bound with it.
   *
   * Two statements in the caller's transaction, and the second is what makes
   * fairness work: the tenant's `next_eligible_at` is a LOWER BOUND, moved down
   * with `LEAST` and never up. A panel becoming eligible sooner must pull its
   * tenant's bound forward or the tenant is simply never claimed; a panel
   * becoming eligible later must NOT push it back, because some other panel of
   * the same tenant may still be due.
   */
  /**
   * Moves a panel's schedule, and the tenant's lower bound with it.
   *
   * Two rules are enforced HERE rather than at the call sites, because a call
   * site that forgets one produces a defect nothing else can see.
   *
   * The eligible moment is derived from the panel's own status, not from what
   * the caller asked for. `setStatus` did ask correctly; `update` and
   * `setCredentials` did not, and an operator who rotated the rejected password
   * of a DISABLED panel re-armed it — after which the discovery scan, which
   * carries no status predicate BECAUSE the schedule is the status filter,
   * returned it once an hour for ever. Deriving it in the statement means no
   * caller can arm a panel the operator switched off.
   *
   * `monotonic` writes are for a DEFERRAL, which may push a panel further out
   * and must never pull it nearer. A refusal describes the loop's own state —
   * a cooldown, an exhausted budget — and knows nothing about the provider. Two
   * monitors overlap on every rolling update, so a replica whose discovery list
   * predates the other's probe will be refused by the per-panel cooldown and
   * try to defer a panel a real probe has just pushed an hour out. Without this
   * the deferral wins, and the panel whose credential the provider rejected is
   * dialled again in a minute instead of in thirty — which is the credential
   * hammering the non-retryable floor exists to prevent.
   */
  private async writeSchedule(
    scope: TenantContext,
    panelId: string,
    next: {
      readonly nextEligibleAt: Date;
      readonly consecutiveFailures: number;
      readonly deferredReason: MonitorDeferralReason | null;
      readonly at: Date;
    },
    tx: TransactionScope,
    monotonic = false,
  ): Promise<void> {
    const proposed = sql`CASE WHEN p.status = 'ACTIVE' THEN ${next.nextEligibleAt}::timestamptz
                              ELSE ${SCHEDULE_SUSPENDED_AT}::timestamptz END`;
    const reason = sql`CASE WHEN p.status = 'ACTIVE' THEN ${next.deferredReason}::text
                            ELSE 'STATUS_NOT_PROBEABLE'::text END`;
    // A deferral may only push the moment later. Everything else — a probe that
    // produced health, an operator edit, a status change — is authoritative.
    const settled = monotonic
      ? sql`GREATEST(${panelMonitorSchedule.nextEligibleAt}, EXCLUDED.next_eligible_at)`
      : sql`EXCLUDED.next_eligible_at`;
    // And it must not touch the streak. A deferral is not a failed probe — the
    // backoff describes what the PROVIDER said, and on a deferral the provider
    // was never asked. Writing zero here erased the streak of a genuinely
    // failing panel, and `BUDGET_EXHAUSTED` is routine rather than rare: with
    // the shipped defaults a tenant's reserve floor leaves well under half a
    // full batch probeable, so the rest are deferred every window. The
    // documented 1, 2, 4, 8 backoff then never left 1x, and a panel whose
    // credential the provider had rejected was re-dialled at the floor for ever
    // instead of backing off.
    const streak = monotonic
      ? sql`${panelMonitorSchedule.consecutiveFailures}`
      : sql`EXCLUDED.consecutive_failures`;

    // One statement, so the tenant's bound is dragged down by a write that
    // actually happened. Written separately, a schedule write refused by the
    // tenant predicate still moved the rotation row.
    await tx.tx.execute(sql`
      WITH written AS (
        INSERT INTO ${panelMonitorSchedule}
               (panel_id, tenant_id, next_eligible_at, consecutive_failures, deferred_reason, updated_at)
        SELECT p.id, p.tenant_id, ${proposed}, ${next.consecutiveFailures}, ${reason}, ${next.at}
          FROM ${panels} AS p
         WHERE p.id = ${panelId} AND p.tenant_id = ${scope.tenantId}
        ON CONFLICT (panel_id) DO UPDATE
           SET next_eligible_at    = ${settled},
               consecutive_failures = ${streak},
               deferred_reason      = EXCLUDED.deferred_reason,
               updated_at           = EXCLUDED.updated_at
         WHERE ${panelMonitorSchedule.tenantId} = ${scope.tenantId}
        RETURNING tenant_id, next_eligible_at
      )
      INSERT INTO ${panelMonitorTenants} (tenant_id, next_eligible_at, last_served_at)
      SELECT tenant_id, next_eligible_at, to_timestamp(0) FROM written
      ON CONFLICT (tenant_id) DO UPDATE
         SET next_eligible_at = LEAST(${panelMonitorTenants.nextEligibleAt}, EXCLUDED.next_eligible_at)
    `);
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
    // The floor, and the direction it is clamped in is the safety property.
    //
    // A caller with `reserve > 0` is the background monitor, and the invariant
    // is that an operator always outranks it for a tenant's LAST token. So a
    // positive reserve is never rounded down to zero: at capacity 1 the floor
    // stays 1, the monitor can never take the only token, and the operator
    // keeps their "Test connection". The previous version clamped to
    // `capacity - 1`, which at capacity 1 is zero — precisely the case where
    // the protection matters most, switched off.
    //
    // The cost is stated plainly: on a tenant whose capacity is smaller than
    // the reserve, background monitoring simply does not run. That is the right
    // way round. Monitoring is a convenience; an operator locked out of their
    // own panel while diagnosing an outage is not.
    const floor = reserve <= 0 ? 0 : Math.max(1, Math.min(reserve, capacity));
    // Tokens as of `at`: what was there, plus what accrued since, capped.
    const accrued = sql`LEAST(
      ${capacity}::double precision,
      ${panelProbeBudgets.tokens}
        + GREATEST(0, EXTRACT(EPOCH FROM (${at}::timestamptz - ${panelProbeBudgets.refilledAt})) * 1000)
          * ${refillPerMs}::double precision
    )`;
    // A tenant with no row has a full bucket. The insert IS the take, so it has
    // to answer the same question the update branch does: does spending one
    // leave the floor behind? At capacity 1 with a floor of 1 the answer is no,
    // and the monitor is refused before the row is ever created — which is what
    // stops the very first background probe from taking the token an operator
    // is entitled to.
    if (capacity < 1 + floor) {
      // Not "try again later" but "not until this tenant's capacity is
      // configured higher". Reported as a full refill of the bucket, which is
      // finite and the soonest anything could change — an infinity here would
      // poison every caller that turns this into a delay or a retry-after
      // header.
      return { permitted: false, retryAfterMs: Math.ceil(capacity / refillPerMs) };
    }
    const taken = await tx.tx
      .insert(panelProbeBudgets)
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
 * A claimed tenant list as a parameterised `VALUES` list.
 *
 * Every id is a BOUND parameter, never text spliced into the statement. These
 * ids come from the database a moment earlier and are UUIDs, but "the input is
 * already trusted" is the reasoning that puts an injection in a codebase, and a
 * list built by concatenation is one refactor away from taking its ids from
 * somewhere else.
 *
 * `VALUES` rather than `unnest(... ::uuid[])` for a plainer reason: drizzle's
 * `sql` template expands a JavaScript array into one placeholder PER ELEMENT,
 * so an array handed to `unnest` never arrives as an array at all — the query
 * ran, matched nothing, and the monitor quietly discovered no panels.
 */
function tenantList(tenantIds: readonly string[]): SQL {
  return sql.join(
    tenantIds.map((id) => sql`(${id}::uuid)`),
    sql`, `,
  );
}

/**
 * The due-panel scan, as a statement rather than a call.
 *
 * Exported so the plan regression test can run `EXPLAIN (ANALYZE, BUFFERS)`
 * over EXACTLY what production runs. A test that retyped the SQL would go on
 * asserting a bounded plan for a query the repository no longer issues, which
 * is the failure mode that makes plan tests worthless.
 */
export function dueForTenantsQuery(
  tenantIds: readonly string[],
  now: Date,
  perTenant: number,
  batchSize: number,
): SQL {
  return sql`
      SELECT c.tenant_id, c.panel_id
        FROM (VALUES ${tenantList(tenantIds)}) AS r(tenant_id)
       CROSS JOIN LATERAL (
              SELECT s.tenant_id, s.panel_id, s.next_eligible_at
                FROM ${panelMonitorSchedule} AS s
               WHERE s.tenant_id = r.tenant_id
                 AND s.next_eligible_at <= ${now}
               ORDER BY s.next_eligible_at ASC, s.panel_id ASC
               LIMIT ${perTenant}
            ) AS c
       ORDER BY c.next_eligible_at ASC, c.panel_id ASC
       LIMIT ${batchSize}
    `;
}

/**
 * Discovery, and the only cross-tenant read in the panels module.
 *
 * A separate class from `DrizzlePanelRepository` because it implements a
 * separate port: everything on that repository filters by tenant, and this
 * deliberately does not. Keeping them apart means the cross-tenant query cannot
 * be reached from a tenant-scoped call site by passing one argument fewer.
 *
 * Every statement here is bounded by the number of TENANTS claimed or by the
 * per-tenant share, and never by how many panels are due. That is the whole
 * design: the previous version ranked the entire due population with a window
 * function and then took fifty rows, so a hundred thousand overdue panels meant
 * a hundred thousand rows ranked and sorted every thirty seconds to probe
 * fifty of them.
 */
export class DrizzlePanelMonitorRepository implements PanelMonitorRepository {
  constructor(private readonly db: Database) {}

  async claimTenants(now: Date, limit: number): Promise<string[]> {
    if (limit <= 0) return [];
    /**
     * One statement: choose the turn and take it.
     *
     * `FOR UPDATE SKIP LOCKED` on the inner select is what makes two monitor
     * replicas take disjoint tenants instead of both working the tenant at the
     * front of the queue. The `UPDATE` moving `last_served_at` is the turn
     * being spent, and it commits with the claim — so a replica that dies
     * mid-tick has still spent the turn, which is the safe direction: a tenant
     * waits one extra round rather than being served twice while another waits
     * for ever.
     *
     * Bounded by the number of tenants, which on this deployment model is tens.
     * It is emphatically NOT bounded by the number of due panels, and that is
     * the property the whole two-phase shape exists to buy.
     */
    const claimed = await this.db.execute<{ tenant_id: string }>(sql`
      UPDATE ${panelMonitorTenants} AS t
         SET last_served_at = ${now}
       WHERE t.tenant_id IN (
             SELECT r.tenant_id
               FROM ${panelMonitorTenants} AS r
              WHERE r.next_eligible_at <= ${now}
              ORDER BY r.last_served_at ASC, r.tenant_id ASC
              LIMIT ${limit}
                FOR UPDATE SKIP LOCKED
           )
      RETURNING t.tenant_id
    `);
    return claimed.rows.map((row) => row.tenant_id);
  }

  async dueForTenants(
    tenantIds: readonly string[],
    now: Date,
    perTenant: number,
    batchSize: number,
  ): Promise<DuePanel[]> {
    if (tenantIds.length === 0 || perTenant <= 0 || batchSize <= 0) return [];
    /**
     * One bounded index range scan per claimed tenant.
     *
     * `LATERAL` with a `LIMIT` inside is the shape that matters: for each
     * tenant the planner walks `panel_monitor_schedule_due_idx` forward from
     * the start of that tenant's range and stops after `perTenant` entries. No
     * sort of the due population, no window function, and nothing read that is
     * not returned.
     *
     * There is deliberately NO join to `panels` here, and that is a correction
     * rather than an omission. A `status = 'ACTIVE'` predicate looked like
     * cheap defence in depth, and measurement said otherwise: with a join in
     * the LATERAL the planner is free to fetch every one of the tenant's
     * eligible rows, join them, and only then sort and limit — which it does
     * exactly when many rows share a timestamp, and which the plan regression
     * test caught reading five hundred rows to return five.
     *
     * The status filter is the schedule itself. A panel that is not ACTIVE is
     * eligible in year 9999, written in the same transaction as the status
     * change, so a `DISABLED` panel is not skipped by this scan — it is outside
     * the range the scan reads. The probe core then checks the status again
     * against the row it actually reads, which covers the window between this
     * query and the probe. Two enforcement points, neither of which costs the
     * bound.
     */
    const result = await this.db.execute<{ tenant_id: string; panel_id: string }>(
      dueForTenantsQuery(tenantIds, now, perTenant, batchSize),
    );
    return result.rows.map((row) => ({ tenantId: row.tenant_id, panelId: row.panel_id }));
  }

  /**
   * Creates the scheduler rows for any panel that has none. See the port.
   *
   * Deliberately the same shape as migration 0022's backfill — a non-ACTIVE
   * panel is created suspended, an ACTIVE one due now — because it is repairing
   * exactly what that backfill would have created had it run later. The
   * anti-join is one indexed pass over `panels`, run at startup rather than per
   * tick.
   */
  async reconcileSchedules(now: Date): Promise<number> {
    const inserted = await this.db.execute<{ panel_id: string }>(sql`
      WITH created AS (
        INSERT INTO ${panelMonitorSchedule}
               (panel_id, tenant_id, next_eligible_at, consecutive_failures, deferred_reason, updated_at)
        SELECT p.id, p.tenant_id,
               CASE WHEN p.status = 'ACTIVE' THEN ${now}::timestamptz
                    ELSE ${SCHEDULE_SUSPENDED_AT}::timestamptz END,
               0,
               CASE WHEN p.status = 'ACTIVE' THEN NULL ELSE 'STATUS_NOT_PROBEABLE' END,
               ${now}
          FROM ${panels} AS p
         WHERE NOT EXISTS (
                 SELECT 1 FROM ${panelMonitorSchedule} AS s WHERE s.panel_id = p.id
               )
        ON CONFLICT (panel_id) DO NOTHING
        RETURNING panel_id, tenant_id, next_eligible_at
      ), bounds AS (
        INSERT INTO ${panelMonitorTenants} (tenant_id, next_eligible_at, last_served_at)
        SELECT tenant_id, MIN(next_eligible_at), to_timestamp(0)
          FROM created GROUP BY tenant_id
        ON CONFLICT (tenant_id) DO UPDATE
           SET next_eligible_at = LEAST(${panelMonitorTenants.nextEligibleAt}, EXCLUDED.next_eligible_at)
      )
      SELECT panel_id FROM created
    `);
    return inserted.rows.length;
  }

  async overCapacityTenants(
    upperBoundPerTenant: number,
  ): Promise<{ tenantId: string; panels: number }[]> {
    const result = await this.db.execute<{ tenant_id: string; panels: string }>(sql`
      SELECT tenant_id, count(*)::text AS panels
        FROM ${panels}
       WHERE status = 'ACTIVE'
       GROUP BY tenant_id
      HAVING count(*) > ${upperBoundPerTenant}
       ORDER BY count(*) DESC
    `);
    return result.rows.map((row) => ({ tenantId: row.tenant_id, panels: Number(row.panels) }));
  }

  async refreshTenantBounds(tenantIds: readonly string[]): Promise<void> {
    if (tenantIds.length === 0) return;
    /**
     * Put each claimed tenant's lower bound back where its own schedule says.
     *
     * One index-ordered `LIMIT 1` per tenant — the cheapest possible read of a
     * minimum. Suspended-forever when the tenant has no schedule rows at all, so a
     * tenant with no panels stops being claimed rather than being claimed for
     * ever to rediscover that.
     *
     * Deliberately unconditional rather than "only when the tenant came back
     * short". A tenant that filled its share may still have had its bound
     * dragged earlier by an unrelated write, and recomputing costs one index
     * probe.
     */
    await this.db.execute(sql`
      UPDATE ${panelMonitorTenants} AS t
         SET next_eligible_at = COALESCE(m.next_eligible_at, ${SCHEDULE_SUSPENDED_AT})
        FROM (VALUES ${tenantList(tenantIds)}) AS c(tenant_id)
        LEFT JOIN LATERAL (
             SELECT s.next_eligible_at
               FROM ${panelMonitorSchedule} AS s
              WHERE s.tenant_id = c.tenant_id
              ORDER BY s.next_eligible_at ASC
              LIMIT 1
           ) AS m ON TRUE
       WHERE t.tenant_id = c.tenant_id
    `);
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
