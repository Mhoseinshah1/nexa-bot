import { sql, type SQL } from 'drizzle-orm';
import {
  GATEWAY_HEALTH_OPERATIONAL_CODES,
  type GatewayHealthOperationalCode,
  type GatewayInvoiceCreationState,
  type OperationalSeverity,
  type PaymentGatewayProvider,
  type TenantContext,
  type TimePeriod,
} from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { requireTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';
import { payments } from '../../../../infrastructure/persistence/schema.js';
import type {
  GatewayHealthReader,
  GatewayRecordedFacts,
} from '../application/gateway-health.service.js';
import {
  RECONCILE_CONFIRM_ACTION,
  RECONCILE_FAIL_ACTION,
  RECONCILE_INQUIRY_ACTION,
} from '../application/payment.service.js';
import { paymentOpsQueueCondition } from './payment-ops-queue-sql.js';

/**
 * Gateway Health's recorded facts, in PostgreSQL (program §11). Reads only.
 *
 * Five statements, each grouped by route and each tenant-scoped:
 *
 * - the gateway invoices' latest answers — every attempt keeps its LATEST inquiry, so a
 *   "last success" is the latest success still on record, not a log of every call;
 * - the attempts in the window and how many record a provider error — the Payment
 *   Operations Center's own `PROVIDER_ERROR` predicate, never a second definition;
 * - the call budget row (calls used since its current window opened);
 * - the open operational conditions with a gateway-health code, by the code index;
 * - the last reconcile / "ask again" audit row naming the route.
 */
export class DrizzleGatewayHealthReader implements GatewayHealthReader {
  constructor(private readonly db: Database) {}

  async facts(
    scope: TenantContext,
    window: TimePeriod | null,
  ): Promise<ReadonlyMap<PaymentGatewayProvider, GatewayRecordedFacts>> {
    const tenantId = requireTenantId(scope);
    const found = new Map<PaymentGatewayProvider, Mutable>();
    const of = (provider: string): Mutable => {
      let facts = found.get(provider as PaymentGatewayProvider);
      if (facts === undefined) {
        facts = empty();
        found.set(provider as PaymentGatewayProvider, facts);
      }
      return facts;
    };
    const rows = async <T>(query: SQL): Promise<T[]> => (await this.db.execute(query)).rows as T[];

    for (const row of await rows<{
      provider: string;
      last_created: string | null;
      last_answered: string | null;
    }>(sql`
      SELECT provider,
             max(created_invoice_at) AS last_created,
             max(last_inquiry_at) FILTER (WHERE last_inquiry_error_code IS NULL
                                            AND provider_status IS NOT NULL) AS last_answered
        FROM gateway_invoices
       WHERE tenant_id = ${tenantId}
       GROUP BY provider`)) {
      const facts = of(row.provider);
      facts.lastInvoiceCreatedAt = date(row.last_created);
      facts.lastInquiryAnsweredAt = date(row.last_answered);
    }

    for (const row of await rows<{ provider: string; at: string; code: string }>(sql`
      SELECT DISTINCT ON (provider) provider, last_inquiry_at AS at,
             last_inquiry_error_code AS code
        FROM gateway_invoices
       WHERE tenant_id = ${tenantId}
         AND last_inquiry_error_code IS NOT NULL AND last_inquiry_at IS NOT NULL
       ORDER BY provider, last_inquiry_at DESC, payment_id DESC`)) {
      of(row.provider).lastInquiryFailure = { at: new Date(row.at), code: row.code };
    }

    for (const row of await rows<{
      provider: string;
      at: string;
      state: string;
      code: string | null;
    }>(sql`
      SELECT DISTINCT ON (provider) provider, COALESCE(creation_sent_at, created_at) AS at,
             creation_state AS state, creation_error_code AS code
        FROM gateway_invoices
       WHERE tenant_id = ${tenantId}
         AND creation_state IN ('CREATE_FAILED', 'CREATE_UNKNOWN')
       ORDER BY provider, COALESCE(creation_sent_at, created_at) DESC, payment_id DESC`)) {
      of(row.provider).lastCreateFailure = {
        at: new Date(row.at),
        state: row.state as GatewayInvoiceCreationState,
        code: row.code,
      };
    }

    const inWindow =
      window === null
        ? sql`true`
        : sql`${payments.createdAt} >= ${window.start.toISOString()}::timestamptz
              AND ${payments.createdAt} < ${window.end.toISOString()}::timestamptz`;
    for (const row of await rows<{ provider: string; attempts: number; errored: number }>(sql`
      SELECT ${payments.gatewayProvider} AS provider,
             count(*)::int AS attempts,
             (count(*) FILTER (WHERE ${paymentOpsQueueCondition('PROVIDER_ERROR')}))::int AS errored
        FROM ${payments}
       WHERE ${payments.tenantId} = ${tenantId}
         AND ${payments.method} = 'GATEWAY'
         AND ${payments.gatewayProvider} IS NOT NULL
         AND ${inWindow}
       GROUP BY ${payments.gatewayProvider}`)) {
      const facts = of(row.provider);
      facts.attemptsInWindow = Number(row.attempts);
      facts.attemptsWithProviderError = Number(row.errored);
    }

    for (const row of await rows<{ provider: string; started: string; used: number }>(sql`
      SELECT provider, window_started_at AS started, used
        FROM payment_gateway_call_budgets
       WHERE tenant_id = ${tenantId}`)) {
      of(row.provider).callBudget = {
        windowStartedAt: new Date(row.started),
        used: Number(row.used),
      };
    }

    const codes = sql.join(
      GATEWAY_HEALTH_OPERATIONAL_CODES.map((code) => sql`${code}`),
      sql`, `,
    );
    for (const row of await rows<{
      provider: string;
      code: string;
      severity: string;
      count: number;
      since: string;
    }>(sql`
      SELECT context ->> 'provider' AS provider, code,
             (array_agg(severity ORDER BY last_seen_at DESC))[1] AS severity,
             count(*)::int AS count, min(first_seen_at) AS since
        FROM operational_events
       WHERE code IN (${codes})
         AND tenant_id = ${tenantId}
         AND resolved_at IS NULL
         AND context ->> 'provider' IS NOT NULL
       GROUP BY context ->> 'provider', code
       ORDER BY code`)) {
      of(row.provider).openConditions.push({
        code: row.code as GatewayHealthOperationalCode,
        severity: row.severity as OperationalSeverity,
        count: Number(row.count),
        since: new Date(row.since),
      });
    }

    for (const row of await rows<{ provider: string; at: string; action: string }>(sql`
      SELECT DISTINCT ON (after ->> 'gatewayProvider') after ->> 'gatewayProvider' AS provider,
             occurred_at AS at, action
        FROM audit_logs
       WHERE tenant_id = ${tenantId}
         AND action IN (${RECONCILE_CONFIRM_ACTION}, ${RECONCILE_FAIL_ACTION}, ${RECONCILE_INQUIRY_ACTION})
         AND result = 'SUCCESS'
         AND after ->> 'gatewayProvider' IS NOT NULL
         -- An "ask again" inside the minute's spacing records nothing (requested = false).
         AND (action <> ${RECONCILE_INQUIRY_ACTION} OR after ->> 'requested' = 'true')
       ORDER BY after ->> 'gatewayProvider', occurred_at DESC, id DESC`)) {
      of(row.provider).lastReconciliation = { at: new Date(row.at), action: row.action };
    }

    return found;
  }
}

type Mutable = {
  -readonly [K in keyof GatewayRecordedFacts]: K extends 'openConditions'
    ? GatewayRecordedFacts['openConditions'][number][]
    : GatewayRecordedFacts[K];
};

function empty(): Mutable {
  return {
    lastInvoiceCreatedAt: null,
    lastInquiryAnsweredAt: null,
    lastInquiryFailure: null,
    lastCreateFailure: null,
    attemptsInWindow: 0,
    attemptsWithProviderError: 0,
    callBudget: null,
    openConditions: [],
    lastReconciliation: null,
  };
}

function date(value: string | Date | null): Date | null {
  return value === null ? null : new Date(value);
}
