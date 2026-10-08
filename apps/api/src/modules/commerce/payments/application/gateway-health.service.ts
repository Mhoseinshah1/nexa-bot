import {
  GATEWAY_HEALTH_CATEGORY,
  type ActorContext,
  type Clock,
  type GatewayConfigurationGap,
  type GatewayHealthOperationalCode,
  type GatewayHealthSection,
  type GatewayHealthSignal,
  type GatewayHealthState,
  type GatewayInvoiceCreationState,
  type OperationalSeverity,
  type PaymentGatewayProvider,
  type PaymentGatewayStatus,
  type PaymentOpsQueueCounts,
  type TenantContext,
  type TimePeriod,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import {
  PAYMENT_GATEWAY_VIEW_PERMISSION,
  configurationGaps,
  type GatewayReadinessFacts,
} from './payment-gateway.service.js';
import type { PaymentGatewayRecord } from './gateway-ports.js';
import { PAYMENT_VIEW_PERMISSION } from './payment.service.js';
import type {
  PaymentAttentionReader,
  PaymentOpsWindowInput,
  PaymentOperationsService,
} from './payment-operations.service.js';

/**
 * Gateway Health (program §11, `docs/gateway-health.md`). READ-ONLY.
 *
 * Every figure is a fact some flow already recorded — the route row, the credential store's
 * set-at times and last check, the gateway invoices, the call budget, the operational
 * conditions, the audit log and the Payment Operations Center's queues. Nothing here calls a
 * provider (the operator's credential check is `PaymentGatewayService.checkCredential`,
 * unchanged), nothing writes, and nothing is estimated: no availability percentage, no
 * latency (a create's elapsed time is logged, never stored), and a route with no record says
 * so rather than reading as healthy.
 */

/** What the record holds about one route, beyond the route row and its readiness. */
export interface GatewayRecordedFacts {
  readonly lastInvoiceCreatedAt: Date | null;
  readonly lastInquiryAnsweredAt: Date | null;
  readonly lastInquiryFailure: { readonly at: Date; readonly code: string } | null;
  readonly lastCreateFailure: {
    readonly at: Date;
    readonly state: GatewayInvoiceCreationState;
    readonly code: string | null;
  } | null;
  readonly attemptsInWindow: number;
  readonly attemptsWithProviderError: number;
  readonly callBudget: { readonly windowStartedAt: Date; readonly used: number } | null;
  readonly openConditions: readonly {
    readonly code: GatewayHealthOperationalCode;
    readonly severity: OperationalSeverity;
    readonly count: number;
    readonly since: Date;
  }[];
  readonly lastReconciliation: { readonly at: Date; readonly action: string } | null;
}

/**
 * The recorded facts per route, tenant-scoped. `window` bounds the attempt counts (payments
 * created in `[start, end)`; null = no bound); every "last" is the latest the record holds.
 */
export interface GatewayHealthReader {
  facts(
    scope: TenantContext,
    window: TimePeriod | null,
  ): Promise<ReadonlyMap<PaymentGatewayProvider, GatewayRecordedFacts>>;
}

/** The routes and their readiness, from the route service — the same reads it enables by. */
export interface GatewayRouteSource {
  routes(scope: TenantContext): Promise<readonly PaymentGatewayRecord[]>;
  readinessFacts(
    scope: TenantContext,
    gateway: PaymentGatewayRecord,
  ): Promise<GatewayReadinessFacts>;
  checkSupported(provider: PaymentGatewayProvider): boolean;
  lastCheck(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
  ): Promise<{ readonly at: Date; readonly result: string } | null>;
}

export interface GatewayHealthServiceDeps {
  readonly guard: PermissionGuard;
  readonly routes: GatewayRouteSource;
  readonly reader: GatewayHealthReader;
  readonly attention: PaymentAttentionReader;
  readonly operations: Pick<PaymentOperationsService, 'windowFor'>;
  readonly clock: Clock;
}

export interface GatewayHealthEntry {
  readonly provider: PaymentGatewayProvider;
  readonly status: PaymentGatewayStatus;
  readonly state: GatewayHealthState;
  readonly gaps: readonly GatewayConfigurationGap[];
  readonly check: {
    readonly supported: boolean;
    readonly last: { readonly at: Date; readonly result: string } | null;
  };
  readonly recorded: GatewayRecordedFacts;
  /** Null when withheld (no `payments.view`). */
  readonly queues: PaymentOpsQueueCounts | null;
  readonly signals: readonly GatewayHealthSignal[];
}

export interface GatewayHealthReport {
  readonly window: TimePeriod | null;
  readonly gateways: readonly GatewayHealthEntry[];
  readonly withheld: readonly GatewayHealthSection[];
}

const NO_FACTS: GatewayRecordedFacts = {
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

const SEVERITY_RANK: Readonly<Record<OperationalSeverity, number>> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  CRITICAL: 4,
};

/**
 * The typed signals one route's facts raise (the Notification Center's hook). Pure: each is
 * a fact the record holds, with a key that stays the same while the fact does.
 * `queues` null (withheld) raises no payment signal rather than a zero one.
 */
export function gatewayHealthSignals(input: {
  readonly provider: PaymentGatewayProvider;
  readonly status: PaymentGatewayStatus;
  readonly gaps: readonly GatewayConfigurationGap[];
  readonly lastCheck: { readonly at: Date; readonly result: string } | null;
  readonly recorded: GatewayRecordedFacts;
  readonly queues: PaymentOpsQueueCounts | null;
}): GatewayHealthSignal[] {
  const signals: GatewayHealthSignal[] = [];
  const base = { category: GATEWAY_HEALTH_CATEGORY, provider: input.provider } as const;
  for (const condition of input.recorded.openConditions) {
    signals.push({
      ...base,
      key: `${input.provider}:OPEN_CONDITION:${condition.code}`,
      kind: 'OPEN_CONDITION',
      severity: condition.severity,
      opsCode: condition.code,
      count: condition.count,
      since: condition.since.toISOString(),
    });
  }
  if (input.status === 'ACTIVE' && input.gaps.length > 0) {
    signals.push({
      ...base,
      key: `${input.provider}:CONFIGURATION_INCOMPLETE`,
      kind: 'CONFIGURATION_INCOMPLETE',
      severity: 'ERROR',
      opsCode: null,
      count: input.gaps.length,
      since: null,
    });
  }
  if (input.lastCheck !== null && input.lastCheck.result !== 'ok') {
    signals.push({
      ...base,
      key: `${input.provider}:CHECK_FAILED`,
      kind: 'CHECK_FAILED',
      severity: 'WARN',
      opsCode: null,
      count: 1,
      since: input.lastCheck.at.toISOString(),
    });
  }
  if (input.recorded.attemptsWithProviderError > 0) {
    signals.push({
      ...base,
      key: `${input.provider}:PROVIDER_ERRORS`,
      kind: 'PROVIDER_ERRORS',
      severity: 'WARN',
      opsCode: null,
      count: input.recorded.attemptsWithProviderError,
      since: null,
    });
  }
  if (input.queues !== null && input.queues.UNKNOWN > 0) {
    signals.push({
      ...base,
      key: `${input.provider}:PAYMENTS_UNKNOWN`,
      kind: 'PAYMENTS_UNKNOWN',
      severity: 'WARN',
      opsCode: null,
      count: input.queues.UNKNOWN,
      since: null,
    });
  }
  if (input.queues !== null && input.queues.NEEDS_RECONCILIATION > 0) {
    signals.push({
      ...base,
      key: `${input.provider}:PAYMENTS_NEED_RECONCILIATION`,
      kind: 'PAYMENTS_NEED_RECONCILIATION',
      severity: 'WARN',
      opsCode: null,
      count: input.queues.NEEDS_RECONCILIATION,
      since: null,
    });
  }
  return signals;
}

/**
 * The summary by its fixed rule (`GATEWAY_HEALTH_STATES` states it in words).
 *
 * "Activity" is judged over the SELECTED window (Codex review of #160): an attempt created in
 * it, or a recorded provider answer or failure that falls in it. A route last used months ago
 * reads NO_ACTIVITY for "the last seven days" even though its historical facts are still shown.
 * A null window is all history.
 */
export function gatewayHealthState(input: {
  readonly status: PaymentGatewayStatus;
  readonly gaps: readonly GatewayConfigurationGap[];
  readonly signals: readonly GatewayHealthSignal[];
  readonly recorded: GatewayRecordedFacts;
  readonly window: TimePeriod | null;
}): GatewayHealthState {
  if (input.status === 'DISABLED') return 'DISABLED';
  if (input.gaps.length > 0) return 'INCOMPLETE';
  if (input.signals.some((signal) => SEVERITY_RANK[signal.severity] >= SEVERITY_RANK.WARN)) {
    return 'ATTENTION';
  }
  const r = input.recorded;
  const inWindow = (at: Date | null): boolean =>
    at !== null &&
    (input.window === null ||
      (at.getTime() >= input.window.start.getTime() && at.getTime() < input.window.end.getTime()));
  const anything =
    r.attemptsInWindow > 0 ||
    inWindow(r.lastInvoiceCreatedAt) ||
    inWindow(r.lastInquiryAnsweredAt) ||
    inWindow(r.lastInquiryFailure?.at ?? null) ||
    inWindow(r.lastCreateFailure?.at ?? null);
  return anything ? 'NO_ISSUES_RECORDED' : 'NO_ACTIVITY';
}

export class GatewayHealthService {
  constructor(private readonly deps: GatewayHealthServiceDeps) {}

  /**
   * Every route's health for an operator, under `payments.gateways.view`. The queue counts
   * and the last reconciliation are payments facts, read only with `payments.view` and named
   * WITHHELD otherwise — without recording a denial, as the payment timeline does for its
   * sections: not holding it is not an attempted access.
   */
  async report(
    scope: TenantContext,
    actor: ActorContext,
    input: PaymentOpsWindowInput,
  ): Promise<GatewayHealthReport> {
    await this.deps.guard.check(scope, actor, PAYMENT_GATEWAY_VIEW_PERMISSION);
    const held = await this.deps.guard.permissionsOf(scope, actor);
    const mayPayments = held.has(PAYMENT_VIEW_PERMISSION);
    const window = await this.deps.operations.windowFor(scope, input);
    const gateways = await this.assemble(scope, window, mayPayments);
    return { window, gateways, withheld: mayPayments ? [] : ['PAYMENTS'] };
  }

  /**
   * The Notification Center's hook (program §12): every route's typed signals, with no
   * permission of its own — its caller is a system sweep acting under its own authority, and
   * what reaches an operator is decided where it is shown. Tenant-scoped.
   */
  async signals(
    scope: TenantContext,
    window: TimePeriod | null,
  ): Promise<readonly GatewayHealthSignal[]> {
    const gateways = await this.assemble(scope, window, true);
    return gateways.flatMap((gateway) => gateway.signals);
  }

  private async assemble(
    scope: TenantContext,
    window: TimePeriod | null,
    withPayments: boolean,
  ): Promise<GatewayHealthEntry[]> {
    const [routes, recorded, attention] = await Promise.all([
      this.deps.routes.routes(scope),
      this.deps.reader.facts(scope, window),
      withPayments ? this.deps.attention.counts(scope, window) : Promise.resolve(null),
    ]);
    const queuesOf = (provider: PaymentGatewayProvider): PaymentOpsQueueCounts | null => {
      if (attention === null) return null;
      const row = attention.find((one) => one.gatewayProvider === provider);
      return row?.counts ?? ZERO_COUNTS;
    };
    const entries: GatewayHealthEntry[] = [];
    for (const gateway of routes) {
      const [readiness, lastCheck] = await Promise.all([
        this.deps.routes.readinessFacts(scope, gateway),
        this.deps.routes.lastCheck(scope, gateway.provider),
      ]);
      const gaps = configurationGaps(readiness);
      const facts = recorded.get(gateway.provider) ?? NO_FACTS;
      const visible: GatewayRecordedFacts = withPayments
        ? facts
        : { ...facts, lastReconciliation: null };
      const queues = queuesOf(gateway.provider);
      const signals = gatewayHealthSignals({
        provider: gateway.provider,
        status: gateway.status,
        gaps,
        lastCheck,
        recorded: visible,
        queues,
      });
      entries.push({
        provider: gateway.provider,
        status: gateway.status,
        state: gatewayHealthState({
          status: gateway.status,
          gaps,
          signals,
          recorded: visible,
          window,
        }),
        gaps,
        check: { supported: this.deps.routes.checkSupported(gateway.provider), last: lastCheck },
        recorded: visible,
        queues,
        signals,
      });
    }
    return entries;
  }
}

const ZERO_COUNTS: PaymentOpsQueueCounts = {
  PENDING: 0,
  UNKNOWN: 0,
  NEEDS_RECONCILIATION: 0,
  MISMATCH: 0,
  PARTIAL: 0,
  LATE_COMPLETION: 0,
  PROVIDER_ERROR: 0,
  REFUND_RELATED: 0,
  NEEDS_ACTION: 0,
};
