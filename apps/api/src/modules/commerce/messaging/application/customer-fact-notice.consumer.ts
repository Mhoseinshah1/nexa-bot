import type {
  CustomerNotificationKind,
  DomainEvent,
  EventType,
  FeatureFlagKey,
  TenantContext,
  UserId,
} from '@nexa/contracts';
import type { EventConsumer } from '../../../platform/eventing/application/event-consumer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { FeatureFlagResolver } from '../../../control/features/application/feature-flags.service.js';
import type { CustomerNotifier } from './customer-notifier.js';

/**
 * R4 A5 — the customer is told when an ADMINISTRATOR moved their money by hand, and when their
 * block was lifted. A consumer of the outbox, so the message exists only once the fact
 * committed, and what it writes — one `customer_notifications` row — commits with the relay's
 * claim on the event (`EventConsumer`): a redelivered event finds the claim and does nothing,
 * and `customer_notifications_subject_key` makes the row told-once besides.
 *
 * ## Which ledger movements, and only those
 *
 * `WalletEntryRecorded` is emitted for EVERY movement — a purchase, a refund, a commission, an
 * imported opening balance (`MIGRATION_OPENING_BALANCE`). Exactly two reasons are told here,
 * `ADMIN_CREDIT` and `ADMIN_DEBIT`, the two `WalletService.adjust` writes and nothing else
 * does; every other reason, the import's above all, is ignored by this ALLOW-list, never by a
 * deny-list a new reason could slip past. Each direction has the owner's toggle (default ON),
 * read when the event is handled: switched off, the event is consumed and nothing is queued.
 *
 * ## What it carries
 *
 * A kind and a subject id, no payload (ADR 0030 §1): the ledger entry for an adjustment — the
 * dispatcher reads its amount, the balance right after it and, only when the operator ticked
 * «نمایش دلیل به مشتری», its note — and the `CustomerUnblocked` event itself for an unblock,
 * whose sentence has no value at all. One event per unblock, so each unblock is told once.
 */
export const WALLET_ADMIN_NOTICE: Readonly<
  Record<string, { readonly kind: CustomerNotificationKind; readonly flag: FeatureFlagKey }>
> = {
  ADMIN_CREDIT: { kind: 'WALLET_ADMIN_CREDITED', flag: 'wallet_admin_credit_notice' },
  ADMIN_DEBIT: { kind: 'WALLET_ADMIN_DEBITED', flag: 'wallet_admin_debit_notice' },
};

export class CustomerFactNoticeConsumer implements EventConsumer {
  readonly name = 'messaging.customer_fact_notices';
  readonly subscribesTo: readonly EventType[] = ['WalletEntryRecorded', 'CustomerUnblocked'];

  constructor(
    private readonly deps: {
      readonly notifier: Pick<CustomerNotifier, 'notify'>;
      readonly flags: Pick<FeatureFlagResolver, 'isEnabled'>;
      readonly clock: { now(): Date };
    },
  ) {}

  async handle(event: DomainEvent, tx: TransactionScope): Promise<void> {
    if (event.tenantId === null) return;
    const scope: TenantContext = { tenantId: event.tenantId as never, botInstanceId: null };
    if (event.eventType === 'WalletEntryRecorded') {
      const payload = (event.payload ?? {}) as {
        readonly reason?: unknown;
        readonly entryId?: unknown;
        readonly customerId?: unknown;
      };
      if (
        typeof payload.reason !== 'string' ||
        !Object.hasOwn(WALLET_ADMIN_NOTICE, payload.reason)
      ) {
        return;
      }
      const notice = WALLET_ADMIN_NOTICE[payload.reason];
      if (
        notice === undefined ||
        typeof payload.entryId !== 'string' ||
        typeof payload.customerId !== 'string'
      ) {
        return;
      }
      if (!(await this.deps.flags.isEnabled(scope, notice.flag, tx))) return;
      await this.deps.notifier.notify(
        scope,
        payload.customerId as UserId,
        notice.kind,
        payload.entryId,
        this.deps.clock.now(),
        tx,
      );
      return;
    }
    if (event.eventType === 'CustomerUnblocked') {
      await this.deps.notifier.notify(
        scope,
        event.aggregateId as UserId,
        'ACCOUNT_UNBLOCKED',
        event.eventId,
        this.deps.clock.now(),
        tx,
      );
    }
  }
}
