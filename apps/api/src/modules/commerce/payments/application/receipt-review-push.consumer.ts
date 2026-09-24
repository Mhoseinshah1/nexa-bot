import {
  EVENT_PAYLOAD_SCHEMAS,
  type AdminId,
  type Clock,
  type CorrelationId,
  type DomainEvent,
  type EventType,
  type IdGenerator,
  type PaymentId,
  type PaymentReceiptId,
  type PermissionKey,
  type TenantContext,
} from '@nexa/contracts';
import type { EventConsumer } from '../../../platform/eventing/application/event-consumer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { PaymentRepository } from './ports.js';
import type { PaymentReceiptRepository } from './receipt-ports.js';
import type { ReceiptReviewPushRepository } from './receipt-review-push-ports.js';

/** The permission that decides who is pushed a receipt: the one that decides it. */
export const RECEIPT_PUSH_PERMISSION: PermissionKey = 'receipts.review';
/**
 * And the one that reads the FILE. `PERMISSION_REQUIRES` makes `receipts.review` imply
 * `payments.view`, not `receipts.view`, so a role may hold the decision without the evidence;
 * the pull item refuses that administrator the file (`reviewItem`), and the push must too.
 */
export const RECEIPT_PUSH_VIEW_PERMISSION: PermissionKey = 'receipts.view';

/** Whether a resolved authority may be pushed a receipt: both keys, never one. */
export function mayBePushedReceipts(permissions: ReadonlySet<PermissionKey>): boolean {
  return permissions.has(RECEIPT_PUSH_PERMISSION) && permissions.has(RECEIPT_PUSH_VIEW_PERMISSION);
}

/**
 * Who is told a receipt arrived: the fan-out half of the administrators' receipt push
 * (WP10 follow-up §3, ADR-0031).
 *
 * A CONSUMER of `PaymentReceiptSubmitted`, so it runs in the outbox relay's transaction, after
 * the receipt committed and never inside the transaction that filed it — nothing here can cost
 * a customer their receipt. It does database work only (`EventConsumer` forbids a network call
 * in here); the send is the push lane's.
 *
 * WHO is decided now, from the rows as they stand: every administrator of THIS tenant with a
 * Telegram binding whose resolved authority holds `receipts.review` AND `receipts.view` (the
 * file is the message) — the resolver gives a
 * disabled administrator nothing, and roles, grants, denials and expired overrides are its
 * rule, not a copy of it here. The push lane asks again immediately before each send.
 *
 * Idempotent twice over: the relay's `processed_messages` claim, and the row's unique key on
 * (tenant, receipt, administrator) — a replay whose claim was lost still writes nothing new.
 */
export class ReceiptReviewPushConsumer implements EventConsumer {
  /** Stable: it is the key in `processed_messages`. */
  readonly name = 'payments.receipt-review-push';
  readonly subscribesTo: readonly EventType[] = ['PaymentReceiptSubmitted'];

  constructor(
    private readonly deps: {
      readonly pushes: Pick<ReceiptReviewPushRepository, 'enqueue'>;
      readonly payments: Pick<PaymentRepository, 'findById'>;
      readonly receipts: Pick<PaymentReceiptRepository, 'findById'>;
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
    // A receipt is always a tenant's; a platform-scoped copy has nobody to tell.
    if (event.tenantId === null) return;
    const scope: TenantContext = { tenantId: event.tenantId as never, botInstanceId: null };
    const payload = EVENT_PAYLOAD_SCHEMAS.PaymentReceiptSubmitted.parse(event.payload);
    const paymentId = payload.paymentId as PaymentId;

    const payment = await this.deps.payments.findById(scope, paymentId, tx);
    // Decided before the relay reached it: there is nothing left to review, so nobody is told.
    if (payment === null || payment.state !== 'PENDING' || payment.method !== 'MANUAL_TRANSFER') {
      return;
    }
    const receipt = await this.deps.receipts.findById(
      scope,
      payload.receiptId as PaymentReceiptId,
      tx,
    );
    if (receipt === null || receipt.paymentId !== payment.id) return;

    const reviewers = await this.deps.reviewers.reviewers(
      scope,
      RECEIPT_PUSH_PERMISSION,
      event.correlationId as CorrelationId,
      tx,
    );
    const now = this.deps.clock.now();
    for (const reviewer of reviewers) {
      /* istanbul ignore next -- `listTelegramBound` selects only bound rows. */
      if (reviewer.admin.telegramUserId === null) continue;
      if (!mayBePushedReceipts(reviewer.permissions)) continue;
      await this.deps.pushes.enqueue(
        scope,
        {
          id: this.deps.ids.uuid(),
          paymentId: payment.id,
          receiptId: receipt.id,
          adminId: reviewer.admin.id as AdminId,
          // The bot that RECEIVED the file: a `file_id` belongs to it.
          botInstanceId: receipt.botInstanceId,
        },
        now,
        tx,
      );
    }
  }
}
