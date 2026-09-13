import { isListed, isPurchasable } from '@nexa/contracts';
import type { ProductRecord } from './ports.js';

/**
 * Whether a customer may see and buy this product. ONE statement of the rule.
 *
 * The rule itself is not invented here. `bot.catalog.empty`'s frozen description in
 * `templates.ts` says the empty catalogue is shown when a tenant has no "listed,
 * **priced, fulfillable** product", and those three words are these four predicates:
 *
 * - `isListed` — the contract's own function: `ACTIVE` and audience not `HIDDEN`
 * - priced — the price pair is present, and `catalog.ts` is explicit that an absent
 *   price means unsellable rather than free
 * - fulfillable — a panel is bound, because nothing can be delivered otherwise
 *
 * It exists as a function AND as a SQL predicate in `listCatalog`, which is a
 * duplication with a reason: the SQL keeps a non-visible product inside the database,
 * and this keeps every other caller — the order path above all — from re-deriving the
 * rule slightly differently. `catalog-visibility.test.ts` runs both over the same
 * matrix of products and asserts they agree, so the pair cannot drift silently. That
 * test is the whole justification for having two; without it this would be the second
 * vocabulary the audit warns about.
 */
export function isCustomerVisible(product: ProductRecord): boolean {
  return (
    isListed(product.status, product.audience) && product.price !== null && product.panelId !== null
  );
}

/**
 * Why a product a customer asked for cannot be ordered, or null when it can.
 *
 * Separate from the boolean because the two questions have different answers. Browsing
 * needs "show it or not"; an order refusal needs to say WHICH rule failed, and
 * `catalog.ts` requires exactly that for the unfulfillable case: such a product is
 * "refused at order confirmation rather than at browse time, because the refusal
 * message an operator needs names the product".
 *
 * The order is deliberate. Status is checked first because `INACTIVE` is the operator's
 * own decision to stop selling, and reporting "not priced" for a product they have
 * already withdrawn would send them to fix the wrong thing.
 *
 * **This is `isPurchasable`, NOT `isListed` — the audience is deliberately not checked.**
 * A `HIDDEN` product is live and merely unlisted: `catalog.ts` says in terms that this
 * "is how a tenant sells something to one customer without publishing it". So a
 * customer who was handed the product's reference by an operator can order it, while it
 * never appears in a catalogue listing. Using `isListed` here would collapse `HIDDEN`
 * into `INACTIVE` and delete the whole distinction the contract exists to draw — the
 * same collapse it warns makes "unlist this" and "stop selling this" one button.
 */
export type ProductUnorderableReason = 'NOT_PURCHASABLE' | 'NOT_PRICED' | 'NOT_FULFILLABLE';

export function unorderableReason(product: ProductRecord): ProductUnorderableReason | null {
  if (!isPurchasable(product.status)) return 'NOT_PURCHASABLE';
  if (product.price === null) return 'NOT_PRICED';
  if (product.panelId === null) return 'NOT_FULFILLABLE';
  return null;
}
