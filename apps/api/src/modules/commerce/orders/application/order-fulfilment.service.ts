import {
  COMMERCE_ERROR_CODES,
  PANEL_ERROR_CODES,
  ORDER_MACHINE,
  errors,
  nextState,
  orderIdSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type OrderId,
  type PanelId,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import { runAuthorizedMutation } from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { PanelRepository } from '../../../platform/panels/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { ProvisioningService } from '../../provisioning/application/provisioning.service.js';
import type { OrderRecord, OrderRepository } from './ports.js';
import {
  ORDERS_FULFIL_PERMISSION,
  type UnfulfilledOrderReporter,
} from './unfulfilled-order-reporter.js';

const FULFIL_NAMESPACE = 'WEB' as const;

export interface OrderFulfilmentServiceDeps {
  readonly repository: OrderRepository;
  readonly provisioning: Pick<ProvisioningService, 'prepareFulfilment' | 'planForSettledOrder'>;
  /** Reads the panel a REASSIGNMENT names, to prove it is this tenant's. */
  readonly panels: Pick<PanelRepository, 'find'>;
  readonly unfulfilled: UnfulfilledOrderReporter;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
}

/**
 * The way out of an order that was paid for and could not be delivered.
 *
 * The OTHER way out is a refund, which is the payment module's and needs nothing from
 * here. Both exist deliberately: an operator looking at a stranded order should be
 * choosing between delivering it late and giving the money back, and a product that
 * offers only the second one teaches its operators to refund instead of fixing a
 * panel.
 *
 * What this does NOT do is retry by itself. A panel that filled up may drain in an
 * hour; one that was archived never will, and a loop that could not tell them apart
 * would hammer the second for ever. A person decides, and the audit row says who.
 */
export class OrderFulfilmentService {
  constructor(private readonly deps: OrderFulfilmentServiceDeps) {}

  /**
   * Fulfil a `PAID_UNFULFILLED` order — on its own panel, or on another one.
   *
   * Idempotent on three levels, and they are not redundant:
   *
   *   - the idempotency store answers a replayed REQUEST with the row it produced,
   *     so a double-clicked button does not run this twice;
   *   - the state transition is conditional on `PAID_UNFULFILLED`, so two replicas
   *     racing past the store produce one winner and one refusal;
   *   - `planForSettledOrder` is an upsert on `(tenant_id, order_id)`, so even a
   *     winner that ran twice writes one service and plans one operation.
   *
   * Nothing here contacts a provider. A service row and a `PROVISION` operation are
   * written, and the `provisioner` role picks the work up afterwards — exactly as an
   * ordinary settlement does, which is the point: a late fulfilment must not be a
   * second code path to a provider.
   */
  async fulfil(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly orderId: string;
      readonly panelId?: string | undefined;
    },
  ): Promise<OrderRecord> {
    const orderId = orderIdSchema.parse(input.orderId);
    const requestHash = hashRequest({ orderId, panelId: input.panelId ?? null });

    /*
     * Authorized BEFORE the replay lookup, and again inside the transaction.
     *
     * A replay never reaches `runAuthorizedMutation`, and a replay returns an ORDER —
     * so without this an unauthorized caller replaying somebody else's key would be
     * answered with one. `OrderService.createDraft` records the same shape.
     */
    await this.authorize(scope, actor, orderId);

    const replay = await this.deps.idempotency.find<{ orderId: string }>(
      scope,
      FULFIL_NAMESPACE,
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      const existing = await this.deps.repository.findById(scope, replay.result.orderId as OrderId);
      if (existing !== null) return existing;
    }

    const now = this.deps.clock.now();

    return runAuthorizedMutation(
      {
        uow: this.deps.uow,
        guard: this.deps.guard,
        audit: this.deps.audit,
        opsLog: this.deps.opsLog,
        sessions: this.deps.sessions,
        clock: this.deps.clock,
      },
      scope,
      actor,
      ORDERS_FULFIL_PERMISSION,
      { action: 'order.fulfil', entityType: 'Order', entityId: orderId },
      async (tx) => {
        await this.assertScopeActive(scope, tx);

        const before = await this.deps.repository.findById(scope, orderId, tx);
        if (before === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.ORDER_NOT_FOUND, 'Unknown order.');
        }
        if (before.state !== 'PAID_UNFULFILLED') {
          /*
           * Includes an order that is already `PAID` — which is what a retry finds
           * after somebody else's retry won, and is reported as the conflict it is
           * rather than as a success. The idempotency store above is what makes THIS
           * caller's own replay answer with the row instead of reaching here.
           */
          throw errors.conflict(
            COMMERCE_ERROR_CODES.ORDER_STATE_INVALID,
            'That order is not waiting to be fulfilled.',
            { state: before.state },
          );
        }

        const target = await this.reassignmentTarget(scope, before, input.panelId, tx);
        /*
         * The order AS IT WILL BE, so the eligibility decision and the service row
         * are about the same panel the transition is about to write. Built here
         * rather than after the UPDATE because `prepareFulfilment` takes that panel's
         * lock, and locking one panel while writing another is the race this avoids.
         */
        const order: OrderRecord =
          target === null ? before : { ...before, line: { ...before.line, panelId: target } };

        /*
         * REFUSE, not STRAND: the order is already stranded, and a retry that cannot
         * be fulfilled must leave it exactly as it was rather than re-stranding it
         * with a fresh timestamp and a second notification. The operator is told why,
         * and the open condition they are working from stays open.
         */
        const decision = await this.deps.provisioning.prepareFulfilment(scope, order, tx, 'REFUSE');
        /* istanbul ignore next -- REFUSE throws; this narrows the union. */
        if (decision.outcome !== 'FULFILLABLE') {
          throw errors.preconditionFailed(
            COMMERCE_ERROR_CODES.PANEL_NOT_ELIGIBLE,
            'This order cannot be fulfilled on that panel.',
            { reason: decision.reason },
          );
        }

        const to = nextState(ORDER_MACHINE, 'PAID_UNFULFILLED', 'FULFIL');
        if (to === null) {
          throw new Error('ORDER_MACHINE no longer allows FULFIL from PAID_UNFULFILLED.');
        }
        const moved = await this.deps.repository.transition(
          scope,
          orderId,
          'PAID_UNFULFILLED',
          to,
          /*
           * `unfulfilledAt` and `unfulfilledReason` are deliberately NOT cleared:
           * `orders_unfulfilled_*_check` are implications, so the history survives
           * the state that produced it. `panelId` moves only on a reassignment.
           */
          target === null ? {} : { panelId: target },
          now,
          tx,
        );
        if (!moved) {
          /*
           * Somebody else fulfilled it between the read and this UPDATE. Their
           * transaction wrote the service; this one must write nothing.
           */
          throw errors.conflict(
            COMMERCE_ERROR_CODES.ORDER_STATE_INVALID,
            'That order was fulfilled by somebody else.',
          );
        }

        const { service } = await this.deps.provisioning.planForSettledOrder(
          scope,
          actor,
          order,
          now,
          tx,
        );

        const fulfilled = await this.deps.repository.findById(scope, orderId, tx);
        if (fulfilled === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.ORDER_NOT_FOUND, 'Unknown order.');
        }

        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'order.fulfil',
            entityType: 'Order',
            entityId: orderId,
            before: { state: before.state, panelId: before.line.panelId },
            after: {
              state: fulfilled.state,
              panelId: fulfilled.line.panelId,
              serviceId: service.id,
              // The reason it was stranded, carried into the row that says it no
              // longer is: an auditor reading this one line should not have to find
              // the settlement to know what went wrong.
              unfulfilledReason: before.unfulfilledReason,
            },
            result: 'SUCCESS',
          },
          tx,
        );

        await this.deps.outbox.write(tx, actor, {
          eventType: 'OrderFulfilled',
          aggregateType: 'Order',
          aggregateId: orderId,
          payload: {
            customerId: fulfilled.customerId,
            serviceId: service.id,
            panelId: fulfilled.line.panelId,
            reassigned: target !== null,
          },
        });

        await this.deps.unfulfilled.resolve(
          scope,
          { id: orderId, correlationId: actor.correlationId },
          target === null ? 'fulfilled on its own panel' : `fulfilled on panel ${target}`,
          tx,
        );

        await rememberOnce(
          this.deps.idempotency,
          scope,
          FULFIL_NAMESPACE,
          input.idempotencyKey,
          requestHash,
          { orderId },
          tx,
        );
        return fulfilled;
      },
    );
  }

  /**
   * The panel a reassignment names, validated — or `null` for "the one it was sold on".
   *
   * Validated HERE rather than left to `prepareFulfilment`, because a panel id of
   * another tenant would otherwise reach the eligibility evaluator, which answers
   * `ARCHIVED` for an absent panel. That answer is correct for a catalogue and wrong
   * here: it would tell an operator their own panel is archived when what happened is
   * that they named somebody else's.
   *
   * Naming the panel it already has is not a reassignment and is answered as one:
   * `null`, so the audit row and the event do not claim a move that did not happen.
   */
  private async reassignmentTarget(
    scope: TenantContext,
    order: OrderRecord,
    panelId: string | undefined,
    tx: TransactionScope,
  ): Promise<PanelId | null> {
    if (panelId === undefined || panelId === order.line.panelId) return null;
    const view = await this.deps.panels.find(scope, panelId as PanelId, tx);
    if (view === null) {
      throw errors.notFound(PANEL_ERROR_CODES.PANEL_NOT_FOUND, 'Unknown panel.');
    }
    return panelId as PanelId;
  }

  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    orderId: OrderId,
  ): Promise<void> {
    await this.deps.guard.check(scope, actor, ORDERS_FULFIL_PERMISSION, {
      entityType: 'Order',
      entityId: orderId,
    });
  }

  private async assertScopeActive(scope: TenantContext, tx: TransactionScope): Promise<void> {
    if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'This installation has stopped accepting work.',
      );
    }
  }
}
