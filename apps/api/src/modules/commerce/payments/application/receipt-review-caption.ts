import type {
  ActorContext,
  CurrencyCode,
  OrderId,
  OrderPurpose,
  PermissionKey,
  TemplateKey,
  TemplateValues,
  TenantContext,
  UserId,
} from '@nexa/contracts';
import { money } from '@nexa/contracts';
import type { CustomerRecord } from '../../customers/application/ports.js';
import type { PaymentRecord } from './ports.js';
import type { PaymentReceiptRecord } from './receipt-ports.js';

/**
 * How much of the customer's own receipt caption a reviewer's caption carries.
 *
 * Telegram refuses a media caption over 1,024 characters (`TELEGRAM_CAPTION_MAX`), and a
 * customer's caption alone may be that long (`RECEIPT_CAPTION_MAX_LENGTH`). Six hundred
 * code points leaves the facts above it room under any sane rendering; the transport still
 * cuts a plain-text caption that ends up over the bound, and the note is rendered LAST, so a
 * cut costs the end of the note rather than a fact.
 */
export const RECEIPT_REVIEW_NOTE_MAX = 600;

/** A dash for a fact there is none of. */
export const REVIEW_NONE = '—';

/**
 * The customer's receipt caption as a reviewer's caption carries it: bounded to
 * `RECEIPT_REVIEW_NOTE_MAX` code points with an ellipsis, or a dash when there is none.
 * Code points, so an emoji is never split into half a surrogate pair.
 */
export function reviewNoteOf(caption: string | null): string {
  if (caption === null || caption.trim() === '') return REVIEW_NONE;
  const points = Array.from(caption);
  return points.length <= RECEIPT_REVIEW_NOTE_MAX
    ? caption
    : `${points.slice(0, RECEIPT_REVIEW_NOTE_MAX - 1).join('')}…`;
}

/** The order-side facts, from the order's frozen snapshot. Null for a wallet top-up. */
export interface ReceiptReviewFacts {
  readonly purpose: OrderPurpose | null;
  readonly productTitle: string | null;
  readonly durationDays: number | null;
  readonly trafficBytes: bigint | null;
  readonly serviceUsername: string | null;
}

export interface ReceiptReviewFactsReader {
  factsFor(
    scope: TenantContext,
    orderId: OrderId | null,
    tx?: unknown,
  ): Promise<ReceiptReviewFacts>;
}

/** The permission the wallet balance read charges anywhere else (`WalletService.balance`). */
export const RECEIPT_REVIEW_BALANCE_PERMISSION: PermissionKey = 'users.view';

const OPERATION_LABELS: Readonly<Record<OrderPurpose | 'TOPUP', TemplateKey>> = {
  NEW_SERVICE: 'bot.admin.operation_new_service',
  RENEW: 'bot.admin.operation_renew',
  ADD_TRAFFIC: 'bot.admin.operation_add_traffic',
  ADD_TIME: 'bot.admin.operation_add_time',
  // A trial is a GRANT and never has a payment; the label exists so this table is total.
  TRIAL: 'bot.admin.operation_new_service',
  TOPUP: 'bot.admin.operation_topup',
};

export interface ReceiptReviewCaptionDeps {
  readonly facts: ReceiptReviewFactsReader;
  /** The ledger SUM, read-only and unlocked: a caption never waits on a disposition. */
  readonly balances: {
    balanceOf(
      scope: TenantContext,
      customerId: UserId,
      currency: CurrencyCode,
      tx?: unknown,
    ): Promise<{ readonly amountMinor: bigint }>;
  };
  /** The one resolution rule, answered without recording a denial. */
  readonly guard: {
    has(
      scope: TenantContext,
      actor: ActorContext,
      permission: PermissionKey,
      tx?: unknown,
    ): Promise<boolean>;
  };
  /** Renders one catalogue label through the tenant's overrides. */
  readonly labels: {
    render(scope: TenantContext, key: TemplateKey, values: TemplateValues): Promise<string>;
  };
}

/**
 * The values of `bot.admin.receipt` for ONE reviewer — the ONE builder the pull item and the
 * push both use (`docs/wp10-followup-audit.md` §6). Two copies of this would be two answers
 * to "what does a reviewer see about a payment", and the copy nobody looks at is the one the
 * worker sends unattended.
 *
 * File 01 §4, field by field, and nothing invented: where there is no source, a dash. No
 * subscription link, no credential, no card number and no `file_id` is ever read here.
 *
 * The balance is shown only to a viewer holding `users.view` — the key the wallet read
 * charges — because the seeded `receipt_reviewer` does not hold it, and a caption must not be
 * a way round a permission.
 */
export class ReceiptReviewCaption {
  constructor(private readonly deps: ReceiptReviewCaptionDeps) {}

  async valuesFor(
    scope: TenantContext,
    viewer: ActorContext,
    payment: PaymentRecord,
    customer: CustomerRecord | null,
    receipts: readonly PaymentReceiptRecord[],
  ): Promise<TemplateValues> {
    const facts = await this.deps.facts.factsFor(scope, payment.orderId);
    const operation = await this.deps.labels.render(
      scope,
      OPERATION_LABELS[payment.orderId === null ? 'TOPUP' : (facts.purpose ?? 'NEW_SERVICE')],
      {},
    );
    const username = customer?.username ?? null;
    const name = [customer?.firstName ?? null, customer?.lastName ?? null]
      .filter((part): part is string => part !== null && part.trim() !== '')
      .join(' ');

    let balance = REVIEW_NONE;
    if (await this.deps.guard.has(scope, viewer, RECEIPT_REVIEW_BALANCE_PERMISSION)) {
      const held = await this.deps.balances.balanceOf(
        scope,
        payment.customerId,
        payment.amount.currency,
      );
      balance = await this.deps.labels.render(scope, 'bot.admin.receipt_balance', {
        balance: money(held.amountMinor, payment.amount.currency),
      });
    }

    return {
      reference: payment.reference,
      total: payment.amount,
      // The customer's Telegram id, which is the identity this installation holds for them,
      // and the username beside it when they have one — a name is chosen by the person it
      // names, so it is shown and never relied on.
      customer: customer?.telegramUserId ?? payment.customerId,
      username: username === null ? REVIEW_NONE : `@${username}`,
      name: name === '' ? REVIEW_NONE : name,
      operation,
      order: facts.productTitle ?? REVIEW_NONE,
      serviceUsername: facts.serviceUsername ?? REVIEW_NONE,
      durationDays: facts.durationDays ?? 0,
      trafficBytes: facts.trafficBytes ?? 0n,
      balance,
      // The customer's note: the first one they wrote, on whichever receipt carried it. A
      // second note on a later receipt is not repeated; the file it came with follows.
      note: reviewNoteOf(receipts.find((one) => one.caption !== null)?.caption ?? null),
    };
  }
}
