import { and, eq, sql } from 'drizzle-orm';
import {
  EXPIRY_DAY_MIN_NOTICE_MS,
  EXPIRY_REMINDER_KINDS,
  EXPIRY_REMINDER_STATES,
  SERVICE_REMINDER_NOTIFICATION_KINDS,
  USAGE_REMINDER_KINDS,
  USAGE_REMINDER_STATES,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { serviceReminders } from '../../../../infrastructure/persistence/schema.js';
import { importedUnmeasuredUsageNotice } from '../../../../infrastructure/persistence/imported-usage-notice.js';
import { importedServiceNoticeRefused } from '../../../../infrastructure/persistence/imported-notice-guard.js';
import type {
  ServiceReminderBasis,
  ServiceReminderCandidate,
  ServiceReminderRaise,
  ServiceReminderRepository,
  ServiceReminderSnapshot,
  ServiceReminderSnapshotReader,
} from '../application/service-reminder.ports.js';

/** What both candidate queries select, in the order they select it. */
interface CandidateRow {
  readonly id: string;
  readonly customer_id: string;
  readonly provider_username: string;
  readonly expires_at: string | null;
  readonly traffic_limit_bytes: string;
  readonly traffic_used_bytes: string;
  /** WP-A9: the expiry query only. */
  readonly expiry_day_starts_at?: string | null;
  /** Round 4 PR-H: the import baseline for the current period (`IMPORT_BASELINE_COLUMNS`). */
  readonly baseline_at?: string | null;
  readonly baseline_used_bytes?: string | null;
  /** Round 5A-2: an imported service with no baseline row. */
  readonly import_unproven?: boolean | null;
}

/**
 * Round 4 PR-H: the import baseline of the service aliased `s`, for its CURRENT period,
 * from the row aliased `b` (`service_reminder_baselines`, LEFT JOINed) — selected beside the
 * candidate so the sweep's decision and the query's row cannot disagree.
 *
 * - With a baseline row: both, while the period is still the imported one — the deadline
 *   AND the allowance, the two columns `service_reminders_period_key` keys a period on.
 *   A renewal or added traffic is a new period (added traffic re-arms the expiry kinds too,
 *   the stated cost on that key), and the row then says nothing about it (Codex review of
 *   PR #296: comparing the deadline alone swallowed a re-armed expiry reminder).
 * - An IMPORTED service with no row — one an earlier release adopted, before the row
 *   existed: its creation is when the import made it, so that is `baseline_at`, and the
 *   figure on the row is the import's only while no later sync has replaced it
 *   (`usage_synced_at <= created_at`). Its period cannot be told apart from a later one, so
 *   the rule is narrower than with a row: a period that began after the import has its
 *   thresholds after the import too, and only a renewal ending within days of the import
 *   could have one before it.
 * - A native service (`source = 'NEXA'`): neither, ever.
 */
const IMPORT_BASELINE_JOIN = sql`
  LEFT JOIN service_reminder_baselines b ON b.tenant_id = s.tenant_id AND b.service_id = s.id`;
const IMPORT_BASELINE_COLUMNS = sql`
  CASE
    WHEN b.service_id IS NOT NULL THEN
      CASE WHEN b.basis_expires_at IS NOT DISTINCT FROM s.expires_at
                AND b.basis_traffic_limit_bytes = s.traffic_limit_bytes
           THEN b.baseline_at END
    WHEN s.source <> 'NEXA' THEN s.created_at
  END AS baseline_at,
  CASE
    WHEN b.service_id IS NOT NULL THEN
      CASE WHEN b.basis_expires_at IS NOT DISTINCT FROM s.expires_at
                AND b.basis_traffic_limit_bytes = s.traffic_limit_bytes
           THEN b.used_bytes END
    WHEN s.source <> 'NEXA' AND s.usage_synced_at IS NOT NULL
         AND s.usage_synced_at <= s.created_at THEN s.traffic_used_bytes
  END AS baseline_used_bytes,
  (s.source <> 'NEXA' AND b.service_id IS NULL) AS import_unproven`;

function toCandidate(row: CandidateRow): ServiceReminderCandidate {
  const limit = BigInt(row.traffic_limit_bytes);
  return {
    serviceId: row.id,
    customerId: row.customer_id as UserId,
    providerUsername: row.provider_username,
    /*
     * A `Date` for the DECISION only, and the text beside it for the basis.
     *
     * `execute` returns every column as the string Postgres rendered, so this parse is
     * the only one — and it loses the microseconds, which is why it is not what gets
     * written back. See `ServiceReminderBasis`.
     */
    expiresAt: row.expires_at === null ? null : new Date(row.expires_at),
    expiryDayStartsAt:
      row.expiry_day_starts_at === undefined || row.expiry_day_starts_at === null
        ? null
        : new Date(row.expiry_day_starts_at),
    /*
     * `BigInt('123')` is exact; `Number('123')` is exact until it is not, and the
     * comparison this feeds is `used * 100 >= limit * percent`, where a rounded operand
     * is a customer told at the wrong moment or not at all. The same rule money follows,
     * for the same reason.
     */
    trafficLimitBytes: limit,
    trafficUsedBytes: BigInt(row.traffic_used_bytes),
    basis: { expiresAt: row.expires_at, trafficLimitBytes: limit },
    importUnproven: row.import_unproven === true,
    importBaseline:
      row.baseline_at === undefined || row.baseline_at === null
        ? null
        : {
            at: new Date(row.baseline_at),
            usedBytes:
              row.baseline_used_bytes === undefined || row.baseline_used_bytes === null
                ? null
                : BigInt(row.baseline_used_bytes),
          },
  };
}

/**
 * The reminder lane's candidate queries and its one write.
 *
 * Raw SQL rather than the query builder for the two reads, because both need
 * `IS NOT DISTINCT FROM` against a nullable deadline and a correlated `NOT EXISTS`
 * whose matched kind is computed from the row being matched. Written through the
 * builder it would be three nested `sql` fragments in a `where` and harder to read than
 * the statement itself.
 */
export class DrizzleServiceReminderRepository implements ServiceReminderRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  /**
   * Services whose deadline is inside the window and whose DUE reminder is unraised.
   *
   * The `NOT EXISTS` matches the due kind ALONE, which is what makes each pass finite:
   * once the due kind is written the service drops out of this query entirely, and it
   * comes back only when the deadline moves it to a more urgent tier or a renewal
   * changes the basis. A filter that merely asked "are there fewer than three rows"
   * would hand the same two hundred services back on every tick for as long as they sat
   * inside the window, and the services behind them would never be reached.
   *
   * The three tiers are compared against BOUND PARAMETERS the caller derived from the
   * TENANT'S settings, so no threshold appears in this file at all — which is the
   * point, because they are `reminders.expiry_first_days` and `_second_days` now and an
   * operator moves them while the worker runs. The
   * ladder's shape still mirrors `expiryReminderDue`, which is why the caller re-decides
   * each returned row with that function and uses its answer.
   *
   * `basis_expires_at IS NOT DISTINCT FROM s.expires_at` rather than `=`, because a
   * NULL deadline is unlimited validity and `NULL = NULL` is NULL — which would make the
   * `NOT EXISTS` true for ever. Such a service is filtered out by
   * `expires_at IS NOT NULL` above, so the comparison is defensive rather than
   * load-bearing here; it is load-bearing in the usage query, where a service with no
   * deadline is an ordinary candidate.
   */
  async listExpiryCandidates(
    scope: TenantContext,
    bounds: {
      readonly now: Date;
      readonly secondAt: Date;
      readonly firstAt: Date;
      readonly windowAt: Date;
    },
    limit: number,
    tx: TransactionScope,
  ): Promise<readonly ServiceReminderCandidate[]> {
    const tenantId = requireTenantId(scope);
    /*
     * WP-A9: the ladder has five rungs, and one of them is a CALENDAR boundary.
     *
     * `day_start` is local midnight of the deadline's own date in the tenant's display
     * timezone — `date_trunc` on the wall-clock time, converted back to an instant. It is
     * computed here, SELECTED beside the row, and used by `expiryReminderDue` as given, so
     * the filter and the decision cannot disagree across a daylight-saving change. The
     * zone is the tenant ROW's own, which is the one every message renders dates in; no
     * zone is written in code.
     *
     * The rung begins at the EARLIER of that midnight and `EXPIRY_DAY_MIN_NOTICE_MS` before
     * the deadline (`expiryDayRungStart`), so a deadline minutes after midnight still has a
     * rung at least one sweep long and the day-of reminder is not skipped.
     */
    const result = await this.exec(tx).execute(sql`
      SELECT c.id, c.customer_id, c.provider_username, c.expires_at,
             c.traffic_limit_bytes, c.traffic_used_bytes,
             c.day_start AS expiry_day_starts_at, c.baseline_at, c.baseline_used_bytes,
             c.import_unproven
      FROM (
        SELECT s.id, s.tenant_id, s.customer_id, s.provider_username, s.expires_at,
               s.traffic_limit_bytes, s.traffic_used_bytes,
               LEAST(
                 date_trunc('day', s.expires_at AT TIME ZONE t.display_timezone)
                   AT TIME ZONE t.display_timezone,
                 s.expires_at - make_interval(secs => ${EXPIRY_DAY_MIN_NOTICE_MS / 1000})
               ) AS day_start,
               ${IMPORT_BASELINE_COLUMNS}
        FROM services s
        JOIN tenants t ON t.id = s.tenant_id
        ${IMPORT_BASELINE_JOIN}
        WHERE s.tenant_id = ${tenantId}
          AND s.state = ANY(${sql.param([...EXPIRY_REMINDER_STATES])}::text[])
          AND s.expires_at IS NOT NULL
          AND s.expires_at <= ${bounds.windowAt}
      ) c
      WHERE NOT EXISTS (
          SELECT 1 FROM service_reminders r
          WHERE r.tenant_id = c.tenant_id
            AND r.service_id = c.id
            AND r.kind = CASE
              WHEN c.expires_at <= ${bounds.now} THEN 'EXPIRED'
              WHEN c.day_start <= ${bounds.now} THEN 'EXPIRY_DAY'
              WHEN c.expires_at <= ${bounds.secondAt} THEN 'EXPIRY_SECOND'
              WHEN c.expires_at <= ${bounds.firstAt} THEN 'EXPIRY_FIRST'
              ELSE 'EXPIRY_EARLY'
            END
            AND r.basis_expires_at IS NOT DISTINCT FROM c.expires_at
        )
      ORDER BY c.expires_at ASC, c.id ASC
      LIMIT ${limit}
    `);
    return (result.rows as unknown as CandidateRow[]).map(toCandidate);
  }

  /**
   * Services past the lowest usage threshold whose highest reached kind is unraised.
   *
   * `traffic_limit_bytes > 0` is the unlimited sentinel, refused here and again in
   * `usageReached`. Multiplying by it would divide a percentage by nothing; more to the
   * point, a customer with no allowance cannot be four fifths of the way through one.
   *
   * `usage_synced_at IS NOT NULL` is the rule that keeps this lane honest. A service
   * whose figure has never been read from the panel has `traffic_used_bytes` at zero
   * because nobody asked, not because nothing was used — and `0 >= 80%` is false, so
   * today the predicate changes no outcome. It is here because the failure it prevents
   * is the one that arrives with the first defaulting bug: a figure that is a
   * placeholder being treated as a measurement, in the one lane that turns measurements
   * into messages to customers.
   *
   * The basis comparison uses BOTH columns. An ADD_TRAFFIC moves the allowance and a
   * RENEW moves the deadline, and a renewal is what resets the panel's usage counter —
   * so a period whose allowance is unchanged is still a new period, and a customer who
   * renews and climbs back past eighty percent is told again.
   */
  async listUsageCandidates(
    scope: TenantContext,
    percent: { readonly lowest: number; readonly high: number; readonly full: number },
    limit: number,
    tx: TransactionScope,
  ): Promise<readonly ServiceReminderCandidate[]> {
    const tenantId = requireTenantId(scope);
    const result = await this.exec(tx).execute(sql`
      SELECT s.id, s.customer_id, s.provider_username, s.expires_at,
             s.traffic_limit_bytes, s.traffic_used_bytes,
             ${IMPORT_BASELINE_COLUMNS}
      FROM services s
      ${IMPORT_BASELINE_JOIN}
      WHERE s.tenant_id = ${tenantId}
        AND s.state = ANY(${sql.param([...USAGE_REMINDER_STATES])}::text[])
        AND s.traffic_limit_bytes > 0
        AND s.usage_synced_at IS NOT NULL
        AND s.traffic_used_bytes * 100 >= s.traffic_limit_bytes * ${percent.lowest}
        AND NOT EXISTS (
          SELECT 1 FROM service_reminders r
          WHERE r.tenant_id = s.tenant_id
            AND r.service_id = s.id
            AND r.kind = CASE
              WHEN s.traffic_used_bytes * 100 >= s.traffic_limit_bytes * ${percent.full}
                THEN 'USAGE_FINAL'
              WHEN s.traffic_used_bytes * 100 >= s.traffic_limit_bytes * ${percent.high}
                THEN 'USAGE_SECOND'
              ELSE 'USAGE_FIRST'
            END
            AND r.basis_expires_at IS NOT DISTINCT FROM s.expires_at
            AND r.basis_traffic_limit_bytes = s.traffic_limit_bytes
        )
      ORDER BY (s.traffic_used_bytes * 100) / s.traffic_limit_bytes DESC, s.id ASC
      LIMIT ${limit}
    `);
    return (result.rows as unknown as CandidateRow[]).map(toCandidate);
  }

  /**
   * Inserts one occurrence, or finds the one already there.
   *
   * `ON CONFLICT DO NOTHING` against `service_reminders_period_key`, inferred from the
   * five columns of the unique constraint. The empty `returning` is the answer: a row
   * back means this call wrote it and owes the customer a message, nothing back means
   * somebody already did.
   *
   * No `UPDATE` branch and no `raised_at` refresh on conflict. The row is an occurrence
   * and an occurrence has one time; a second writer touching it would move a timestamp
   * a `customer_notifications` row is already pinned to.
   */
  async raise(
    scope: TenantContext,
    row: ServiceReminderRaise,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const inserted = await this.exec(tx).execute(sql`
      INSERT INTO service_reminders (id, tenant_id, service_id, kind, basis_expires_at,
                                     basis_traffic_limit_bytes, snapshot_service_label,
                                     snapshot_remaining_days, snapshot_used_bytes, raised_at)
      VALUES (${row.id}, ${tenantId}, ${row.serviceId}, ${row.kind},
              ${row.basis.expiresAt}::timestamptz, ${row.basis.trafficLimitBytes},
              ${row.snapshot.serviceLabel}, ${row.snapshot.remainingDays},
              ${row.snapshot.usedBytes}, ${now})
      ON CONFLICT (tenant_id, service_id, kind, basis_expires_at, basis_traffic_limit_bytes)
        DO NOTHING
      RETURNING id
    `);
    return inserted.rows.length > 0;
  }

  /**
   * One service, read exactly as `listExpiryCandidates` and `listUsageCandidates` read
   * theirs — the same columns, the same `expires_at` TEXT for the basis, and the SAME
   * day-start expression — with neither the state filter nor the threshold window.
   *
   * The day start is the expression the expiry query selects, copied rather than shared
   * only because it lives inside a larger statement; `tests/integration/
   * reminder-burst-seed.test.ts` pins that a seeded `EXPIRY_DAY` is exactly the rung the
   * sweep then finds already raised.
   */
  async seedCandidate(
    scope: TenantContext,
    serviceId: string,
    tx: TransactionScope,
  ): Promise<(ServiceReminderCandidate & { readonly usageMeasured: boolean }) | null> {
    const tenantId = requireTenantId(scope);
    const result = await this.exec(tx).execute(sql`
      SELECT s.id, s.customer_id, s.provider_username, s.expires_at,
             s.traffic_limit_bytes, s.traffic_used_bytes,
             (s.usage_synced_at IS NOT NULL) AS usage_measured,
             CASE WHEN s.expires_at IS NULL THEN NULL ELSE LEAST(
               date_trunc('day', s.expires_at AT TIME ZONE t.display_timezone)
                 AT TIME ZONE t.display_timezone,
               s.expires_at - make_interval(secs => ${EXPIRY_DAY_MIN_NOTICE_MS / 1000})
             ) END AS expiry_day_starts_at
      FROM services s
      JOIN tenants t ON t.id = s.tenant_id
      WHERE s.tenant_id = ${tenantId} AND s.id = ${serviceId}
    `);
    const row = (result.rows as unknown as (CandidateRow & { usage_measured: boolean })[])[0];
    if (row === undefined) return null;
    return { ...toCandidate(row), usageMeasured: row.usage_measured };
  }

  /**
   * Round 4 PR-H: the import baseline, once. `ON CONFLICT DO NOTHING` on the primary key, so
   * a rerun of the adoption keeps the first row — the import's — and an empty `returning`
   * says somebody already wrote it. The deadline is cast back from the text the seed's read
   * returned, for the microsecond reason `ServiceReminderBasis` gives: a millisecond copy
   * would never be NOT DISTINCT FROM the column it came from.
   */
  async recordBaseline(
    scope: TenantContext,
    baseline: {
      readonly serviceId: string;
      readonly at: Date;
      readonly basis: ServiceReminderBasis;
      readonly usedBytes: bigint | null;
    },
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const inserted = await this.exec(tx).execute(sql`
      INSERT INTO service_reminder_baselines (tenant_id, service_id, baseline_at,
                                              basis_expires_at, basis_traffic_limit_bytes,
                                              used_bytes, created_at)
      VALUES (${tenantId}, ${baseline.serviceId}, ${baseline.at},
              ${baseline.basis.expiresAt}::timestamptz, ${baseline.basis.trafficLimitBytes},
              ${baseline.usedBytes}, ${baseline.at})
      ON CONFLICT (tenant_id, service_id) DO NOTHING
      RETURNING service_id
    `);
    return inserted.rows.length > 0;
  }

  /** See the port. One conditional UPDATE over a locked, bounded batch; never a DELETE. */
  async supersedeImportedUsageNotices(
    scope: TenantContext,
    limit: number,
    now: Date,
    tx: TransactionScope,
  ): Promise<readonly { readonly kind: string; readonly customerId: string }[]> {
    const tenantId = requireTenantId(scope);
    const kinds = USAGE_REMINDER_KINDS.map((k) => SERVICE_REMINDER_NOTIFICATION_KINDS[k]);
    const moved = await this.exec(tx).execute(sql`
      WITH cand AS (
        SELECT cn.id
        FROM customer_notifications cn
        JOIN service_reminders r ON r.tenant_id = cn.tenant_id AND r.id = cn.subject_id
        JOIN services s ON s.tenant_id = r.tenant_id AND s.id = r.service_id
        WHERE cn.tenant_id = ${tenantId}
          AND cn.kind = ANY(${sql.param(kinds)}::text[])
          AND cn.state = 'PENDING'
          AND cn.send_started_at IS NULL
          AND ${importedUnmeasuredUsageNotice()}
        ORDER BY cn.created_at, cn.id
        LIMIT ${limit}
        FOR UPDATE OF cn SKIP LOCKED
      )
      UPDATE customer_notifications n
      SET state = 'SUPERSEDED', resolved_at = ${now}, next_attempt_at = NULL, updated_at = ${now}
      FROM cand
      WHERE n.id = cand.id AND n.state = 'PENDING' AND n.send_started_at IS NULL
      RETURNING n.kind, n.customer_id
    `);
    return (moved.rows as unknown as { kind: string; customer_id: string }[]).map((row) => ({
      kind: row.kind,
      customerId: row.customer_id,
    }));
  }

  /** See the port. Keyset by id, `FOR UPDATE OF s SKIP LOCKED`; reads what `seedCandidate` reads. */
  async listUnbaselinedImported(
    scope: TenantContext,
    afterId: string | null,
    limit: number,
    tx: TransactionScope,
  ): Promise<readonly (ServiceReminderCandidate & { readonly usageMeasured: boolean })[]> {
    const tenantId = requireTenantId(scope);
    const result = await this.exec(tx).execute(sql`
      SELECT s.id, s.customer_id, s.provider_username, s.expires_at,
             s.traffic_limit_bytes, s.traffic_used_bytes,
             (s.usage_synced_at IS NOT NULL) AS usage_measured,
             CASE WHEN s.expires_at IS NULL THEN NULL ELSE LEAST(
               date_trunc('day', s.expires_at AT TIME ZONE t.display_timezone)
                 AT TIME ZONE t.display_timezone,
               s.expires_at - make_interval(secs => ${EXPIRY_DAY_MIN_NOTICE_MS / 1000})
             ) END AS expiry_day_starts_at
      FROM services s
      JOIN tenants t ON t.id = s.tenant_id
      WHERE s.tenant_id = ${tenantId}
        AND s.source <> 'NEXA'
        -- Only a service the sweep itself considers: an ended one gets no baseline or rows.
        AND s.state = ANY(${sql.param([...new Set([...EXPIRY_REMINDER_STATES, ...USAGE_REMINDER_STATES])])}::text[])
        ${afterId === null ? sql`` : sql`AND s.id > ${afterId}::uuid`}
        AND NOT EXISTS (
          SELECT 1 FROM service_reminder_baselines b
          WHERE b.tenant_id = s.tenant_id AND b.service_id = s.id
        )
      ORDER BY s.id
      LIMIT ${limit}
      FOR UPDATE OF s SKIP LOCKED
    `);
    return (result.rows as unknown as (CandidateRow & { usage_measured: boolean })[]).map(
      (row) => ({ ...toCandidate(row), usageMeasured: row.usage_measured }),
    );
  }

  /** See the port. One conditional UPDATE over a locked, bounded batch; never a DELETE. */
  async supersedeImportedServiceNotices(
    scope: TenantContext,
    limit: number,
    now: Date,
    tx: TransactionScope,
  ): Promise<readonly { readonly kind: string; readonly customerId: string }[]> {
    const tenantId = requireTenantId(scope);
    const expiryKinds = EXPIRY_REMINDER_KINDS.map((k) => SERVICE_REMINDER_NOTIFICATION_KINDS[k]);
    const usageKinds = USAGE_REMINDER_KINDS.map((k) => SERVICE_REMINDER_NOTIFICATION_KINDS[k]);
    const moved = await this.exec(tx).execute(sql`
      WITH cand AS (
        SELECT cn.id
        FROM customer_notifications cn
        JOIN service_reminders r ON r.tenant_id = cn.tenant_id AND r.id = cn.subject_id
        JOIN services s ON s.tenant_id = r.tenant_id AND s.id = r.service_id
        WHERE cn.tenant_id = ${tenantId}
          AND cn.kind = ANY(${sql.param([...expiryKinds, ...usageKinds])}::text[])
          AND cn.state = 'PENDING'
          AND cn.send_started_at IS NULL
          AND (
            (cn.kind = ANY(${sql.param(expiryKinds)}::text[]) AND ${importedServiceNoticeRefused('EXPIRY')})
            OR (cn.kind = ANY(${sql.param(usageKinds)}::text[]) AND ${importedServiceNoticeRefused('USAGE')})
          )
        ORDER BY cn.created_at, cn.id
        LIMIT ${limit}
        FOR UPDATE OF cn SKIP LOCKED
      )
      UPDATE customer_notifications n
      SET state = 'SUPERSEDED', resolved_at = ${now}, next_attempt_at = NULL, updated_at = ${now}
      FROM cand
      WHERE n.id = cand.id AND n.state = 'PENDING' AND n.send_started_at IS NULL
      RETURNING n.kind, n.customer_id
    `);
    return (moved.rows as unknown as { kind: string; customer_id: string }[]).map((row) => ({
      kind: row.kind,
      customerId: row.customer_id,
    }));
  }
}

/**
 * Reads back one frozen reminder, for the dispatcher.
 *
 * A separate class from the sweep's repository although both touch one table, because
 * they are used by different processes for opposite purposes: the sweep writes
 * occurrences inside a business transaction, and this reads one outside every
 * transaction, moments before a network call. One object holding both would let a
 * future edit enqueue a reminder from inside the send loop.
 */
export class DrizzleServiceReminderSnapshotReader implements ServiceReminderSnapshotReader {
  constructor(private readonly db: Database) {}

  async snapshotOf(
    scope: TenantContext,
    reminderId: string,
  ): Promise<
    | (ServiceReminderSnapshot & {
        readonly basisExpiresAt: Date | null;
        readonly basisTrafficLimitBytes: bigint;
        /** R12 F3 item 1: the service the reminder is about, for the button under it. */
        readonly serviceId?: string;
      })
    | null
  > {
    const tenantId = requireTenantId(scope);
    const [row] = await this.db
      .select({
        serviceId: serviceReminders.serviceId,
        serviceLabel: serviceReminders.snapshotServiceLabel,
        remainingDays: serviceReminders.snapshotRemainingDays,
        usedBytes: serviceReminders.snapshotUsedBytes,
        basisExpiresAt: serviceReminders.basisExpiresAt,
        basisTrafficLimitBytes: serviceReminders.basisTrafficLimitBytes,
      })
      .from(serviceReminders)
      .where(and(eq(serviceReminders.tenantId, tenantId), eq(serviceReminders.id, reminderId)))
      .limit(1);
    return row ?? null;
  }
}
