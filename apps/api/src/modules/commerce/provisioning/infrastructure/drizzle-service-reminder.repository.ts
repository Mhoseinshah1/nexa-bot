import { sql } from 'drizzle-orm';
import {
  EXPIRY_REMINDER_STATES,
  USAGE_REMINDER_STATES,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  ServiceReminderCandidate,
  ServiceReminderRaise,
  ServiceReminderRepository,
} from '../application/service-reminder.ports.js';

/** What both candidate queries select, in the order they select it. */
interface CandidateRow {
  readonly id: string;
  readonly customer_id: string;
  readonly provider_username: string;
  readonly expires_at: string | null;
  readonly traffic_limit_bytes: string;
  readonly traffic_used_bytes: string;
}

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
    /*
     * `BigInt('123')` is exact; `Number('123')` is exact until it is not, and the
     * comparison this feeds is `used * 100 >= limit * percent`, where a rounded operand
     * is a customer told at the wrong moment or not at all. The same rule money follows,
     * for the same reason.
     */
    trafficLimitBytes: limit,
    trafficUsedBytes: BigInt(row.traffic_used_bytes),
    basis: { expiresAt: row.expires_at, trafficLimitBytes: limit },
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
   * Services whose deadline is inside three days and whose DUE reminder is unraised.
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
    bounds: { readonly now: Date; readonly secondAt: Date; readonly firstAt: Date },
    limit: number,
    tx: TransactionScope,
  ): Promise<readonly ServiceReminderCandidate[]> {
    const tenantId = requireTenantId(scope);
    const result = await this.exec(tx).execute(sql`
      SELECT s.id, s.customer_id, s.provider_username, s.expires_at,
             s.traffic_limit_bytes, s.traffic_used_bytes
      FROM services s
      WHERE s.tenant_id = ${tenantId}
        AND s.state = ANY(${sql.param([...EXPIRY_REMINDER_STATES])}::text[])
        AND s.expires_at IS NOT NULL
        AND s.expires_at <= ${bounds.firstAt}
        AND NOT EXISTS (
          SELECT 1 FROM service_reminders r
          WHERE r.tenant_id = s.tenant_id
            AND r.service_id = s.id
            AND r.kind = CASE
              WHEN s.expires_at <= ${bounds.now} THEN 'EXPIRED'
              WHEN s.expires_at <= ${bounds.secondAt} THEN 'EXPIRY_SECOND'
              ELSE 'EXPIRY_FIRST'
            END
            AND r.basis_expires_at IS NOT DISTINCT FROM s.expires_at
        )
      ORDER BY s.expires_at ASC, s.id ASC
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
             s.traffic_limit_bytes, s.traffic_used_bytes
      FROM services s
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
}
