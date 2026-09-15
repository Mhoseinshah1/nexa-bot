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
 * - `CANCELLED` — withdrawn before settlement, by the customer or an operator.
 * - `EXPIRED` — nobody withdrew it and nobody paid; the window closed.
 * - `REFUNDED` — settled and then reversed. Terminal, and a ledger fact, never an edit.
 *
 * `EXPIRED` and `CANCELLED` are not merged. "The customer changed their mind" and
 * "we stopped waiting" are different facts about the same row, and a tenant looking at
 * abandonment rates needs them apart.
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

export const ORDER_EVENTS = ['CONFIRM', 'SETTLE', 'CANCEL', 'EXPIRE', 'REFUND'] as const;
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
    { from: 'AWAITING_PAYMENT', to: 'CANCELLED', on: 'CANCEL' },
    { from: 'AWAITING_PAYMENT', to: 'EXPIRED', on: 'EXPIRE' },
    { from: 'PAID', to: 'REFUNDED', on: 'REFUND' },
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
 * and produces exactly one. `orderPurposeNeedsService` is that rule, and the schema
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

/** Whether this purpose names an existing service rather than producing one. */
export function orderPurposeNeedsService(purpose: OrderPurpose): boolean {
  return purpose !== 'NEW_SERVICE';
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
