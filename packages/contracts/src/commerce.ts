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
 * - `PAID` — settled. The only state provisioning will act on.
 * - `PAID_UNFULFILLED` — the money arrived and the thing it bought could not be
 *   created. Settled, and owed.
 * - `CANCELLED` — withdrawn before settlement, by the customer or an operator.
 * - `EXPIRED` — nobody withdrew it and nobody paid; the window closed.
 * - `REFUNDED` — settled and then reversed. Terminal, and a ledger fact, never an edit.
 *
 * `EXPIRED` and `CANCELLED` are not merged. "The customer changed their mind" and
 * "we stopped waiting" are different facts about the same row, and a tenant looking at
 * abandonment rates needs them apart.
 *
 * ## Why `PAID_UNFULFILLED` is a state and not an absence
 *
 * A bank transfer is money that has ALREADY MOVED. When an operator confirms one, the
 * only question left is what this installation owes for it — and the answer cannot be
 * "nothing, because the panel filled up while the receipt sat in the queue". Before
 * this state the confirmation simply refused: the payment stayed `PENDING`, the
 * operator could not confirm it and could not refund it either, because a refund needs
 * a confirmed payment. The customer's money sat in the bank with no record of what it
 * was for.
 *
 * So recording the RECEIPT of money is now independent of the ability to fulfil it.
 * `PAID_UNFULFILLED` is an order that is financially settled and operationally owed:
 * no service was created, nothing was provisioned onto a panel that cannot take it,
 * and both ways out stay open — an operator retries or reassigns it, or refunds it
 * through the ordinary refund lane.
 *
 * It is deliberately NOT a flavour of `PAID`. `PAID` is the state provisioning acts
 * on, and the one thing this must never do is let an order with no service look like
 * one that has a service coming.
 */
export const ORDER_STATES = [
  'DRAFT',
  'AWAITING_PAYMENT',
  'PAID',
  'PAID_UNFULFILLED',
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
 * include an order whose fulfilment is still owed: money that arrived is revenue and a
 * report that omits it under-states what this installation holds. `settled_at` is
 * non-null exactly on these, and `orders_settled_at_check` is built from this list so
 * the constraint and the predicate cannot drift apart.
 */
export const ORDER_SETTLED_STATES = ['PAID', 'PAID_UNFULFILLED', 'REFUNDED'] as const;
export type OrderSettledState = (typeof ORDER_SETTLED_STATES)[number];

export const ORDER_EVENTS = [
  'CONFIRM',
  'SETTLE',
  /**
   * The money arrived and the order cannot be fulfilled on its panel.
   *
   * A SEPARATE event from `SETTLE` rather than a flag on it, because the two produce
   * different obligations and a reader of the machine has to see that. Same guard:
   * an order reaches either state only on money that is real.
   */
  'SETTLE_UNFULFILLED',
  /** An operator got a stranded order fulfilled, on its panel or another. */
  'FULFIL',
  'CANCEL',
  'EXPIRE',
  'REFUND',
] as const;
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
     * whether a service could be created for it, which is a question about a PANEL
     * and never about the payment.
     *
     * There is deliberately no edge from `PAID` to here. An order that reached `PAID`
     * has a service row written in the same transaction, and a path back would be a
     * settled order whose service exists while its state says it does not.
     */
    {
      from: 'AWAITING_PAYMENT',
      to: 'PAID_UNFULFILLED',
      on: 'SETTLE_UNFULFILLED',
      guard: 'settlementIsFunded',
    },
    { from: 'AWAITING_PAYMENT', to: 'CANCELLED', on: 'CANCEL' },
    { from: 'AWAITING_PAYMENT', to: 'EXPIRED', on: 'EXPIRE' },
    { from: 'PAID', to: 'REFUNDED', on: 'REFUND' },
    /*
     * The two ways out of owing somebody a service, and both are operator acts.
     *
     * `FULFIL` is the retry: the panel recovered, an operator raised the cap, or they
     * reassigned the order to another panel. It is the ONLY edge into `PAID` that does
     * not come from `AWAITING_PAYMENT`, and it carries the same obligation — a service
     * row is written in the transaction that takes it.
     *
     * `REFUND` mirrors the edge out of `PAID` and exists for the same reason: the
     * refund lane is payment-side and does not read the order's state, so this edge
     * records what a refund MEANS for the order rather than driving it.
     */
    { from: 'PAID_UNFULFILLED', to: 'PAID', on: 'FULFIL' },
    { from: 'PAID_UNFULFILLED', to: 'REFUNDED', on: 'REFUND' },
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
export const ORDER_PURPOSES = ['NEW_SERVICE', 'RENEW', 'ADD_TRAFFIC', 'ADD_TIME'] as const;
export type OrderPurpose = (typeof ORDER_PURPOSES)[number];
export const orderPurposeSchema = z.enum(ORDER_PURPOSES);

/**
 * The purposes that act on a service that already exists.
 *
 * Derived from `ORDER_PURPOSES` by exclusion rather than listed again, because the one
 * thing that must never drift is which purposes provision. A new purpose added without
 * a thought lands here — as one that does NOT create a service — which is the safe side
 * of the mistake: an operation that refuses is a bug report, and a second provider
 * account is a customer paying twice.
 */
export const COMMERCIAL_ORDER_PURPOSES = ORDER_PURPOSES.filter(
  (purpose) => purpose !== 'NEW_SERVICE',
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
 * Total over the three, and it returns `null` for `NEW_SERVICE` rather than throwing:
 * the caller that asks this question is the settlement dispatch, and a dispatch whose
 * safe branch is reached by catching an exception is a dispatch one refactor away from
 * catching the wrong one.
 */
export function operationTypeForOrderPurpose(
  purpose: OrderPurpose,
): 'RENEW' | 'ADD_TRAFFIC' | 'ADD_TIME' | null {
  return purpose === 'NEW_SERVICE' ? null : purpose;
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
