import { isCategoryListed, isCategoryPurchasable, isListed, isPurchasable } from '@nexa/contracts';
import type { ProductCategoryRecord, ProductRecord } from './ports.js';

/**
 * Whether a product may be shown to an ORDINARY customer. ONE statement of the rule.
 *
 * The rule is not invented here. `bot.catalog.empty`'s frozen description in
 * `templates.ts` says the empty catalogue is shown when a tenant has no "listed,
 * **priced, fulfillable** product", and those three words are these predicates:
 *
 * - `isListed` — the contract's own function: `ACTIVE` and audience not `HIDDEN`
 * - not `RESELLERS_ONLY` — see below; this one is OURS, not the contract's
 * - priced — the price pair is present, and `catalog.ts` is explicit that an absent
 *   price means unsellable rather than free
 * - fulfillable — a panel is bound, because nothing can be delivered otherwise
 *
 * ## Why `RESELLERS_ONLY` is excluded here and not by `isListed`
 *
 * `isListed` answers "is this in A catalogue" and returns true for `RESELLERS_ONLY`,
 * which is correct: the contract expects the CALLER to know whose catalogue it is
 * building and to apply the audience itself. Phase 4B has no such caller. There is no
 * reseller entity, no reseller entitlement and nothing on a customer that could say
 * whether they are one — `docs/phase4b-audit.md` records resellers as 4F's.
 *
 * So the only two options are to show reseller-only products to every ordinary
 * customer, or to show them to nobody. This FAILS CLOSED. A product an operator marked
 * reseller-only appearing in the public catalogue is a pricing tier leaking to the
 * people it was priced away from, and `nexa-conventions` says deny by default. The
 * exclusion disappears the moment a reseller identity exists to check against, and the
 * audit carries it as the trigger.
 *
 * Found by the Codex review of this branch: `isListed` was used alone, which faithfully
 * implemented a frozen predicate whose precondition this phase does not meet.
 *
 * It exists as a function AND as a SQL predicate in `listCatalog`, which is a
 * duplication with a reason: the SQL keeps a non-visible product inside the database,
 * and this keeps every other caller — the order path above all — from re-deriving the
 * rule slightly differently. `catalog.test.ts` runs both over the same matrix of
 * products and asserts they agree, so the pair cannot drift silently.
 */
export function isCustomerVisible(
  product: ProductRecord,
  category: ProductCategoryRecord | null,
): boolean {
  return (
    isListed(product.status, product.audience) &&
    product.audience !== 'RESELLERS_ONLY' &&
    product.price !== null &&
    product.panelId !== null &&
    /*
     * The category's BOTH terms, because browsing asks both questions.
     *
     * A null category is not visible either. Migration 0097 gave every product one, so
     * a null means the product has fallen out of the catalogue's structure, and showing
     * it would put an unfilable product in front of a customer.
     */
    category !== null &&
    isCategoryListed(category.status, category.visibility)
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
 * **`isPurchasable`, NOT `isListed` — `HIDDEN` is deliberately still orderable.**
 * A `HIDDEN` product is live and merely unlisted: `catalog.ts` says in terms that this
 * "is how a tenant sells something to one customer without publishing it". So a
 * customer handed the product's reference by an operator can order it while it never
 * appears in a listing. Using `isListed` here would collapse `HIDDEN` into `INACTIVE`
 * and delete the whole distinction the contract exists to draw.
 *
 * **`RESELLERS_ONLY` is different and IS refused.** Hiding it from the catalogue while
 * leaving it orderable would make the exclusion above cosmetic: an id travels in a
 * screenshot, and the reseller price would be reachable by anyone who had one. The
 * whole point of failing closed is that both halves close.
 */
export type ProductUnorderableReason =
  | 'NOT_PURCHASABLE'
  | 'NOT_FOR_AUDIENCE'
  | 'NOT_PRICED'
  | 'NOT_FULFILLABLE'
  | 'NOT_CATEGORISED'
  | 'CATEGORY_NOT_PURCHASABLE';

export function unorderableReason(
  product: ProductRecord,
  category: ProductCategoryRecord | null,
): ProductUnorderableReason | null {
  if (!isPurchasable(product.status)) return 'NOT_PURCHASABLE';
  if (product.audience === 'RESELLERS_ONLY') return 'NOT_FOR_AUDIENCE';
  if (product.price === null) return 'NOT_PRICED';
  if (product.panelId === null) return 'NOT_FULFILLABLE';
  /*
   * The category, and ONLY its status.
   *
   * `isCategoryPurchasable`, never `isCategoryListed`. A HIDDEN category is unlisted and
   * still sells — that is the whole reason the state exists, exactly as it is for a
   * HIDDEN product — so consulting visibility here would collapse "unlist this group"
   * into "withdraw this group" and delete the distinction `catalog.ts` draws. The owner
   * stated it directly: hidden alone does NOT make an otherwise valid product
   * unorderable through a valid direct reference.
   *
   * An INACTIVE category is the opposite and IS refused, including for a direct
   * reference, because an operator saying "stop selling this group" that a screenshot
   * could bypass would not be a rule at all.
   */
  if (category === null) return 'NOT_CATEGORISED';
  if (!isCategoryPurchasable(category.status)) return 'CATEGORY_NOT_PURCHASABLE';
  return null;
}
