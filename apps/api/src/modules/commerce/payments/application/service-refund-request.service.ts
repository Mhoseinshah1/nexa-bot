import {
  COMMERCE_ERROR_CODES,
  SERVICE_REFUND_ELIGIBLE_SERVICE_STATES,
  SERVICE_REFUND_REASON_MAX_LENGTH,
  SERVICE_REFUND_REASON_MIN_LENGTH,
  SERVICE_REFUND_REQUEST_ACTIVE_STATES,
  errors,
  money,
  refundableMinor,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type Money,
  type OperationalEventRecorder,
  type OperationType,
  type PanelId,
  type PermissionKey,
  type ServiceId,
  type ServiceRefundIneligibilityReason,
  type ServiceRefundRequestState,
  type TenantContext,
  type UnitOfWork,
  type UserId,
  type TemplateValues,
} from '@nexa/contracts';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import { runAuthorizedMutation } from '../../../platform/access/application/authorized-mutation.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { CustomerNotifier } from '../../messaging/application/customer-notifier.js';
import type { CustomerRecord, CustomerRepository } from '../../customers/application/ports.js';
import type { OrderRepository } from '../../orders/application/ports.js';
import type {
  OperationRecord,
  ServiceRecord,
  ServiceRepository,
} from '../../provisioning/application/ports.js';
import type { PaymentRecord, PaymentRepository } from './ports.js';
import type { RefundRepository } from './refund-ports.js';
import type { RefundService } from './refund.service.js';
import type {
  ServiceRefundRequestListItem,
  ServiceRefundRequestRecord,
  ServiceRefundRequestRepository,
} from './service-refund-request-ports.js';

/** Reading requests: the refund ledger's own read permission. */
export const SERVICE_REFUND_VIEW_PERMISSION = 'refunds.view' satisfies PermissionKey;
/**
 * Deciding one: an approval moves money AND deletes an account, so it needs both keys, and a
 * rejection is held to the same pair — the two answers to one question are one authority.
 */
export const SERVICE_REFUND_DECIDE_PERMISSIONS = [
  'refunds.issue',
  'services.terminate',
] as const satisfies readonly PermissionKey[];
/** A customer's own filing runs as the webhook's `SYSTEM_JOB`, like every customer write. */
const CUSTOMER_FILING_PERMISSION: PermissionKey = 'maintenance.run';
/** How many executing requests one sweep decides. */
export const SERVICE_REFUND_SWEEP_LIMIT = 50;

/** The one feature switch this workflow answers to (brief §2.1). */
const FLAG = 'customer_refund_requests';

/** A request's reason, trimmed and in bounds, or `null`. Code points, not UTF-16 units. */
export function normaliseRefundReason(text: string): string | null {
  const trimmed = text.trim();
  const length = Array.from(trimmed).length;
  if (length < SERVICE_REFUND_REASON_MIN_LENGTH || length > SERVICE_REFUND_REASON_MAX_LENGTH) {
    return null;
  }
  return trimmed;
}

/** What a service's refund source resolved to: the order, its confirmed payment, what is left. */
export interface ServiceRefundSource {
  readonly payment: PaymentRecord;
  readonly remaining: Money;
}

export type ServiceRefundEligibility =
  | { readonly eligible: true; readonly source: ServiceRefundSource }
  | { readonly eligible: false; readonly reason: ServiceRefundIneligibilityReason };

export type ServiceRefundFileResult =
  | { readonly outcome: 'FILED'; readonly request: ServiceRefundRequestRecord }
  | { readonly outcome: 'ALREADY_OPEN'; readonly request: ServiceRefundRequestRecord };

/** Everything the review card and the final confirmation show, read from the rows. */
export interface ServiceRefundReview {
  readonly request: ServiceRefundRequestRecord;
  readonly service: ServiceRecord | null;
  readonly customer: CustomerRecord | null;
  readonly remaining: Money;
}

export interface ServiceRefundRequestServiceDeps {
  readonly repository: ServiceRefundRequestRepository;
  readonly services: Pick<ServiceRepository, 'findById'>;
  readonly orders: Pick<OrderRepository, 'findById'>;
  readonly payments: Pick<PaymentRepository, 'findConfirmedForOrder' | 'findById'>;
  readonly refundLedger: Pick<RefundRepository, 'consumptionFor' | 'lockPayment'>;
  readonly refunds: Pick<
    RefundService,
    'reserveForServiceRefund' | 'settleServiceRefund' | 'releaseServiceRefund'
  >;
  readonly termination: {
    planTerminateWithin(
      scope: TenantContext,
      actor: ActorContext,
      service: ServiceRecord,
      input: { readonly idempotencyKey: string },
      tx: TransactionScope,
    ): Promise<OperationRecord>;
  };
  readonly panels: {
    operability(
      scope: TenantContext,
      panelId: PanelId,
      type: OperationType,
      tx?: unknown,
    ): Promise<{ readonly ok: boolean }>;
  };
  readonly features: {
    isEnabled(scope: TenantContext, key: typeof FLAG, tx?: unknown): Promise<boolean>;
  };
  readonly customers: Pick<CustomerRepository, 'findById'>;
  readonly notifier: CustomerNotifier;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly guard: PermissionGuard;
  readonly sessions: SessionRepository;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly systemActor: () => ActorContext;
  readonly logger: { warn: (context: Record<string, unknown>, message: string) => void };
}

/**
 * WP19 — a customer's request to cancel a service and have money returned
 * (`docs/wp19-service-refund-request-audit.md`). The ONE implementation both surfaces call:
 * the Telegram customer and admin flows and the Web Admin fallback hold no rule of their own.
 */
export class ServiceRefundRequestService {
  constructor(private readonly deps: ServiceRefundRequestServiceDeps) {}

  // --- eligibility ----------------------------------------------------------------------

  /**
   * Whether this service may carry a refund request now, and what its source is (brief
   * §2.3, §2.4). One evaluator with four callers: the button (a courtesy), the filing, the
   * approval's preview and the approval itself — so the four cannot disagree invisibly.
   *
   * The source is the service's OWN order when that order bought it as a `NEW_SERVICE`, and
   * that order's one CONFIRMED payment; a renewal, an add-on, a trial or anything that
   * resolves ambiguously is refused rather than guessed. The remaining figure is the payment's
   * principal (never the WP18 fee, which is not in `payments.amount`) less what its refunds
   * already consume. Read without the payment's lock here; the approval re-decides it under
   * the lock, which is the only figure money follows.
   */
  async eligibilityOf(
    scope: TenantContext,
    service: ServiceRecord,
    options: { readonly checkFlag: boolean },
    tx?: TransactionScope,
  ): Promise<ServiceRefundEligibility> {
    if (options.checkFlag && !(await this.deps.features.isEnabled(scope, FLAG, tx))) {
      return { eligible: false, reason: 'DISABLED' };
    }
    if (!(SERVICE_REFUND_ELIGIBLE_SERVICE_STATES as readonly string[]).includes(service.state)) {
      return { eligible: false, reason: 'SERVICE_STATE' };
    }
    const order = await this.deps.orders.findById(scope, service.orderId, tx);
    if (order === null) return { eligible: false, reason: 'SOURCE_UNRESOLVED' };
    if (order.purpose !== 'NEW_SERVICE') return { eligible: false, reason: 'NO_PAID_SOURCE' };
    const payment = await this.deps.payments.findConfirmedForOrder(scope, order.id, tx);
    if (payment === null) {
      // A trial or a zero-total order has no payment; anything else here is unresolved.
      return {
        eligible: false,
        reason: order.totals.total.amountMinor === 0n ? 'NO_PAID_SOURCE' : 'SOURCE_UNRESOLVED',
      };
    }
    if (payment.orderId !== order.id || payment.customerId !== service.customerId) {
      return { eligible: false, reason: 'SOURCE_UNRESOLVED' };
    }
    if (payment.amount.amountMinor <= 0n) return { eligible: false, reason: 'NO_PAID_SOURCE' };
    const remaining = await this.remainingOf(scope, payment, tx);
    if (remaining.amountMinor <= 0n) return { eligible: false, reason: 'NOTHING_REFUNDABLE' };
    const operable = await this.deps.panels.operability(scope, service.panelId, 'TERMINATE', tx);
    if (!operable.ok) return { eligible: false, reason: 'CANNOT_DELETE' };
    return { eligible: true, source: { payment, remaining } };
  }

  /**
   * What the customer is offered for one service: the request, the fact that one already
   * stands, or nothing. A courtesy for the surface — the filing re-decides all of it.
   */
  async customerOffer(
    scope: TenantContext,
    service: ServiceRecord,
  ): Promise<'OFFERED' | 'PENDING' | 'UNAVAILABLE'> {
    if (!(await this.deps.features.isEnabled(scope, FLAG))) return 'UNAVAILABLE';
    const active = await this.deps.repository.findActiveForService(scope, service.id as ServiceId);
    if (active !== null) return 'PENDING';
    const eligibility = await this.eligibilityOf(scope, service, { checkFlag: false });
    return eligibility.eligible ? 'OFFERED' : 'UNAVAILABLE';
  }

  /** Whether the customer's service detail draws the button. A courtesy; never trusted. */
  async offeredFor(scope: TenantContext, service: ServiceRecord): Promise<boolean> {
    return (await this.customerOffer(scope, service)) === 'OFFERED';
  }

  // --- the customer's filing -------------------------------------------------------------

  /**
   * Files the customer's request, exactly once (brief §2.2).
   *
   * Everything is re-decided inside the transaction: the switch, the customer's standing,
   * the service's ownership and eligibility. A service that already has an OPEN or
   * EXECUTING request is answered with THAT request — the partial unique index is the
   * arbiter, so a double tap, a replayed update and two concurrent filings all end with one
   * row. Nothing is reserved, planned or moved here.
   */
  async file(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly customerId: UserId;
      readonly serviceId: string;
      readonly botInstanceId: string;
      readonly reason: string;
    },
  ): Promise<ServiceRefundFileResult> {
    const reason = normaliseRefundReason(input.reason);
    if (reason === null) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.CAPTURE_INPUT_INVALID,
        'The reason is outside its bound.',
        {
          min: SERVICE_REFUND_REASON_MIN_LENGTH,
          max: SERVICE_REFUND_REASON_MAX_LENGTH,
        },
      );
    }
    const denial = {
      action: 'service_refund_request.file',
      entityType: 'Service',
      entityId: input.serviceId,
    };
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      CUSTOMER_FILING_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const customer = await this.deps.customers.findById(scope, input.customerId, tx);
        if (customer === null || customer.status !== 'ACTIVE') {
          throw errors.notFound(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND, 'Unknown service.');
        }
        const service = await this.requireOwnedService(
          scope,
          input.customerId,
          input.serviceId,
          tx,
        );
        const existing = await this.deps.repository.findActiveForService(
          scope,
          service.id as ServiceId,
          tx,
        );
        if (existing !== null) return { outcome: 'ALREADY_OPEN', request: existing };
        const eligibility = await this.eligibilityOf(scope, service, { checkFlag: true }, tx);
        if (!eligibility.eligible) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.SERVICE_REFUND_NOT_ELIGIBLE,
            'This service cannot carry a refund request now.',
            { reason: eligibility.reason },
          );
        }
        const payment = eligibility.source.payment;
        const now = this.deps.clock.now();
        const created = await this.deps.repository.create(
          scope,
          {
            id: this.deps.ids.uuid(),
            serviceId: service.id as ServiceId,
            customerId: input.customerId,
            orderId: service.orderId,
            paymentId: payment.id,
            botInstanceId: input.botInstanceId,
            reason,
            principalMinor: payment.amount.amountMinor,
            currency: payment.amount.currency,
            now,
          },
          tx,
        );
        if (created === null) {
          // A concurrent filing won the index between the read above and the insert.
          const winner = await this.deps.repository.findActiveForService(
            scope,
            service.id as ServiceId,
            tx,
          );
          if (winner === null) throw new Error('A refund request conflict left no row.');
          return { outcome: 'ALREADY_OPEN', request: winner };
        }
        await this.deps.outbox.write(tx, actor, {
          eventType: 'ServiceRefundRequested',
          aggregateType: 'Service',
          aggregateId: service.id,
          payload: {
            requestId: created.id,
            customerId: created.customerId,
            paymentId: created.paymentId,
          },
        });
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'service_refund_request.file',
            entityType: 'ServiceRefundRequest',
            entityId: created.id,
            before: null,
            // The reason is the customer's own words about their own service; it is on the
            // row. The audit names the facts, not the text.
            after: {
              serviceId: created.serviceId,
              customerId: created.customerId,
              paymentId: created.paymentId,
              principalMinor: created.principal.amountMinor.toString(),
              currency: created.principal.currency,
            },
            result: 'SUCCESS',
          },
          tx,
        );
        return { outcome: 'FILED', request: created };
      },
    );
  }

  // --- an administrator's decision -------------------------------------------------------

  /**
   * What the review card and the final confirmation show. Charged `refunds.view`; the
   * remaining figure is the server's own, read at this moment.
   */
  async review(
    scope: TenantContext,
    actor: ActorContext,
    requestId: string,
  ): Promise<ServiceRefundReview> {
    await this.deps.guard.check(scope, actor, SERVICE_REFUND_VIEW_PERMISSION);
    const request = await this.requireRequest(scope, requestId);
    return this.reviewOf(scope, request);
  }

  /**
   * Validates an amount an administrator typed, under the payment's lock (brief §2.6),
   * WITHOUT deciding anything: the figure the final confirmation shows is one the server
   * has just checked, not one a browser or an old message rendered. The lock is released
   * when this read-only transaction ends; the approval takes it again.
   */
  async preview(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly requestId: string; readonly amountMinor: bigint },
  ): Promise<ServiceRefundReview> {
    await this.checkDecide(scope, actor);
    const request = await this.requireRequest(scope, input.requestId);
    this.assertOpen(request);
    return this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.refundLedger.lockPayment(scope, request.paymentId, tx))) {
        throw errors.notFound(COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND, 'Unknown payment.');
      }
      const view = await this.reviewOf(scope, request, tx);
      this.assertAmount(input.amountMinor, view.remaining);
      return view;
    });
  }

  /**
   * Approves the request with an amount: the final confirmation's command (brief §2.6-2.8).
   *
   * In ONE transaction, under the request's lock and then the payment's:
   * the request must still be OPEN; the service must still be deletable; the amount must fit
   * what the payment has left (the existing bound, `REQUESTED` reserving it); a `TERMINATE`
   * is planned; and the request moves `OPEN -> EXECUTING` naming the reservation and the
   * deletion. Nothing is credited. A replay of the same approval — same administrator, same
   * amount — is answered with the request as it stands; anything else that finds it decided
   * is refused with its state.
   */
  async approve(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly requestId: string; readonly amountMinor: bigint },
  ): Promise<ServiceRefundRequestRecord> {
    await this.checkDecide(scope, actor);
    const adminId = this.adminIdOf(actor);
    const denial = {
      action: 'service_refund_request.approve',
      entityType: 'ServiceRefundRequest',
      entityId: input.requestId,
    };
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      'refunds.issue',
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        await this.deps.guard.check(scope, actor, 'services.terminate', tx);
        const request = await this.deps.repository.findByIdForUpdate(scope, input.requestId, tx);
        if (request === null) throw this.notFound();
        if (request.state !== 'OPEN') {
          if (
            request.decidedByAdminId === adminId &&
            request.approvedAmount !== null &&
            request.approvedAmount.amountMinor === input.amountMinor
          ) {
            return request;
          }
          throw this.stateInvalid(request.state);
        }
        const service = await this.deps.services.findById(scope, request.serviceId, tx);
        if (service === null) throw this.notEligible('SERVICE_STATE');
        const eligibility = await this.eligibilityOf(scope, service, { checkFlag: false }, tx);
        if (!eligibility.eligible) throw this.notEligible(eligibility.reason);
        if (eligibility.source.payment.id !== request.paymentId) {
          throw this.notEligible('SOURCE_UNRESOLVED');
        }
        if (input.amountMinor <= 0n) {
          throw errors.validation(
            COMMERCE_ERROR_CODES.REFUND_EXCEEDS_REFUNDABLE,
            'The amount must be positive.',
          );
        }
        // The bound, decided under the payment's lock inside this call.
        const refund = await this.deps.refunds.reserveForServiceRefund(
          scope,
          actor,
          { paymentId: request.paymentId, amountMinor: input.amountMinor },
          tx,
        );
        const operation = await this.deps.termination.planTerminateWithin(
          scope,
          actor,
          service,
          { idempotencyKey: `service-refund:${request.id}` },
          tx,
        );
        const now = this.deps.clock.now();
        const approved = await this.deps.repository.approve(
          scope,
          request.id,
          {
            amountMinor: input.amountMinor,
            refundId: refund.id,
            operationId: operation.id,
            adminId,
          },
          now,
          tx,
        );
        /* istanbul ignore next -- the row is locked and was OPEN above. */
        if (approved === null) throw this.stateInvalid(request.state);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'service_refund_request.approve',
            entityType: 'ServiceRefundRequest',
            entityId: request.id,
            before: { state: 'OPEN' },
            after: {
              state: 'EXECUTING',
              amountMinor: input.amountMinor.toString(),
              currency: request.principal.currency,
              refundId: refund.id,
              operationId: operation.id,
              channel: refund.channel,
            },
            result: 'SUCCESS',
          },
          tx,
        );
        return approved;
      },
    );
  }

  /**
   * Rejects the request with a mandatory reason (brief §2.9): `OPEN -> REJECTED` exactly
   * once, the customer told the reason through the lane, nothing deleted, nothing moved. A
   * replay with the same reason is answered with the request as it stands.
   */
  async reject(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly requestId: string; readonly reason: string },
  ): Promise<ServiceRefundRequestRecord> {
    await this.checkDecide(scope, actor);
    const reason = input.reason.trim();
    if (reason.length === 0 || Array.from(reason).length > 500) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.CAPTURE_INPUT_INVALID,
        'A rejection needs a reason of at most 500 characters.',
        { max: 500 },
      );
    }
    const adminId = this.adminIdOf(actor);
    const denial = {
      action: 'service_refund_request.reject',
      entityType: 'ServiceRefundRequest',
      entityId: input.requestId,
    };
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      'refunds.issue',
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        await this.deps.guard.check(scope, actor, 'services.terminate', tx);
        const request = await this.deps.repository.findByIdForUpdate(scope, input.requestId, tx);
        if (request === null) throw this.notFound();
        if (request.state !== 'OPEN') {
          if (request.state === 'REJECTED' && request.rejectionReason === reason) return request;
          throw this.stateInvalid(request.state);
        }
        const now = this.deps.clock.now();
        const rejected = await this.deps.repository.reject(
          scope,
          request.id,
          { reason, adminId },
          now,
          tx,
        );
        /* istanbul ignore next -- the row is locked and was OPEN above. */
        if (rejected === null) throw this.stateInvalid(request.state);
        await this.deps.notifier.notify(
          scope,
          rejected.customerId,
          'SERVICE_REFUND_REQUEST_REJECTED',
          rejected.id,
          now,
          tx,
        );
        await this.resolved(actor, rejected, 'REJECTED', tx);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'service_refund_request.reject',
            entityType: 'ServiceRefundRequest',
            entityId: rejected.id,
            before: { state: 'OPEN' },
            after: { state: 'REJECTED' },
            result: 'SUCCESS',
          },
          tx,
        );
        return rejected;
      },
    );
  }

  // --- the sweep that decides an executing request ---------------------------------------

  /**
   * Decides EXECUTING requests whose deletion has become terminal (T2). Driven by the
   * provisioner's tick, like the cashback earner — never by a hook at the executor's success
   * site. Each request is decided in its own transaction under its own lock, so a replay or
   * two replicas decide it once: the second finds it no longer EXECUTING.
   *
   * - `SUCCEEDED` and the service `TERMINATED`: the reservation is credited exactly once,
   *   the customer told the amount and the removal, the log told. COMPLETED.
   * - `FAILED` or `ABANDONED`: the reservation is released and nothing is credited. FAILED,
   *   with the operation's failure kind, for an operator.
   * - Anything else is not returned by the query (an UNKNOWN or in-flight deletion) or is
   *   left as it stands (a SUCCEEDED deletion whose service did not move): no money on a
   *   guess.
   */
  async settleDue(scope: TenantContext, limit = SERVICE_REFUND_SWEEP_LIMIT): Promise<number> {
    const decidable = await this.deps.repository.executingDecidable(scope, limit);
    let decided = 0;
    for (const item of decidable) {
      const succeeded = item.operationState === 'SUCCEEDED';
      if (succeeded && item.serviceState !== 'TERMINATED') {
        this.deps.logger.warn(
          { requestId: item.request.id, serviceState: item.serviceState },
          'A refund request whose deletion succeeded names a service that is not terminated; nothing is credited.',
        );
        continue;
      }
      const actor = this.deps.systemActor();
      const moved = await this.deps.uow.run(scope, async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return false;
        const request = await this.deps.repository.findByIdForUpdate(scope, item.request.id, tx);
        if (request === null || request.state !== 'EXECUTING' || request.refundId === null) {
          return false;
        }
        const now = this.deps.clock.now();
        if (succeeded) {
          await this.deps.refunds.settleServiceRefund(scope, actor, request.refundId, tx);
          const completed = await this.deps.repository.resolveExecution(
            scope,
            request.id,
            { to: 'COMPLETED', failureKind: null },
            now,
            tx,
          );
          /* istanbul ignore next -- locked and EXECUTING above. */
          if (completed === null) return false;
          await this.deps.notifier.notify(
            scope,
            completed.customerId,
            'SERVICE_REFUND_REQUEST_APPROVED',
            completed.id,
            now,
            tx,
          );
          await this.resolved(actor, completed, 'COMPLETED', tx);
          await this.deps.audit.record(
            scope,
            actor,
            {
              action: 'service_refund_request.complete',
              entityType: 'ServiceRefundRequest',
              entityId: completed.id,
              before: { state: 'EXECUTING' },
              after: {
                state: 'COMPLETED',
                refundId: completed.refundId,
                amountMinor: completed.approvedAmount?.amountMinor.toString() ?? null,
              },
              result: 'SUCCESS',
            },
            tx,
          );
          return true;
        }
        await this.deps.refunds.releaseServiceRefund(scope, actor, request.refundId, tx);
        const failed = await this.deps.repository.resolveExecution(
          scope,
          request.id,
          { to: 'FAILED', failureKind: item.operationFailureKind ?? item.operationState },
          now,
          tx,
        );
        /* istanbul ignore next -- locked and EXECUTING above. */
        if (failed === null) return false;
        await this.resolved(actor, failed, 'FAILED', tx);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'service_refund_request.fail',
            entityType: 'ServiceRefundRequest',
            entityId: failed.id,
            before: { state: 'EXECUTING' },
            after: { state: 'FAILED', failureKind: failed.failureKind },
            result: 'SUCCESS',
          },
          tx,
        );
        return true;
      });
      if (moved) decided += 1;
    }
    return decided;
  }

  // --- reads ------------------------------------------------------------------------------

  /** The Web Admin's list, with the server's own remaining figure beside each row. */
  async list(
    scope: TenantContext,
    actor: ActorContext,
    filter: {
      readonly state?: ServiceRefundRequestState;
      readonly serviceId?: string;
      readonly limit: number;
    },
  ): Promise<readonly (ServiceRefundRequestListItem & { readonly remaining: Money })[]> {
    await this.deps.guard.check(scope, actor, SERVICE_REFUND_VIEW_PERMISSION);
    const items = await this.deps.repository.list(scope, {
      ...(filter.state === undefined ? {} : { state: filter.state }),
      ...(filter.serviceId === undefined ? {} : { serviceId: filter.serviceId as ServiceId }),
      limit: filter.limit,
    });
    const result = [];
    for (const item of items) {
      const payment = await this.deps.payments.findById(scope, item.request.paymentId);
      result.push({
        ...item,
        remaining:
          payment === null
            ? money(0n, item.request.principal.currency)
            : await this.remainingOf(scope, payment),
      });
    }
    return result;
  }

  /**
   * The values a customer notification about a request renders (ADR 0030 §1: read from the
   * row the notification names, never a producer payload). `null` — and so no message —
   * when the fact the sentence states is not on the row.
   */
  async notificationValues(
    scope: TenantContext,
    kind: string,
    requestId: string,
  ): Promise<Record<string, unknown> | null> {
    const request = await this.deps.repository.findById(scope, requestId);
    if (request === null) return null;
    const service = await this.deps.services.findById(scope, request.serviceId);
    const label = service?.providerUsername ?? '—';
    if (kind === 'SERVICE_REFUND_REQUEST_APPROVED') {
      if (request.state !== 'COMPLETED' || request.approvedAmount === null) return null;
      return { amount: request.approvedAmount, service: label };
    }
    if (kind === 'SERVICE_REFUND_REQUEST_REJECTED') {
      if (request.state !== 'REJECTED' || request.rejectionReason === null) return null;
      return { reason: request.rejectionReason, service: label };
    }
    return {};
  }

  /**
   * The administrator's review card (brief §2.5), read from the rows as they stand when the
   * card is sent — never from the event that caused it. `null`, and so no card, when the
   * request or its service is gone.
   *
   * Unguarded like `notificationValues`: its one caller is the push lane, which has already
   * resolved the reviewer's authority for this card by `mayBePushedRefundRequests`.
   */
  async cardValues(scope: TenantContext, requestId: string): Promise<TemplateValues | null> {
    const request = await this.deps.repository.findById(scope, requestId);
    if (request === null) return null;
    const { service, customer, remaining } = await this.reviewOf(scope, request);
    if (service === null) return null;
    const order = await this.deps.orders.findById(scope, request.orderId);
    const name = [customer?.firstName ?? null, customer?.lastName ?? null]
      .filter((part): part is string => part !== null && part.trim() !== '')
      .join(' ');
    return {
      requestId: request.id,
      requestedAt: request.createdAt,
      telegramId: customer?.telegramUserId ?? '—',
      username: customer?.username === null || customer === null ? '—' : `@${customer.username}`,
      displayName: name === '' ? '—' : name,
      serviceId: service.id,
      serviceUsername: service.providerUsername,
      product: order?.line.title ?? service.productId,
      state: service.state,
      ...(service.expiresAt === null ? {} : { expiresAt: service.expiresAt }),
      usedTraffic: service.trafficUsedBytes,
      trafficLimit: service.trafficLimitBytes,
      principal: request.principal,
      remaining,
      reason: request.reason,
    };
  }

  /** Whether a service carries a COMPLETED request — the customer's list hides it (T5). */
  static readonly HIDDEN_STATE: ServiceRefundRequestState = 'COMPLETED';

  // --- internals -------------------------------------------------------------------------

  private async reviewOf(
    scope: TenantContext,
    request: ServiceRefundRequestRecord,
    tx?: TransactionScope,
  ): Promise<ServiceRefundReview> {
    const service = await this.deps.services.findById(scope, request.serviceId, tx);
    const customer = await this.deps.customers.findById(scope, request.customerId, tx);
    const payment = await this.deps.payments.findById(scope, request.paymentId, tx);
    const remaining =
      payment === null
        ? money(0n, request.principal.currency)
        : await this.remainingOf(scope, payment, tx);
    return { request, service, customer, remaining };
  }

  private async remainingOf(
    scope: TenantContext,
    payment: PaymentRecord,
    tx?: TransactionScope,
  ): Promise<Money> {
    const consumption = await this.deps.refundLedger.consumptionFor(scope, payment.id, tx);
    return money(
      refundableMinor(payment.amount.amountMinor, consumption.consumedMinor),
      payment.amount.currency,
    );
  }

  private assertAmount(amountMinor: bigint, remaining: Money): void {
    if (amountMinor <= 0n || amountMinor > remaining.amountMinor) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.REFUND_EXCEEDS_REFUNDABLE,
        'That is more than this payment has left to refund.',
        { refundableMinor: remaining.amountMinor.toString(), currency: remaining.currency },
      );
    }
  }

  private assertOpen(request: ServiceRefundRequestRecord): void {
    if (request.state !== 'OPEN') throw this.stateInvalid(request.state);
  }

  private async resolved(
    actor: ActorContext,
    request: ServiceRefundRequestRecord,
    outcome: 'COMPLETED' | 'REJECTED' | 'FAILED',
    tx: TransactionScope,
  ): Promise<void> {
    await this.deps.outbox.write(tx, actor, {
      eventType: 'ServiceRefundRequestResolved',
      aggregateType: 'Service',
      aggregateId: request.serviceId,
      payload: {
        requestId: request.id,
        customerId: request.customerId,
        paymentId: request.paymentId,
        outcome,
      },
    });
  }

  private async requireOwnedService(
    scope: TenantContext,
    customerId: UserId,
    serviceId: string,
    tx: TransactionScope,
  ): Promise<ServiceRecord> {
    if (!/^[0-9a-f-]{36}$/iu.test(serviceId)) {
      throw errors.notFound(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND, 'Unknown service.');
    }
    const service = await this.deps.services.findById(scope, serviceId, tx);
    if (service === null || service.customerId !== customerId) {
      throw errors.notFound(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND, 'Unknown service.');
    }
    return service;
  }

  private async requireRequest(
    scope: TenantContext,
    requestId: string,
  ): Promise<ServiceRefundRequestRecord> {
    if (!/^[0-9a-f-]{36}$/iu.test(requestId)) throw this.notFound();
    const request = await this.deps.repository.findById(scope, requestId);
    if (request === null) throw this.notFound();
    return request;
  }

  private async checkDecide(scope: TenantContext, actor: ActorContext): Promise<void> {
    for (const permission of SERVICE_REFUND_DECIDE_PERMISSIONS) {
      await this.deps.guard.check(scope, actor, permission);
    }
  }

  private adminIdOf(actor: ActorContext): string {
    if ((actor.type !== 'WEB_ADMIN' && actor.type !== 'TELEGRAM_ADMIN') || actor.id === null) {
      throw errors.permissionDenied(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'Only an administrator decides a refund request.',
      );
    }
    return actor.id;
  }

  private async assertScopeActive(scope: TenantContext, tx: TransactionScope): Promise<void> {
    if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That tenant has stopped accepting work.',
      );
    }
  }

  private notFound() {
    return errors.notFound(
      COMMERCE_ERROR_CODES.SERVICE_REFUND_REQUEST_NOT_FOUND,
      'Unknown refund request.',
    );
  }

  private stateInvalid(state: ServiceRefundRequestState) {
    return errors.conflict(
      COMMERCE_ERROR_CODES.SERVICE_REFUND_REQUEST_STATE_INVALID,
      'This refund request is no longer open.',
      { state },
    );
  }

  private notEligible(reason: ServiceRefundIneligibilityReason) {
    return errors.conflict(
      COMMERCE_ERROR_CODES.SERVICE_REFUND_NOT_ELIGIBLE,
      'This refund request cannot be executed in the service’s current state.',
      { reason },
    );
  }

  private mutationDeps() {
    return {
      uow: this.deps.uow,
      guard: this.deps.guard,
      audit: this.deps.audit,
      opsLog: this.deps.opsLog,
      sessions: this.deps.sessions,
      clock: this.deps.clock,
    };
  }
}

/** The active states, re-exported for the surfaces that ask "is one open". */
export const SERVICE_REFUND_ACTIVE = SERVICE_REFUND_REQUEST_ACTIVE_STATES;
