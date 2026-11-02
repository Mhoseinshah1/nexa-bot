import { orderCodeOf, type OrderState, type TemplateValues } from '@nexa/contracts';
import type { OrderRecord } from '../../orders/application/ports.js';

/**
 * R11 A11 (owner request: order-expiry edit-in-place): what an unpaid order's payment message
 * becomes when the order ENDS without being paid — its window closed (`ORDER_EXPIRED`,
 * `bot.order.expired_screen`) or the customer cancelled it (`ORDER_CANCELLED`,
 * `bot.order.cancelled_screen`).
 *
 * One builder for the two producers of that screen — the notification lane, which edits it
 * onto the order's message after the sweep (or the cancellation's rate-limited reply), and
 * the bot turn that answers a cancellation or a tap on a stale pay button — so the two can
 * never draw a different summary for the same order.
 *
 * The summary is the ORDER's own frozen facts: its public code, the line's title as it read
 * at the draft, and its frozen total. Nothing that pays — no card, no amount to copy, no
 * reference to transfer against — and nothing about money having been taken (the owner
 * removed that line). The buttons are «🔁 سفارش دوباره» and «🏠 منوی اصلی»; where the first
 * leads is `reorder`, an identifier and nothing more, which the surface turns into a route.
 */

/**
 * Where «🔁 سفارش دوباره» leads. Every target is a READ-ONLY entry into the purchase flow:
 * nothing is drafted or ordered until the customer picks a plan and confirms it again.
 *
 *   - `CATEGORY`: a new service bought from a category the order recorded — that
 *     category's product list, re-read for this customer when tapped;
 *   - `CUSTOM_SERVICE`: a custom service — its location menu;
 *   - `CATALOGUE`: anything else — a new service whose category was never recorded, and a
 *     renewal, add-on or location change, whose service is reached from the catalogue's
 *     main menu («سرویس‌های من») rather than from a button that could only open a new plan.
 */
export type OrderReorderTarget =
  | { readonly kind: 'CATEGORY'; readonly categoryId: string }
  | { readonly kind: 'CUSTOM_SERVICE' }
  | { readonly kind: 'CATALOGUE' };

export interface OrderEndScreen {
  readonly values: TemplateValues;
  readonly reorder: OrderReorderTarget;
}

/** The state an order must be IN for each ending's screen to be true of it. */
export const ORDER_END_STATES = {
  ORDER_EXPIRED: 'EXPIRED',
  ORDER_CANCELLED: 'CANCELLED',
} as const satisfies Readonly<Record<string, OrderState>>;

export function orderEndScreen(
  order: Pick<OrderRecord, 'code' | 'purpose' | 'line' | 'totals'>,
): OrderEndScreen {
  const code = orderCodeOf(order);
  return {
    values: {
      ...(code === null ? {} : { orderCode: code }),
      productName: order.line.title,
      total: order.totals.total,
    },
    reorder: reorderTargetOf(order),
  };
}

function reorderTargetOf(order: Pick<OrderRecord, 'purpose' | 'line'>): OrderReorderTarget {
  if (order.purpose === 'CUSTOM_SERVICE') return { kind: 'CUSTOM_SERVICE' };
  if (order.purpose === 'NEW_SERVICE') {
    return order.line.category === null
      ? { kind: 'CATALOGUE' }
      : { kind: 'CATEGORY', categoryId: order.line.category.categoryId };
  }
  return { kind: 'CATALOGUE' };
}
