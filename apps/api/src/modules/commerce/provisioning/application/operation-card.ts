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
 * round.
 *
 * Round N (F4, `docs/n-service-ux-audit.md`): this is THE service card's message identity
 * and answer — the one mechanism, extended rather than joined by a second. The tap turns the
 * card «working» before the operation is planned (so nothing later can overwrite a final
 * answer with a loading one); a disable, an enable or a link change that ENDS without
 * happening is answered here too, the card redrawn as the service still is with
 * `bot.service.notice_action_failed` (the lane's separate failure message is no longer
 * sent for a request that has a card); and a link change's SUCCESS is answered on the same
 * card by the delivery lane, which takes it through `claimRotationCard`. A change whose
 * outcome is `UNKNOWN` is not answered until it is reconciled to a terminal state: the card
 * reads «working» until then, and never claims success or failure it does not know.
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

/**
 * Round N (F4): the operation types whose FAILURE is answered on the card they were asked
 * from. The tap turned the card into «working» (`bot.service.state_working`) with no
 * action buttons, so the card itself must come back when the change ends without
 * happening — as the service still is, with `bot.service.notice_action_failed` — rather
 * than stay «working» beside a separate failure message. A rotation's SUCCESS is not here:
 * the delivery lane answers it with the new link, on the same card (`claimRotationCard`).
 */
export const CARD_FAILURE_ANSWERED_OPERATIONS: readonly OperationType[] = [
  'SUSPEND',
  'RESUME',
  'ROTATE_SUBSCRIPTION',
];

/** A card claimed for its one answer. */
export interface ClaimedCard extends CardMessageRef {
  readonly operationId: string;
  /** Round N (F4): what the card is answering — the change happened, or definitely did not. */
  readonly outcome: 'SUCCEEDED' | 'FAILED';
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
   * for a SUCCEEDED `CARD_ANSWERED_OPERATIONS` operation a customer requested, and only
   * once `next_attempt_at` (a 429's wait) has passed at `now`. Null when there is nothing
   * to answer, it is not due yet, or another replica took it first.
   */
  claim(
    scope: TenantContext,
    operationId: string,
    now: Date,
    tx: TransactionScope,
  ): Promise<ClaimedCard | null>;

  /**
   * Gives a claim back — ONLY after Telegram declined to look at the edit (429) — and
   * holds it until `retryAt`, so neither the loop nor the sweep asks again sooner.
   */
  release(
    scope: TenantContext,
    operationId: string,
    retryAt: Date,
    tx: TransactionScope,
  ): Promise<void>;

  /**
   * Round N (F4): the card of the service's latest successful customer link change, taken
   * for its one answer (a conditional UPDATE of `answered_at` from NULL) by the delivery
   * lane that is about to deliver the new link — so the link lands ON the card. Null when
   * the change was not asked from a card, or its card is already answered.
   */
  claimRotationCard(
    scope: TenantContext,
    serviceId: string,
    now: Date,
    tx: TransactionScope,
  ): Promise<(CardMessageRef & { readonly operationId: string }) | null>;

  /**
   * Cards of answerable operations (a success, or since round N a terminal failure) nobody
   * answered, completed before `before`, whose `next_attempt_at` is not after `now`.
   */
  dueForAnswer(
    scope: TenantContext,
    before: Date,
    now: Date,
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
    /** Round N (F4): a one-line notice under the card's status. */
    notice?: TemplateKey,
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

/**
 * How long a card waits after Telegram answered 429: its own `retry_after`, never less
 * than the floor (so a zero or tiny value cannot become a loop on the next tick), never
 * more than the ceiling (so a hostile or garbled value cannot park a card for days), and
 * the default when Telegram named no wait at all.
 */
export const CARD_RETRY_FLOOR_MS = 10_000;
export const CARD_RETRY_DEFAULT_MS = 60_000;
export const CARD_RETRY_CEILING_MS = 60 * 60_000;

export function cardRetryDelayMs(retryAfterMs: number | undefined): number {
  const asked =
    retryAfterMs === undefined || !Number.isFinite(retryAfterMs)
      ? CARD_RETRY_DEFAULT_MS
      : retryAfterMs;
  return Math.min(CARD_RETRY_CEILING_MS, Math.max(CARD_RETRY_FLOOR_MS, asked));
}

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

    /*
     * Round N (F4): a change that definitely did not happen is told ON the card — the service
     * as it still is, with the notice — instead of in a separate message; the announcer
     * stamps it without one (`answeredElsewhere`).
     */
    const card = await this.deps.renderer.cardFor(
      scope,
      claimed.customerId,
      claimed.serviceId,
      claimed.outcome === 'FAILED' ? 'bot.service.notice_action_failed' : undefined,
    );
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
      await this.holdAfterRateLimit(scope, operationId, edited.retryAfterMs);
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
      await this.holdAfterRateLimit(scope, operationId, sent.retryAfterMs);
      return 'RETRY';
    }
    return sent.outcome === 'DELIVERED'
      ? 'SENT'
      : sent.outcome === 'UNKNOWN'
        ? 'UNKNOWN'
        : 'REFUSED';
  }

  /**
   * A 429 is Telegram declining to look, so the claim is given back — with the wait it
   * asked for, bounded (`cardRetryDelayMs`). Without the wait the sweep would re-select
   * the card on the next tick, seconds later, and ask a rate-limited bot again.
   */
  private async holdAfterRateLimit(
    scope: TenantContext,
    operationId: string,
    retryAfterMs: number | undefined,
  ): Promise<void> {
    const retryAt = new Date(this.deps.clock.now().getTime() + cardRetryDelayMs(retryAfterMs));
    await this.deps.uow.run(scope, async (tx) =>
      this.deps.cards.release(scope, operationId, retryAt, tx),
    );
  }

  /**
   * The cards a crash left unanswered. Bounded, one transaction each through `answer`,
   * and one failure does not end the batch — `announceDue`'s shape, for its reasons.
   */
  async answerDue(scope: TenantContext, limit: number): Promise<number> {
    const now = this.deps.clock.now();
    const before = new Date(now.getTime() - CARD_ANSWER_GRACE_MS);
    const due = await this.deps.uow.run(scope, async (tx) =>
      this.deps.cards.dueForAnswer(scope, before, now, limit, tx),
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
