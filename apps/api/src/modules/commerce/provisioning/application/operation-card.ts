import type {
  BotInstanceId,
  Clock,
  OperationType,
  TemplateKey,
  TemplateValues,
  TenantContext,
  UnitOfWork,
  UserId,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  CustomerButton,
  CustomerMessenger,
  CustomerSendResult,
} from '../../messaging/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';

/**
 * R3 (v0.3.5 real-test fixes, item 10): the service card a customer disabled or enabled
 * their service from, and the one place the result is shown — on that card.
 *
 * A disable and an enable are provider mutations, so they stay operations: planned by the
 * tap, performed by the provisioner, with every rule the operation model already holds
 * (idempotent retries, no success claimed for a call that did not certainly land). What
 * changes is only how the customer is answered. Before, the tap sent «درخواست شما ثبت شد
 * و در حال اعمال روی سرور است» and the lane later sent «درخواست شما با موفقیت روی سرور
 * اعمال شد» — two messages about a switch. Now the tap sends nothing, and a SUCCEEDED
 * operation edits the card it was asked from: 🟢 ↔ 🔴, with the switch button turned
 * round. A failure is still told through the lane (`SERVICE_ACTION_FAILED`), and the card
 * is left exactly as it was, because nothing changed.
 */

/** Which Telegram message a request was made from: the card, as the bot that drew it. */
export interface CardMessageRef {
  readonly botInstanceId: BotInstanceId;
  readonly chatId: string;
  readonly messageId: number;
}

/**
 * The operation types whose success is answered ON the card. SUSPEND and RESUME only:
 * they change what the card SAYS (the state line and the switch), and nothing else to
 * report. A rotation's answer is the new link and files (`DeliveryService`); a renewal's
 * is its own result message.
 */
export const CARD_ANSWERED_OPERATIONS: readonly OperationType[] = ['SUSPEND', 'RESUME'];

/** A card claimed for its one answer. */
export interface ClaimedCard extends CardMessageRef {
  readonly operationId: string;
  readonly serviceId: string;
  readonly customerId: UserId;
}

export interface OperationCardRepository {
  /**
   * Records the card beside a NEWLY planned operation, in the planning transaction. A
   * second card for the same operation is ignored: the first tap's card is the one.
   */
  attach(
    scope: TenantContext,
    operationId: string,
    card: CardMessageRef,
    now: Date,
    tx: TransactionScope,
  ): Promise<void>;

  /** Whether this operation was asked from a card — the announcer's question. */
  hasCard(scope: TenantContext, operationId: string, tx?: TransactionScope): Promise<boolean>;

  /**
   * Takes the card's one answer: a conditional UPDATE of `answered_at` from NULL, only
   * for a SUCCEEDED `CARD_ANSWERED_OPERATIONS` operation a customer requested. Null when
   * there is nothing to answer, or another replica took it first.
   */
  claim(
    scope: TenantContext,
    operationId: string,
    now: Date,
    tx: TransactionScope,
  ): Promise<ClaimedCard | null>;

  /** Gives a claim back — ONLY after Telegram declined to look at the edit (429). */
  release(scope: TenantContext, operationId: string, tx: TransactionScope): Promise<void>;

  /** Cards of SUCCEEDED operations nobody answered, completed before `before`. */
  dueForAnswer(
    scope: TenantContext,
    before: Date,
    limit: number,
    tx: TransactionScope,
  ): Promise<readonly string[]>;
}

/** The customer's own service card, as the bot draws it — or null when it is not theirs. */
export interface ServiceCardRenderer {
  cardFor(
    scope: TenantContext,
    customerId: UserId,
    serviceId: string,
  ): Promise<{
    readonly key: TemplateKey;
    readonly values: TemplateValues;
    readonly buttons: readonly CustomerButton[];
  } | null>;
}

/** How one card answer ended, for the loop's log and a test. */
export type CardAnswer =
  'NONE' | 'EDITED' | 'SENT' | 'UNKNOWN' | 'REFUSED' | 'RETRY' | 'GONE' | 'INACTIVE';

/**
 * How long a SUCCEEDED operation is left to the loop's own call before the sweep takes
 * its card. The loop answers within the same tick; this is for a crash between the
 * operation's transaction and that call, like `ANNOUNCE_GRACE_MS`.
 */
export const CARD_ANSWER_GRACE_MS = 60_000;

export interface OperationCardEditorDeps {
  readonly cards: OperationCardRepository;
  readonly renderer: ServiceCardRenderer;
  readonly messenger: Pick<CustomerMessenger, 'send' | 'edit'>;
  readonly scopeActivity: ScopeActivityReader;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly clock: Clock;
}

/**
 * Edits the card an operation was asked from, once, after it SUCCEEDED.
 *
 * Driven by `ProvisionerLoop` beside the announcer, in the provisioner process, so the
 * customer sees the switch flip within one tick of the panel answering — the customer
 * notification lane runs once a minute in another process, which is too slow for a
 * switch the customer is looking at.
 *
 * ## Told once, and never a lie
 *
 * The claim is committed BEFORE the edit, like `markSendStarted`: two replicas cannot
 * both edit, and neither can both fall back to sending the card. The card is rendered
 * from the database at the moment of the edit — the state the operation left, and the
 * buttons that state and the panel's capabilities allow now — so a later change is
 * never overwritten with an older one.
 *
 * - An edit Telegram cannot make (the message was deleted, or is too old) falls back to
 *   sending the same card ONCE as a new message. That is the one fallback, documented in
 *   `docs/r3-service-card-audit.md`.
 * - A 429 gives the claim back; the sweep tries again after the grace.
 * - An UNKNOWN edit is not retried: it may have landed, and the card on the customer's
 *   screen is re-drawn by their next tap either way.
 *
 * ## The tenant gate
 *
 * Asked before the claim, as `DeliveryService` asks it before a send: a stopped tenant's
 * customers stop hearing from it. The row stays unanswered, and the sweep answers it if
 * the tenant starts again.
 */
export class OperationCardEditor {
  constructor(private readonly deps: OperationCardEditorDeps) {}

  async answer(scope: TenantContext, operationId: string): Promise<CardAnswer> {
    // One transaction: the tenant gate, then the claim — so a stopped tenant claims nothing.
    const claimed = await this.deps.uow.run(scope, async (tx) =>
      (await this.deps.scopeActivity.scopeIsActive(scope, tx))
        ? this.deps.cards.claim(scope, operationId, this.deps.clock.now(), tx)
        : ('INACTIVE' as const),
    );
    if (claimed === 'INACTIVE') return 'INACTIVE';
    if (claimed === null) return 'NONE';

    const card = await this.deps.renderer.cardFor(scope, claimed.customerId, claimed.serviceId);
    // No longer the customer's to see (refunded, moved to someone else): nothing to draw.
    if (card === null) return 'GONE';

    const content = { templateKey: card.key, values: card.values, buttons: card.buttons };
    const edited: CustomerSendResult | null =
      this.deps.messenger.edit === undefined
        ? null
        : await this.deps.messenger.edit(scope, {
            chatId: claimed.chatId,
            messageId: claimed.messageId,
            botInstanceId: claimed.botInstanceId,
            ...content,
          });
    if (edited !== null && edited.outcome === 'DELIVERED') return 'EDITED';
    if (edited !== null && edited.outcome === 'UNKNOWN') return 'UNKNOWN';
    if (edited !== null && edited.outcome === 'RATE_LIMITED') {
      await this.deps.uow.run(scope, async (tx) => this.deps.cards.release(scope, operationId, tx));
      return 'RETRY';
    }
    /*
     * The one fallback: the card could not be edited (deleted, too old, not a text
     * message), so it is sent once as a new message, carrying the same state and buttons.
     */
    const sent = await this.deps.messenger.send(scope, {
      chatId: claimed.chatId,
      botInstanceId: claimed.botInstanceId,
      templateKey: card.key,
      values: card.values,
      ...(card.buttons.length === 0 ? {} : { buttons: card.buttons }),
    });
    if (sent.outcome === 'RATE_LIMITED') {
      await this.deps.uow.run(scope, async (tx) => this.deps.cards.release(scope, operationId, tx));
      return 'RETRY';
    }
    return sent.outcome === 'DELIVERED'
      ? 'SENT'
      : sent.outcome === 'UNKNOWN'
        ? 'UNKNOWN'
        : 'REFUSED';
  }

  /**
   * The cards a crash left unanswered. Bounded, one transaction each through `answer`,
   * and one failure does not end the batch — `announceDue`'s shape, for its reasons.
   */
  async answerDue(scope: TenantContext, limit: number): Promise<number> {
    const before = new Date(this.deps.clock.now().getTime() - CARD_ANSWER_GRACE_MS);
    const due = await this.deps.uow.run(scope, async (tx) =>
      this.deps.cards.dueForAnswer(scope, before, limit, tx),
    );
    let failure: unknown = null;
    let answered = 0;
    for (const operationId of due) {
      try {
        if ((await this.answer(scope, operationId)) !== 'NONE') answered += 1;
      } catch (error: unknown) {
        if (failure === null) failure = error;
      }
    }
    if (failure !== null) throw failure;
    return answered;
  }
}
