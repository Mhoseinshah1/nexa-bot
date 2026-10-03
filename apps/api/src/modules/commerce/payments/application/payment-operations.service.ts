import {
  PAYMENT_OPS_QUEUES,
  type ActorContext,
  type PaymentGatewayProvider,
  type PaymentOpsQueueCounts,
  type ReportRange,
  type TenantContext,
  type TimePeriod,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import {
  PAYMENT_VIEW_PERMISSION,
  type PaymentListQuery,
  type PaymentService,
} from './payment.service.js';
import type { PaymentPage } from './ports.js';

/**
 * The Payment Operations Center (program §10, `docs/payment-operations-center.md`).
 *
 * READS ONLY. The workspace's actions are the commands that already exist —
 * `PaymentService.reinquireGatewayPayment` and `reconcileGatewayPayment` under
 * `payments.reconcile`, `RefundService` under `refunds.issue` — called by the surface
 * directly. Nothing here moves money, writes a state or decides an outcome, and there is no
 * "force paid": a payment is CONFIRMED only by the settlement path, from evidence.
 */

/** One gateway route's queue counts. `gatewayProvider` null: offered through no route. */
export interface PaymentAttentionRow {
  readonly gatewayProvider: PaymentGatewayProvider | null;
  readonly counts: PaymentOpsQueueCounts;
}

/**
 * "Operational attention" — the shared read model (program §10–§12).
 *
 * How many payments sit in each Payment Operations Center queue, per gateway route, among
 * the payments created inside `window` (half-open; null = no bound). Each count is the
 * SAME predicate the queue list filters by (`infrastructure/payment-ops-queue-sql.ts`), so
 * a figure here and the list it opens agree by construction.
 *
 * A port with no permission of its own: a caller that is not an operator's request — a
 * Gateway Health probe, a Notification Center sweep acting as `SYSTEM_JOB` — reads it
 * directly under its own authority; an operator reads it through
 * `PaymentOperationsService.attention`, which charges `payments.view`. Rows whose counts are
 * all zero are omitted. Tenant-scoped; never crosses tenants.
 */
export interface PaymentAttentionReader {
  counts(scope: TenantContext, window: TimePeriod | null): Promise<readonly PaymentAttentionRow[]>;
}

/**
 * The reports' range vocabulary, resolved in the tenant's timezone and calendar by the
 * reports' own resolver (wired in the container) — never a date range computed here.
 */
export interface PaymentOpsWindowResolver {
  resolve(
    scope: TenantContext,
    input: { readonly range: ReportRange; readonly from?: string; readonly to?: string },
  ): Promise<TimePeriod>;
}

export interface PaymentOpsWindowInput {
  readonly range?: ReportRange | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

export interface PaymentOperationsServiceDeps {
  readonly guard: PermissionGuard;
  readonly attention: PaymentAttentionReader;
  readonly windows: PaymentOpsWindowResolver;
  readonly payments: PaymentService;
}

export interface PaymentAttentionView {
  readonly window: TimePeriod | null;
  readonly byGateway: readonly PaymentAttentionRow[];
  readonly totals: PaymentOpsQueueCounts;
}

export function zeroCounts(): Record<(typeof PAYMENT_OPS_QUEUES)[number], number> {
  return Object.fromEntries(PAYMENT_OPS_QUEUES.map((queue) => [queue, 0])) as Record<
    (typeof PAYMENT_OPS_QUEUES)[number],
    number
  >;
}

export class PaymentOperationsService {
  constructor(private readonly deps: PaymentOperationsServiceDeps) {}

  /** The created-at window an input names, or null for none. Charged nothing: it reads no data. */
  async windowFor(scope: TenantContext, input: PaymentOpsWindowInput): Promise<TimePeriod | null> {
    if (input.range === undefined) return null;
    return this.deps.windows.resolve(scope, {
      range: input.range,
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to }),
    });
  }

  /**
   * A queue page: the ordinary payment list with the queue, route and window facets. Same
   * permission, same keyset order (created_at, id), same search — one list, not a second.
   */
  async list(
    scope: TenantContext,
    actor: ActorContext,
    query: PaymentListQuery,
    window: PaymentOpsWindowInput,
  ): Promise<PaymentPage> {
    // Authority FIRST, before the window resolves anything about the tenant's calendar.
    await this.deps.guard.check(scope, actor, PAYMENT_VIEW_PERMISSION);
    const createdIn = await this.windowFor(scope, window);
    return this.deps.payments.list(scope, actor, {
      ...query,
      search: { ...query.search, ...(createdIn === null ? {} : { createdIn }) },
    });
  }

  /** The attention counts for an operator, under `payments.view`. */
  async attention(
    scope: TenantContext,
    actor: ActorContext,
    input: PaymentOpsWindowInput,
  ): Promise<PaymentAttentionView> {
    await this.deps.guard.check(scope, actor, PAYMENT_VIEW_PERMISSION);
    const window = await this.windowFor(scope, input);
    const byGateway = await this.deps.attention.counts(scope, window);
    const totals = zeroCounts();
    for (const row of byGateway) {
      for (const queue of PAYMENT_OPS_QUEUES) totals[queue] += row.counts[queue];
    }
    return { window, byGateway, totals };
  }
}
