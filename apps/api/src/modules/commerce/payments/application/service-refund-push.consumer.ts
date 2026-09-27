import {
  EVENT_PAYLOAD_SCHEMAS,
  type AdminId,
  type BotInstanceId,
  type Clock,
  type CorrelationId,
  type DomainEvent,
  type EventType,
  type IdGenerator,
  type PermissionKey,
  type TenantContext,
} from '@nexa/contracts';
import type { EventConsumer } from '../../../platform/eventing/application/event-consumer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { ServiceRefundPushRepository } from './service-refund-push-ports.js';
import type { ServiceRefundRequestRepository } from './service-refund-request-ports.js';

/**
 * Who may be pushed a refund request's review card: an administrator holding BOTH decision
 * keys. The card's approve button moves money and deletes an account, and an administrator
 * who could press neither half would be handed buttons that answer "not permitted".
 */
export function mayBePushedRefundRequests(permissions: ReadonlySet<PermissionKey>): boolean {
  return permissions.has('refunds.issue') && permissions.has('services.terminate');
}

/**
 * The fan-out half of the refund-request review cards (WP19): the receipt push's consumer
 * (ADR-0031) for a different subject.
 *
 * A consumer of `ServiceRefundRequested`, so it runs after the filing committed and never in
 * the transaction that filed it — a card that cannot be enqueued costs the customer nothing,
 * and the request is on the Web Admin either way. Database work only; the send is the lane's.
 * Idempotent twice over: the relay's claim, and the row's unique (tenant, request, admin).
 */
export class ServiceRefundPushConsumer implements EventConsumer {
  /** Stable: it is the key in `processed_messages`. */
  readonly name = 'payments.service-refund-push';
  readonly subscribesTo: readonly EventType[] = ['ServiceRefundRequested'];

  constructor(
    private readonly deps: {
      readonly pushes: Pick<ServiceRefundPushRepository, 'enqueue'>;
      readonly requests: Pick<ServiceRefundRequestRepository, 'findById'>;
      readonly reviewers: {
        reviewers(
          scope: TenantContext,
          permission: PermissionKey,
          correlationId: CorrelationId,
          tx?: unknown,
        ): Promise<
          readonly {
            readonly admin: { readonly id: string; readonly telegramUserId: string | null };
            readonly permissions: ReadonlySet<PermissionKey>;
          }[]
        >;
      };
      readonly clock: Clock;
      readonly ids: IdGenerator;
    },
  ) {}

  async handle(event: DomainEvent, tx: TransactionScope): Promise<void> {
    if (event.tenantId === null) return;
    const scope: TenantContext = { tenantId: event.tenantId as never, botInstanceId: null };
    const payload = EVENT_PAYLOAD_SCHEMAS.ServiceRefundRequested.parse(event.payload);
    const request = await this.deps.requests.findById(scope, payload.requestId, tx);
    // Decided before the relay reached it: nothing is left to review.
    if (request === null || request.state !== 'OPEN') return;

    const reviewers = await this.deps.reviewers.reviewers(
      scope,
      'refunds.issue',
      event.correlationId as CorrelationId,
      tx,
    );
    const now = this.deps.clock.now();
    for (const reviewer of reviewers) {
      /* istanbul ignore next -- `listTelegramBound` selects only bound rows. */
      if (reviewer.admin.telegramUserId === null) continue;
      if (!mayBePushedRefundRequests(reviewer.permissions)) continue;
      await this.deps.pushes.enqueue(
        scope,
        {
          id: this.deps.ids.uuid(),
          requestId: request.id,
          adminId: reviewer.admin.id as AdminId,
          // The bot the customer filed through: the administrators' conversation with it.
          botInstanceId: request.botInstanceId as BotInstanceId,
        },
        now,
        tx,
      );
    }
  }
}
