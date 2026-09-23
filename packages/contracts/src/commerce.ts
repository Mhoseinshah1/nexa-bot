import { z } from 'zod';
import type { StateMachineDefinition } from './state-machine.js';
import type { Money } from './money.js';
import type { PriceQuote } from './pricing.js';
import type { ProductId, PanelId } from './ids.js';
import type { ProductSpecification } from './catalog.js';

/**
 * The order — one commercial intent, and the history of what it became.
 *
 * ## Why these states and no more
 *
 * The legacy system mixes order lifecycle with panel-sync failure in a single
 * seven-value column, and `state-machine.ts` records that as the thing this encoding
 * exists to prevent. So the machine below says nothing about a provider: it ends at
 * `PAID`, and provisioning is a SEPARATE aggregate (`provisioning.ts`) with its own
 * states and its own retries.
 *
 * That boundary is the load-bearing decision in this file. An order that carried
 * provisioning states would have to move backwards when a provider call was retried,
 * and a commercial record that moves backwards is a commercial record an accountant
 * cannot read. Instead: the order reaches `PAID` once and stays there, and the
 * service it produced reports its own health.
 *
 * Six states, each of which a surface genuinely has to render differently:
 *
 * - `DRAFT` — the customer is looking at a summary. Nothing is owed.
 * - `AWAITING_PAYMENT` — confirmed by the customer, priced, and waiting for money.
 * - `PAID` — settled, and what was bought is being delivered or has been.
 * - `CANCELLED` — withdrawn before settlement, by the customer or an operator.
 * - `EXPIRED` — nobody withdrew it and nobody paid; the window closed.
 * - `REFUNDED` — the money went back. Terminal, and a ledger fact, never an edit.
 *
 * `EXPIRED` and `CANCELLED` are not merged. "The customer changed their mind" and
 * "we stopped waiting" are different facts about the same row, and a tenant looking at
 * abandonment rates needs them apart.
 *
 * ## Two outcomes for money that arrived, and no third
 *
 * A customer whose money this installation has taken ends in exactly one of two
 * places: they got what they bought, or they got the money back. There is no state
 * for "paid, undelivered, somebody will decide later".
 *
 * There used to be — `PAID_UNFULFILLED`, with an operator retry and a reassignment —
 * and the owner removed it. The argument for it was that an operator looking at a
 * stranded order should choose between delivering late and giving the money back;
 * what it produced was a queue that only grows while nobody is looking, a customer
 * with no answer and no money, and two surfaces that had to explain a third thing.
 * The replacement is not a policy an operator applies: a purchase this installation
 * cannot deliver is refunded to the customer's wallet, automatically, for the exact
 * amount, in the transaction that discovers it cannot be delivered.
 *
 * So a bank transfer whose panel filled up while the receipt sat in the queue is
 * CONFIRMED — the money really did move and pretending otherwise is what left it
 * `PENDING`, neither confirmable nor refundable — and then immediately reversed onto
 * the wallet. `AWAITING_PAYMENT -> REFUNDED` is that edge, and it carries the same
 * `settlementIsFunded` guard as `SETTLE`, because it is the same claim: money that
 * has really arrived is what makes either legal.
 *
 * A wallet purchase never reaches it. The debit is written in the same transaction,
 * so a refusal costs the customer nothing, and refusing is stricter: an installation
 * that cannot deliver does not take the money in the first place.
 */
export const ORDER_STATES = [
  'DRAFT',
  'AWAITING_PAYMENT',
  'PAID',
  'CANCELLED',
  'EXPIRED',
  'REFUNDED',
] as const;
export type OrderState = (typeof ORDER_STATES)[number];
export const orderStateSchema = z.enum(ORDER_STATES);

export const ORDER_TERMINAL_STATES = ['CANCELLED', 'EXPIRED', 'REFUNDED'] as const;

/**
 * The states that mean the money for this order has been received.
 *
 * For reconciliation and for every reader that asks "what did we take", which must
 * include an order whose money has since gone back: a refund is a second movement and
 * not an erasure of the first. `settled_at` is non-null exactly on these, and
 * `orders_settled_at_check` is built from this list so the constraint and the
 * predicate cannot drift apart.
 */
export const ORDER_SETTLED_STATES = ['PAID', 'REFUNDED'] as const;
export type OrderSettledState = (typeof ORDER_SETTLED_STATES)[number];

export const ORDER_EVENTS = ['CONFIRM', 'SETTLE', 'CANCEL', 'EXPIRE', 'REFUND', 'GRANT'] as const;
export type OrderEvent = (typeof ORDER_EVENTS)[number];

/**
 * The order machine.
 *
 * `PAID` is deliberately NOT terminal — a refund follows it — but it is the only
 * non-terminal state with no onward path other than refund, which is what makes
 * "settled" mean settled.
 *
 * There is no transition out of `PAID` back to `AWAITING_PAYMENT`. A settlement that
 * turns out to be wrong is a refund plus a new order, never a reopened one, because
 * the alternative is an order whose paid-at timestamp is a lie.
 */
export const ORDER_MACHINE: StateMachineDefinition<OrderState, OrderEvent> = {
  name: 'order',
  initial: 'DRAFT',
  states: ORDER_STATES,
  terminal: ORDER_TERMINAL_STATES,
  transitions: [
    { from: 'DRAFT', to: 'AWAITING_PAYMENT', on: 'CONFIRM' },
    { from: 'DRAFT', to: 'CANCELLED', on: 'CANCEL' },
    { from: 'DRAFT', to: 'EXPIRED', on: 'EXPIRE' },
    /*
     * The guard is named here and implemented in the module, per the `guard`
     * contract: an order settles only when the money backing it is real — a
     * confirmed payment or a committed wallet debit — and never because a client
     * said so. `client callback data is never trusted as price` is the same rule one
     * step earlier.
     */
    { from: 'AWAITING_PAYMENT', to: 'PAID', on: 'SETTLE', guard: 'settlementIsFunded' },
    /*
     * The same guard, and that is the point: money that has already moved is what
     * makes this edge legal, exactly as it makes `SETTLE` legal. What differs is
     * whether what it bought could be delivered — a question about a PANEL, never
     * about the payment.
     *
     * Reaching `REFUNDED` without passing through `PAID` is deliberate. `PAID` is
     * the state provisioning acts on, and an order that momentarily wore it would be
     * an order a provisioner could claim; the service would then be created for money
     * this transaction is in the middle of giving back. One edge, one commit, and no
     * window in which both are true.
     */
    {
      from: 'AWAITING_PAYMENT',
      to: 'REFUNDED',
      on: 'REFUND',
      guard: 'settlementIsFunded',
    },
    { from: 'AWAITING_PAYMENT', to: 'CANCELLED', on: 'CANCEL' },
    { from: 'AWAITING_PAYMENT', to: 'EXPIRED', on: 'EXPIRE' },
    { from: 'PAID', to: 'REFUNDED', on: 'REFUND' },
    /*
     * A trial: `PAID` without money, because nothing was asked for.
     *
     * `PAID` is the state provisioning acts on, and a trial has to be provisioned by
     * the same path a purchase is — the same capacity slot, the same eligibility
     * evaluator, the same `PROVISION` operation. The guard is what keeps this edge
     * from being a way round `settlementIsFunded`: it admits an order whose purpose is
     * `TRIAL` AND whose total is zero, and nothing else. A priced order has no edge to
     * `PAID` except through money. `docs/wp6-audit.md` A2.
     *
     * Its way out is the existing `PAID → REFUNDED`: a trial that could not be
     * delivered is given back in full, and in full is nothing. There is no third
     * outcome for it either.
     */
    { from: 'DRAFT', to: 'PAID', on: 'GRANT', guard: 'orderIsFreeTrial' },
  ],
};

/**
 * What an order line records about the thing bought.
 *
 * Every field is a SNAPSHOT, copied at confirmation and never read back from the
 * product. `productId` is kept so an operator can navigate to the plan, and it is
 * explicitly NOT how the purchase is reconstructed — the product may since have been
 * renamed, re-priced, re-specified or deactivated, and the legacy system's
 * «محصول حذف‌شده» is what happens when a report joins on it.
 *
 * `panelId` is a snapshot too, for the same reason and one more: it is the panel the
 * customer's service was promised on, so a later re-point of the product must not
 * silently move an existing service's home.
 */
export interface OrderLineSnapshot {
  readonly productId: ProductId;
  readonly panelId: PanelId;
  /** The product's title as it read at confirmation. */
  readonly title: string;
  readonly specification: ProductSpecification;
  /** Unit price before any order-level adjustment. */
  readonly unitPrice: Money;
  readonly quantity: number;
}

/**
 * What an order is FOR.
 *
 * Added in Phase 4F, and the absence of it was the phase's headline finding.
 * `PaymentService.confirmAndSettle` ended in an unconditional `planForSettledOrder`,
 * so every order that settled wrote a `services` row and a `PROVISION` operation. A
 * renewal is a NEW order against the SAME service — `services.order_id`'s own docblock
 * has said so since 4D — and routed through that path it would have settled and then
 * created a **second provider account** the customer did not buy.
 * `services_tenant_order_key` does not catch it: the index is unique on
 * `(tenant_id, order_id)` and a renewal has its own order id.
 *
 * So the discriminator is on the ORDER, where settlement can read it, rather than
 * inferred from whether a service happens to exist. Inference is what makes a commercial
 * record depend on the order things are read in; a column is what makes a settlement
 * path a decision somebody made.
 *
 * - `NEW_SERVICE` — the original purchase. Produces a service and a `PROVISION`.
 * - `RENEW` — a new period and a new allowance on an existing service.
 * - `ADD_TRAFFIC` — more allowance, bought from a configured add-on.
 * - `ADD_TIME` — more window, likewise.
 *
 * The last three each name a `service_id` and produce NO service. The first names none
 * and produces exactly one. `orderPurposeCreatesNewService` and
 * `orderPurposeTargetsExistingService` are that rule from both sides, and the schema
 * carries it as a CHECK so a row cannot exist in the shape the settlement path would
 * misread.
 *
 * `NEW_SERVICE` is the DEFAULT on the column, which is what makes this expand-only: the
 * release running during a rolling update writes orders without the field and gets the
 * behaviour it already had.
 */
/**
 * `TRIAL` is a new service nobody paid for: it provisions exactly as `NEW_SERVICE` does
 * and its total is zero. It is a purpose and not a flag on `NEW_SERVICE` so that no
 * reader can confuse a free order with a pricing bug, and so the one edge that lets it
 * reach `PAID` can say which orders it admits. `docs/wp6-audit.md` A1.
 */
export const ORDER_PURPOSES = ['NEW_SERVICE', 'RENEW', 'ADD_TRAFFIC', 'ADD_TIME', 'TRIAL'] as const;
export type OrderPurpose = (typeof ORDER_PURPOSES)[number];
export const orderPurposeSchema = z.enum(ORDER_PURPOSES);

/**
 * The purposes that act on a service that already exists.
 *
 * Derived from `ORDER_PURPOSES` through `orderPurposeTargetsExistingService`, the
 * exhaustive classifier below, rather than listed again or derived by exclusion. It was
 * `purpose !== 'NEW_SERVICE'`, which read as safe until a second purpose that CREATES a
 * service arrived: `TRIAL` would have landed here, in the commercial dispatch and in
 * `service_commercial_actions_kind_check`, as a purchase acting on a service that does
 * not exist. A classifier that must name every member cannot make that mistake quietly.
 */
export const COMMERCIAL_ORDER_PURPOSES = ORDER_PURPOSES.filter((purpose) =>
  orderPurposeTargetsExistingService(purpose),
) as readonly OrderPurpose[];

/**
 * Whether this purpose CREATES a remote service — and therefore consumes one
 * panel-capacity slot.
 *
 * Exhaustive by `switch`, not by inequality, and that is the whole point of it
 * existing. Its predecessor was `orderPurposeNeedsService`, which returned
 * `purpose !== 'NEW_SERVICE'` and read as "needs a service to be created" when it
 * meant "NAMES a service that already exists". That reading cost this branch three
 * defects: commercial orders reserved capacity nothing ever released, commercial
 * settlement lost its disposition, and a stranded renewal recovered by provisioning a
 * second account. Every one of them was a caller reasoning about a negation.
 *
 * So there are two positively-named predicates, each total over the union, and a
 * purpose added without being classified fails to compile — the `never` arm below is
 * what makes that true, and `classifies every order purpose, exhaustively` is what
 * makes it true for anyone reading the enum rather than the compiler.
 *
 * The safe side of the mistake is unchanged: nothing here lets a new purpose default
 * into provisioning. An operation that refuses is a bug report; a second provider
 * account is a customer paying twice.
 */
export function orderPurposeCreatesNewService(purpose: OrderPurpose): boolean {
  switch (purpose) {
    case 'NEW_SERVICE':
    case 'TRIAL':
      return true;
    case 'RENEW':
    case 'ADD_TRAFFIC':
    case 'ADD_TIME':
      return false;
    default: {
      const unclassified: never = purpose;
      throw new Error(`Unclassified order purpose: ${String(unclassified)}`);
    }
  }
}

/**
 * Whether this purpose acts on a service that ALREADY exists — and therefore must
 * neither reserve nor consume a capacity slot.
 *
 * The complement of `orderPurposeCreatesNewService` over this union, written as its
 * own exhaustive switch rather than as its negation. A negation would put both
 * questions in one place again and re-create the ambiguity the pair exists to end;
 * `the two purpose predicates partition the union` asserts they stay complementary.
 */
export function orderPurposeTargetsExistingService(purpose: OrderPurpose): boolean {
  switch (purpose) {
    case 'RENEW':
    case 'ADD_TRAFFIC':
    case 'ADD_TIME':
      return true;
    case 'NEW_SERVICE':
    case 'TRIAL':
      return false;
    default: {
      const unclassified: never = purpose;
      throw new Error(`Unclassified order purpose: ${String(unclassified)}`);
    }
  }
}

/**
 * The operation type a commercial purpose is executed as.
 *
 * Total over the three, and it returns `null` for `NEW_SERVICE` and `TRIAL` — the two
 * that create a service rather than act on one — rather than throwing:
 * the caller that asks this question is the settlement dispatch, and a dispatch whose
 * safe branch is reached by catching an exception is a dispatch one refactor away from
 * catching the wrong one.
 */
export function operationTypeForOrderPurpose(
  purpose: OrderPurpose,
): 'RENEW' | 'ADD_TRAFFIC' | 'ADD_TIME' | null {
  return orderPurposeTargetsExistingService(purpose)
    ? (purpose as 'RENEW' | 'ADD_TRAFFIC' | 'ADD_TIME')
    : null;
}

/**
 * One product per order.
 *
 * Not a technical limit — a decision, and it is narrower than the schema has to be so
 * that it can widen without a migration. A multi-line order needs partial refunds,
 * partial provisioning and a per-line state, none of which any observed flow asks for,
 * and each of which is a place for a financial total to disagree with its parts.
 */
export const MAX_ORDER_LINES = 1;
export const MAX_ORDER_QUANTITY = 1;

/**
 * How long an unpaid order is held.
 *
 * A bound rather than a value: the actual window is an operator SETTING, because a
 * tenant selling to a different market wants a different one and the research fixes no
 * number. These are the limits a configured value is checked against, so a
 * misconfiguration cannot create an order that never expires or one that expires
 * before a customer can open a payment page.
 */
export const ORDER_EXPIRY_MINUTES_MIN = 5;
export const ORDER_EXPIRY_MINUTES_MAX = 20_160; // fourteen days

/**
 * Everything an order must carry for its total to be defensible.
 *
 * The quote is mandatory and carries its own trace (`pricing.ts` refuses a quote
 * without one). So an order can always answer "why this number", which is the question
 * the legacy system cannot answer for any of its prices.
 */
export interface OrderTotals {
  readonly subtotal: Money;
  readonly discountTotal: Money;
  readonly total: Money;
  readonly quote: PriceQuote;
}

/**
 * A total is never negative, and that is a domain rule rather than a column type.
 *
 * A discount larger than a subtotal is a configuration mistake, and the harmless
 * reading of it — "the customer is owed money" — is the expensive one: it would mint a
 * credit out of a promo code. So the discount is CLAMPED to the subtotal and the clamp
 * is visible in the quote trace.
 */
export function clampDiscount(subtotalMinor: bigint, discountMinor: bigint): bigint {
  if (discountMinor <= 0n) return 0n;
  return discountMinor > subtotalMinor ? subtotalMinor : discountMinor;
}
