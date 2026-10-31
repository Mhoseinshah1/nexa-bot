import { sql } from 'drizzle-orm';
import {
  money,
  OPERATION_TERMINAL_STATES,
  type AutoRenewPreferenceSource,
  type AutoRenewRefusal,
  type AutoRenewRunState,
  type CurrencyCode,
  type Money,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  AutoRenewCandidate,
  AutoRenewCursor,
  AutoRenewNoticeFacts,
  AutoRenewPreference,
  AutoRenewRepository,
  AutoRenewRun,
} from '../application/service-auto-renew.ports.js';

type Row = Record<string, unknown>;

function moneyOf(amount: unknown, currency: unknown): Money | null {
  if (amount === null || amount === undefined || currency === null || currency === undefined) {
    return null;
  }
  return money(BigInt(String(amount)), String(currency) as CurrencyCode);
}

function requiredMoney(amount: unknown, currency: unknown): Money {
  const value = moneyOf(amount, currency);
  if (value === null) throw new Error('auto-renew row carries no amount where one is required');
  return value;
}

function dateOf(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

const RUN_COLUMNS = sql`id, service_id, customer_id, attempt, state, consented_total_minor,
  consented_currency, quoted_total_minor, quoted_currency, service_label, basis_expires_at`;

function runOf(row: Row): AutoRenewRun {
  return {
    id: String(row['id']),
    serviceId: String(row['service_id']),
    customerId: String(row['customer_id']) as UserId,
    attempt: Number(row['attempt']),
    state: String(row['state']) as AutoRenewRunState,
    consented: requiredMoney(row['consented_total_minor'], row['consented_currency']),
    quoted: moneyOf(row['quoted_total_minor'], row['quoted_currency']),
    serviceLabel: String(row['service_label']),
    basisExpiresAt: dateOf(row['basis_expires_at']),
  };
}

const TERMINAL_OPERATION_STATES = sql.raw(
  `(${OPERATION_TERMINAL_STATES.map((state) => `'${state}'`).join(', ')})`,
);

/**
 * Round 10, D1: the automatic-renewal lane's storage — the customer's consent per service and
 * one run row per (service, period). Every state change is a conditional UPDATE naming its
 * `from` state and the attempt the caller holds, so a pass can never move a run another pass
 * has moved since.
 */
export class DrizzleServiceAutoRenewRepository implements AutoRenewRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  private async rows(tx: unknown, query: ReturnType<typeof sql>): Promise<Row[]> {
    const result = await this.exec(tx).execute(query);
    return result.rows as Row[];
  }

  async preferenceOf(
    scope: TenantContext,
    serviceId: string,
    tx?: unknown,
  ): Promise<AutoRenewPreference | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.rows(
      tx,
      sql`SELECT service_id, customer_id, enabled, consented_total_minor, consented_currency,
                 source, updated_at
            FROM service_auto_renew_preferences
           WHERE tenant_id = ${tenantId} AND service_id = ${serviceId}`,
    );
    if (row === undefined) return null;
    return {
      serviceId: String(row['service_id']),
      customerId: String(row['customer_id']) as UserId,
      enabled: row['enabled'] === true,
      consented: moneyOf(row['consented_total_minor'], row['consented_currency']),
      source: String(row['source']) as AutoRenewPreferenceSource,
      updatedAt: dateOf(row['updated_at']),
    };
  }

  async savePreference(
    scope: TenantContext,
    input: {
      readonly serviceId: string;
      readonly customerId: UserId;
      readonly enabled: boolean;
      readonly consented: Money | null;
      readonly source: AutoRenewPreferenceSource;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const amount = input.enabled ? (input.consented?.amountMinor ?? null) : null;
    const currency = input.enabled ? (input.consented?.currency ?? null) : null;
    /*
     * The write happens only when something CHANGES: the owner, the switch or the total. A
     * repeated tap is no write, so `changed` (and the event that follows it) is honest.
     */
    const rows = await this.rows(
      tx,
      sql`INSERT INTO service_auto_renew_preferences
            (tenant_id, service_id, customer_id, enabled, consented_total_minor,
             consented_currency, source, created_at, updated_at)
          VALUES (${tenantId}, ${input.serviceId}, ${input.customerId}, ${input.enabled},
                  ${amount}, ${currency}, ${input.source}, ${input.now}, ${input.now})
          ON CONFLICT (tenant_id, service_id) DO UPDATE
             SET customer_id = EXCLUDED.customer_id,
                 enabled = EXCLUDED.enabled,
                 consented_total_minor = EXCLUDED.consented_total_minor,
                 consented_currency = EXCLUDED.consented_currency,
                 source = EXCLUDED.source,
                 updated_at = EXCLUDED.updated_at
           WHERE service_auto_renew_preferences.customer_id IS DISTINCT FROM EXCLUDED.customer_id
              OR service_auto_renew_preferences.enabled IS DISTINCT FROM EXCLUDED.enabled
              OR service_auto_renew_preferences.consented_total_minor
                   IS DISTINCT FROM EXCLUDED.consented_total_minor
              OR service_auto_renew_preferences.consented_currency
                   IS DISTINCT FROM EXCLUDED.consented_currency
          RETURNING service_id`,
    );
    return rows.length === 1;
  }

  async listDue(
    scope: TenantContext,
    bounds: {
      readonly now: Date;
      readonly dueBefore: Date;
      readonly after?: AutoRenewCursor | null;
    },
    limit: number,
    tx: TransactionScope,
  ): Promise<readonly AutoRenewCandidate[]> {
    const tenantId = requireTenantId(scope);
    /*
     * Keyset pagination on the ORDER BY below (Codex review of PR 338). The deadline goes out
     * and comes back as PostgreSQL's own text — never through a JavaScript `Date`, which would
     * drop the microseconds, and a cursor truncated below the last row's deadline would hand
     * the same page back for ever. Every page is read in the one claiming transaction, so one
     * session renders and parses the text.
     */
    const after =
      bounds.after === undefined || bounds.after === null
        ? sql`TRUE`
        : sql`(s.expires_at, s.id) > (${bounds.after.expiresAt}::timestamptz, ${bounds.after.serviceId}::uuid)`;
    const rows = await this.rows(
      tx,
      sql`SELECT s.id AS service_id, s.customer_id, s.provider_username,
                 s.expires_at::text AS cursor_expires_at,
                 p.consented_total_minor, p.consented_currency,
                 r.id AS run_id, r.state AS run_state, r.attempt AS run_attempt,
                 r.quoted_total_minor, r.quoted_currency
            FROM service_auto_renew_preferences p
            JOIN services s
              ON s.tenant_id = p.tenant_id AND s.id = p.service_id
             -- The consent is the OWNER's: a service that changed hands is never renewed on
             -- the strength of somebody else's consent.
             AND s.customer_id = p.customer_id
            LEFT JOIN service_auto_renew_runs r
              ON r.tenant_id = s.tenant_id AND r.service_id = s.id
             AND r.basis_expires_at = s.expires_at
           WHERE p.tenant_id = ${tenantId}
             AND p.enabled
             AND s.state = 'ACTIVE'
             -- An imported service renews from a panel plan the customer chooses (OQ-R10-D1-01).
             AND s.source <> 'MIRZA'
             AND s.product_id IS NOT NULL
             AND s.expires_at IS NOT NULL
             AND s.expires_at > ${bounds.now}
             AND s.expires_at <= ${bounds.dueBefore}
             AND (r.id IS NULL
                  OR r.state = 'FUNDS_SHORT'
                  OR (r.state = 'CLAIMED' AND (r.lease_until IS NULL OR r.lease_until <= ${bounds.now})))
             -- A renewal the customer is paying for by hand is theirs to finish. This lane's
             -- OWN unpaid order (the worker's surface, this owner's) is not: a pass that stopped
             -- after confirming it is taken over, and the takeover withdraws it before anything
             -- else (Codex review of PR 338) — no customer ever placed a SCHEDULER order.
             AND NOT EXISTS (
               SELECT 1 FROM service_commercial_actions c
                 JOIN orders o ON o.tenant_id = c.tenant_id AND o.id = c.order_id
                WHERE c.tenant_id = s.tenant_id AND c.service_id = s.id
                  AND o.state = 'AWAITING_PAYMENT'
                  AND NOT (o.source_surface IS NOT DISTINCT FROM 'SCHEDULER'
                           AND o.customer_id = s.customer_id))
             -- A change still being applied (a paid renewal not yet on the panel among them)
             -- has not moved the deadline yet; renewing on top of it would buy a second period.
             AND NOT EXISTS (
               SELECT 1 FROM provisioning_operations op
                WHERE op.tenant_id = s.tenant_id AND op.service_id = s.id
                  AND op.state NOT IN ${TERMINAL_OPERATION_STATES}
                  AND (op.type <> 'SYNC_USAGE' OR op.requested_by_customer_id IS NOT NULL))
             AND ${after}
           ORDER BY s.expires_at, s.id
           LIMIT ${limit}`,
    );
    return rows.map((row) => ({
      cursor: { expiresAt: String(row['cursor_expires_at']), serviceId: String(row['service_id']) },
      serviceId: String(row['service_id']),
      customerId: String(row['customer_id']) as UserId,
      serviceLabel: String(row['provider_username']),
      consented: requiredMoney(row['consented_total_minor'], row['consented_currency']),
      run:
        row['run_id'] === null || row['run_id'] === undefined
          ? null
          : {
              id: String(row['run_id']),
              state: String(row['run_state']) as 'CLAIMED' | 'FUNDS_SHORT',
              attempt: Number(row['run_attempt']),
              quoted: moneyOf(row['quoted_total_minor'], row['quoted_currency']),
            },
    }));
  }

  async claimNew(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly serviceId: string;
      readonly customerId: UserId;
      readonly serviceLabel: string;
      readonly consented: Money;
      readonly now: Date;
      readonly dueBefore: Date;
      readonly leaseUntil: Date;
    },
    tx: TransactionScope,
  ): Promise<AutoRenewRun | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.rows(
      tx,
      sql`INSERT INTO service_auto_renew_runs
            (id, tenant_id, service_id, customer_id, basis_expires_at, attempt, state,
             service_label, consented_total_minor, consented_currency, lease_until,
             created_at, updated_at)
          SELECT ${input.id}::uuid, s.tenant_id, s.id, s.customer_id, s.expires_at, 1, 'CLAIMED',
                 ${input.serviceLabel}::text, ${input.consented.amountMinor}::bigint,
                 ${input.consented.currency}::text, ${input.leaseUntil}::timestamptz,
                 ${input.now}::timestamptz, ${input.now}::timestamptz
            FROM services s
           WHERE s.tenant_id = ${tenantId} AND s.id = ${input.serviceId}
             AND s.customer_id = ${input.customerId}
             AND s.expires_at > ${input.now} AND s.expires_at <= ${input.dueBefore}
          ON CONFLICT ON CONSTRAINT service_auto_renew_runs_period_key DO NOTHING
          RETURNING ${RUN_COLUMNS}`,
    );
    return row === undefined ? null : runOf(row);
  }

  async reclaim(
    scope: TenantContext,
    input: {
      readonly runId: string;
      readonly from: 'CLAIMED' | 'FUNDS_SHORT';
      readonly attempt: number;
      readonly consented: Money;
      readonly now: Date;
      readonly leaseUntil: Date;
    },
    tx: TransactionScope,
  ): Promise<AutoRenewRun | null> {
    const tenantId = requireTenantId(scope);
    /*
     * Every takeover is the NEXT attempt, with keys of its own. A short wallet's first attempt
     * debited nothing; a lapsed claim's attempt debited nothing either unless its settlement
     * committed — and a committed settlement marked the run RENEWED in the same transaction,
     * so it is never taken over. A slow pass still holding the old attempt finds its claim gone
     * at `markRenewed` (conditional on the attempt) and its debit rolls back.
     */
    const nextAttempt = input.attempt + 1;
    const [row] = await this.rows(
      tx,
      sql`UPDATE service_auto_renew_runs
             SET state = 'CLAIMED', attempt = ${nextAttempt}, lease_until = ${input.leaseUntil},
                 consented_total_minor = ${input.consented.amountMinor},
                 consented_currency = ${input.consented.currency},
                 updated_at = ${input.now}
           WHERE tenant_id = ${tenantId} AND id = ${input.runId}
             AND state = ${input.from} AND attempt = ${input.attempt}
             AND (${input.from}::text <> 'CLAIMED' OR lease_until IS NULL
                  OR lease_until <= ${input.now}::timestamptz)
          RETURNING ${RUN_COLUMNS}`,
    );
    return row === undefined ? null : runOf(row);
  }

  async periodCurrent(scope: TenantContext, runId: string, tx: TransactionScope): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    /*
     * Compared in SQL, column to column: `basis_expires_at` was copied from
     * `services.expires_at` in SQL at the claim, so an unchanged deadline is EQUAL to the
     * microsecond, and any renewal applied since — a manual one among them — is not.
     */
    /*
     * R12 F1 item 4: and the SERVICE is still the one claimed — ACTIVE, and still the run's
     * owner's — read with the service row LOCKED (`FOR UPDATE OF s`), in the settling
     * transaction. The settlement's own check (`prepareCommercialAction`) runs under the
     * lifecycle advisory lock, which a provisioner's TERMINATE or SUSPEND does not take: a
     * state change committed between that read and this one is seen here, and one that has
     * not committed yet waits behind this lock and then finds the renewal already decided.
     */
    const rows = await this.rows(
      tx,
      sql`SELECT 1 FROM service_auto_renew_runs r
            JOIN services s ON s.tenant_id = r.tenant_id AND s.id = r.service_id
           WHERE r.tenant_id = ${tenantId} AND r.id = ${runId}
             AND s.expires_at = r.basis_expires_at
             AND s.state = 'ACTIVE'
             AND s.customer_id = r.customer_id
           FOR UPDATE OF s`,
    );
    return rows.length === 1;
  }

  async unpaidLaneOrders(
    scope: TenantContext,
    input: { readonly serviceId: string; readonly customerId: UserId },
    tx?: unknown,
  ): Promise<readonly string[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.rows(
      tx,
      sql`SELECT o.id FROM service_commercial_actions c
            JOIN orders o ON o.tenant_id = c.tenant_id AND o.id = c.order_id
           WHERE c.tenant_id = ${tenantId} AND c.service_id = ${input.serviceId}
             AND o.customer_id = ${input.customerId}
             AND o.state = 'AWAITING_PAYMENT' AND o.source_surface = 'SCHEDULER'
           ORDER BY o.id`,
    );
    return rows.map((row) => String(row['id']));
  }

  async markRenewed(
    scope: TenantContext,
    input: {
      readonly runId: string;
      readonly attempt: number;
      readonly orderId: string;
      readonly quoted: Money;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.rows(
      tx,
      sql`UPDATE service_auto_renew_runs
             SET state = 'RENEWED', order_id = ${input.orderId}, lease_until = NULL,
                 quoted_total_minor = ${input.quoted.amountMinor},
                 quoted_currency = ${input.quoted.currency}, updated_at = ${input.now}
           WHERE tenant_id = ${tenantId} AND id = ${input.runId}
             AND state = 'CLAIMED' AND attempt = ${input.attempt}
          RETURNING id`,
    );
    return rows.length === 1;
  }

  async markUnrenewed(
    scope: TenantContext,
    input: {
      readonly runId: string;
      readonly attempt: number;
      readonly to: 'FUNDS_SHORT' | 'REFUSED';
      readonly refusal: AutoRenewRefusal | null;
      readonly quoted: Money | null;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.rows(
      tx,
      sql`UPDATE service_auto_renew_runs
             SET state = ${input.to}, refusal = ${input.refusal}, lease_until = NULL,
                 quoted_total_minor = COALESCE(${input.quoted?.amountMinor ?? null}::bigint,
                                               quoted_total_minor),
                 quoted_currency = COALESCE(${input.quoted?.currency ?? null}::text,
                                            quoted_currency),
                 updated_at = ${input.now}
           WHERE tenant_id = ${tenantId} AND id = ${input.runId}
             AND state = 'CLAIMED' AND attempt = ${input.attempt}
          RETURNING id`,
    );
    return rows.length === 1;
  }

  async markNotified(
    scope: TenantContext,
    runId: string,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.rows(
      tx,
      sql`UPDATE service_auto_renew_runs SET notified_at = ${now}
           WHERE tenant_id = ${tenantId} AND id = ${runId} AND notified_at IS NULL
          RETURNING id`,
    );
    return rows.length === 1;
  }

  async noticeFacts(scope: TenantContext, runId: string): Promise<AutoRenewNoticeFacts | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.rows(
      undefined,
      sql`SELECT ${RUN_COLUMNS}, refusal
            FROM service_auto_renew_runs
           WHERE tenant_id = ${tenantId} AND id = ${runId}`,
    );
    if (row === undefined) return null;
    const run = runOf(row);
    return {
      runId: run.id,
      serviceId: run.serviceId,
      serviceLabel: run.serviceLabel,
      state: run.state,
      refusal: row['refusal'] === null ? null : (String(row['refusal']) as AutoRenewRefusal),
      consented: run.consented,
      quoted: run.quoted,
      basisExpiresAt: run.basisExpiresAt,
    };
  }

  async renewedOrder(scope: TenantContext, orderId: string, tx?: unknown): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.rows(
      tx,
      sql`SELECT 1 FROM service_auto_renew_runs
           WHERE tenant_id = ${tenantId} AND order_id = ${orderId} AND state = 'RENEWED'
           LIMIT 1`,
    );
    return rows.length > 0;
  }
}
