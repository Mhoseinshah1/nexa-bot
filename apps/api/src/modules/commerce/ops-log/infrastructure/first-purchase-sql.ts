import { sql, type SQL } from 'drizzle-orm';
import { SALE_ORDER_ORIGINS } from '@nexa/contracts';
import { FIRST_PURCHASE_PURPOSES } from '../../pricing/domain/pricing-engine.js';

const listOf = (values: readonly string[]): SQL =>
  sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );

/**
 * Whether the order aliased `order` (a row of `orders`) is its customer's FIRST PAID
 * PURCHASE (R9 C2) — one definition, shared by the «خرید اول کاربر» line of L10 / L11, the
 * first-purchase badge and the nightly «first purchases» count, so the three cannot disagree.
 *
 * It is the pricing rule, read for a settled order instead of a quote: pricing's
 * `isFirstPurchase` asks "has this customer another live order of a purchase purpose?", with
 * `FIRST_PURCHASE_PURPOSES` — a catalogue service or a custom one; a trial is not a purchase
 * and a renewal, an extra traffic or time order is not a first one. Here:
 *
 *  - the order is itself a settled purchase of such a purpose and a sale (`SALE_ORDER_ORIGINS`:
 *    an adopted legacy service is no purchase of this installation, so it neither is a first
 *    purchase nor stops a later one being first);
 *  - no OTHER sale order of such a purpose is PAID and was settled before it, by
 *    `(settled_at, id)` so two orders settled in the same instant still have exactly one
 *    first. An order since refunded, cancelled or expired is not a live order — pricing does
 *    not count it either — so a customer whose first purchase was given back is still a
 *    first-time buyer on the next one.
 */
export function isFirstPaidPurchase(order: string): SQL {
  if (!/^[a-z]{1,3}$/.test(order)) throw new Error(`not an order alias: ${order}`);
  const o = sql.raw(order);
  const purposes = listOf(FIRST_PURCHASE_PURPOSES);
  const origins = listOf(SALE_ORDER_ORIGINS);
  return sql`(${o}.purpose IN (${purposes})
              AND ${o}.origin IN (${origins})
              AND ${o}.settled_at IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM orders e
                 WHERE e.tenant_id = ${o}.tenant_id AND e.customer_id = ${o}.customer_id
                   AND e.id <> ${o}.id AND e.origin IN (${origins})
                   AND e.purpose IN (${purposes})
                   AND e.state = 'PAID' AND e.settled_at IS NOT NULL
                   AND (e.settled_at, e.id) < (${o}.settled_at, ${o}.id)))`;
}
