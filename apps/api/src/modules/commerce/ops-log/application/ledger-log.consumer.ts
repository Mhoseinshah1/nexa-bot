import {
  EVENT_PAYLOAD_SCHEMAS,
  type DomainEvent,
  type EventType,
  type TenantContext,
} from '@nexa/contracts';
import type { EventConsumer } from '../../../platform/eventing/application/event-consumer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { isAdminActor, publish, scopeOf } from './publish.js';
import {
  massCredited,
  referralCommission,
  signupGift,
  walletAdjusted,
  type Built,
} from './presenters.js';
import type { LedgerEntryFact, OpsLogFacts, OpsLogLane, OpsLogWords } from './ports.js';

const SIGNUP_GIFT_REFERENCE = /^([0-9a-f-]{36}):signup-gift:(REFEREE|REFERRER)$/;

/**
 * The wallet movements the operations log group is told about (Round 4 PR-D): an
 * administrator raising or lowering a balance (L7), a referral commission (L8) and the
 * signup gift (L9).
 *
 * A CONSUMER of `WalletEntryRecorded`, so it runs after the money committed and in the
 * relay's own transaction — a log that cannot be written never touches the wallet. It reads
 * the LEDGER ENTRY the event names and derives both balances from the ledger up to that entry
 * (`balanceAround`): the figure is arithmetic over the append-only rows, so «قبل ← بعد» is
 * right for a credit, a debit and a gift, and a gift's balance is the real one rather than
 * the unchanged number the previous bot printed.
 *
 * Every other reason is ignored — a purchase has its own message, an opening balance
 * written by the import has none at all. A customer the import wrote is never logged for a
 * commission or a gift: a migration that mints a hundred thousand rows must not post a hundred
 * thousand lines.
 *
 * R8 A4: an ADMINISTRATOR's adjustment is logged whoever the customer is. Only
 * `WalletService.adjust` writes `ADMIN_CREDIT`/`ADMIN_DEBIT` — the import writes
 * `MIGRATION_OPENING_BALANCE` — so the entry is always an operator's act made after the
 * import, and an installation migrated from the previous bot (every customer imported) had
 * its every adjustment silently missing from the group. The message also says whether the
 * customer is told (the owner's two switches, read when the event is handled — the same
 * read `CustomerFactNoticeConsumer` makes) and carries «تراکنش» beside «پروفایل کاربر».
 *
 * A mass credit (`BulkOperationStateChanged` to COMPLETED or CANCELLED, kind WALLET_CREDIT)
 * is ONE summary message per operation, from the ledger entries its items name.
 */
export class LedgerLogConsumer implements EventConsumer {
  readonly name = 'ops-log.ledger';
  readonly subscribesTo: readonly EventType[] = [
    'WalletEntryRecorded',
    'BulkOperationStateChanged',
  ];

  constructor(
    private readonly deps: {
      readonly lane: OpsLogLane;
      readonly facts: OpsLogFacts;
      readonly words: OpsLogWords;
      /**
       * R8 A4: whether an administrator's adjustment of this reason is told to the customer
       * (the `wallet_admin_*_notice` switch). Absent: the line is left out, never guessed.
       */
      readonly customerNotified?: (
        scope: TenantContext,
        reason: 'ADMIN_CREDIT' | 'ADMIN_DEBIT',
        tx: TransactionScope,
      ) => Promise<boolean>;
    },
  ) {}

  async handle(event: DomainEvent, tx: TransactionScope): Promise<void> {
    const scope = scopeOf(event);
    if (scope === null) return;
    if (event.eventType === 'BulkOperationStateChanged') {
      await this.massCredit(scope, event, tx);
      return;
    }
    const payload = EVENT_PAYLOAD_SCHEMAS.WalletEntryRecorded.parse(event.payload);
    // Cheap exit before any read: most wallet movements are none of these three.
    if (
      payload.reason !== 'ADMIN_CREDIT' &&
      payload.reason !== 'ADMIN_DEBIT' &&
      payload.reason !== 'REFERRAL_COMMISSION' &&
      payload.reason !== 'REFERRAL_SIGNUP_GIFT'
    ) {
      return;
    }
    const entry = await this.deps.facts.ledgerEntry(scope, payload.entryId, tx);
    if (entry === null) return;
    const at = new Date(event.occurredAt);

    let built: Built | null;
    if (entry.reason === 'ADMIN_CREDIT' || entry.reason === 'ADMIN_DEBIT') {
      built = await this.adjusted(scope, event, entry, at, tx);
    } else if (entry.reason === 'REFERRAL_COMMISSION') {
      built = await this.commission(scope, entry, at, tx);
    } else {
      built = await this.gift(scope, entry, at, tx);
    }
    if (built === null) return;
    await publish(this.deps.lane, scope, tx, built, {
      dedupeKey: `oplog:ledger:${entry.id}`,
      correlationId: event.correlationId,
    });
  }

  private async adjusted(
    scope: TenantContext,
    event: DomainEvent,
    entry: LedgerEntryFact,
    at: Date,
    tx: TransactionScope,
  ): Promise<Built | null> {
    // Imported customers included (see the class comment): only an operator writes this reason.
    const customer = await this.deps.facts.customer(scope, entry.customerId, tx);
    if (customer === null) return null;
    const balance = await this.deps.facts.balanceAround(
      scope,
      entry.customerId,
      entry.amount.currency,
      [entry.id],
      tx,
    );
    if (balance === null) return null;
    const adminId = entry.actorAdminId ?? (isAdminActor(event.actor.type) ? event.actor.id : null);
    const admin = adminId === null ? null : await this.deps.facts.admin(scope, adminId, tx);
    const customerNotified =
      this.deps.customerNotified === undefined
        ? undefined
        : await this.deps.customerNotified(
            scope,
            entry.reason === 'ADMIN_DEBIT' ? 'ADMIN_DEBIT' : 'ADMIN_CREDIT',
            tx,
          );
    return walletAdjusted({
      entry,
      balance,
      customer,
      admin,
      at,
      words: this.deps.words,
      ...(customerNotified === undefined ? {} : { customerNotified }),
    });
  }

  private async massCredit(
    scope: TenantContext,
    event: DomainEvent,
    tx: TransactionScope,
  ): Promise<void> {
    const payload = EVENT_PAYLOAD_SCHEMAS.BulkOperationStateChanged.parse(event.payload);
    if (payload.kind !== 'WALLET_CREDIT') return;
    if (payload.to !== 'COMPLETED' && payload.to !== 'CANCELLED') return;
    const fact = await this.deps.facts.massCredit(scope, payload.operationId, tx);
    if (fact === null) return;
    const admin = await this.deps.facts.admin(scope, fact.createdByAdminId, tx);
    const built = massCredited({
      fact,
      admin,
      at: new Date(event.occurredAt),
      words: this.deps.words,
    });
    await publish(this.deps.lane, scope, tx, built, {
      // One message per operation, whichever of its terminal events arrives.
      dedupeKey: `oplog:mass-credit:${fact.id}`,
      correlationId: event.correlationId,
    });
  }

  private async commission(
    scope: TenantContext,
    entry: LedgerEntryFact,
    at: Date,
    tx: TransactionScope,
  ): Promise<Built | null> {
    const referrer = await this.deps.facts.customer(scope, entry.customerId, tx);
    if (referrer === null || referrer.source !== 'NEXA') return null;
    const order =
      entry.orderId === null ? null : await this.deps.facts.order(scope, entry.orderId, tx);
    if (order !== null && order.origin !== 'STANDARD') return null;
    const buyer =
      order === null ? null : await this.deps.facts.customer(scope, order.customerId, tx);
    const payment =
      entry.paymentId === null ? null : await this.deps.facts.payment(scope, entry.paymentId, tx);
    const balance = await this.deps.facts.balanceAround(
      scope,
      entry.customerId,
      entry.amount.currency,
      [entry.id],
      tx,
    );
    if (balance === null) return null;
    return referralCommission({
      entry,
      balance,
      referrer,
      buyer,
      order,
      payment,
      at,
      words: this.deps.words,
    });
  }

  private async gift(
    scope: TenantContext,
    entry: LedgerEntryFact,
    at: Date,
    tx: TransactionScope,
  ): Promise<Built | null> {
    const match = SIGNUP_GIFT_REFERENCE.exec(entry.reference);
    if (match === null) return null;
    const referral = await this.deps.facts.referralOf(scope, match[1] as string, tx);
    if (referral === null) return null;
    const referee = await this.deps.facts.customer(scope, referral.refereeId, tx);
    const referrer = await this.deps.facts.customer(scope, referral.referrerId, tx);
    if (referee === null || referee.source !== 'NEXA') return null;

    // Each side's wallet around ITS OWN gift entry, if that side has received it. The side
    // this event is about is the one just written; the other may have been paid earlier, or
    // not yet — its block then shows who it is and nothing about a balance it has not got.
    const sideBalance = async (side: 'REFEREE' | 'REFERRER', customerId: string) => {
      const own =
        side === (match[2] as string)
          ? entry
          : await this.deps.facts.ledgerEntryByReference(
              scope,
              `${match[1] as string}:signup-gift:${side}`,
              tx,
            );
      if (own === null) return null;
      return this.deps.facts.balanceAround(scope, customerId, own.amount.currency, [own.id], tx);
    };
    return signupGift({
      referee: {
        customer: referee,
        balance: await sideBalance('REFEREE', referral.refereeId),
      },
      referrer: {
        customer: referrer,
        balance: await sideBalance('REFERRER', referral.referrerId),
      },
      at,
      words: this.deps.words,
    });
  }
}
