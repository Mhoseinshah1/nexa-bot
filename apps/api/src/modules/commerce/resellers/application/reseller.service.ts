import {
  COMMERCE_ERROR_CODES,
  errors,
  isDiscountablePurpose,
  isResellerTierPricePurpose,
  money,
  resellerPriceLayer,
  type CurrencyCode,
  type DiscountablePurpose,
  type Money,
  type ProductId,
  type TenantContext,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { ProductRepository } from '../../catalog/application/ports.js';
import type { OrderRecord } from '../../orders/application/ports.js';
import { decideEntitlement, effectiveGrants } from '../domain/entitlement.js';
import {
  decideTierPrice,
  quotedResellerLayer,
  resellerCostMinor,
  type ResellerPricingTerms,
} from '../domain/reseller-pricing.js';
import type {
  ResellerRecord,
  ResellerRepository,
  ResellerTierGrantRecord,
  ResellerTierRecord,
} from './ports.js';
import { creditAllowanceOf } from '../domain/reseller-credit.js';

export interface ResellerServiceDeps {
  readonly resellers: ResellerRepository;
  readonly products: Pick<ProductRepository, 'findById'>;
}

/** An ACTIVE reseller, with the tier and grants their commercial actions are judged by. */
export interface ResellerStanding {
  readonly reseller: ResellerRecord;
  readonly tier: ResellerTierRecord;
  /**
   * The EFFECTIVE grants: the tier's, with every dimension the reseller overrides replaced
   * by the reseller's own grants of it (round N R1, `effectiveGrants`). What every caller —
   * the catalogue courtesy, the draft, the confirmation, a commercial action — is judged by.
   */
  readonly grants: readonly ResellerTierGrantRecord[];
}

/**
 * What is being priced, for the reseller layer (Round 4 PR-G): a price-table tier prices a
 * PRODUCT, for the purposes its table covers, in the list price's currency.
 */
export interface ResellerPricingSubject {
  readonly purpose: DiscountablePurpose;
  readonly productId: string | null;
  readonly currency: CurrencyCode;
}

/**
 * The catalogue's half of a price-table tier (Round 4 PR-G): the tier whose table decides
 * what is sellable, and whether an unpriced product is sold at list. Null for every other
 * standing — a rate tier, and a reseller whose own override replaces the tier's pricing.
 */
export interface TierPriceGate {
  readonly tierId: string;
  readonly unpricedListFallback: boolean;
}

export function tierPriceGateOf(standing: ResellerStanding | null): TierPriceGate | null {
  if (standing === null) return null;
  if (standing.tier.pricingMode !== 'FIXED_PRICE_TABLE') return null;
  // An override other than TIER replaces the tier's pricing, table included (R3).
  if (standing.reseller.pricingMode !== 'TIER') return null;
  return { tierId: standing.tier.id, unpricedListFallback: standing.tier.unpricedListFallback };
}

/** What a commercial action asks for; the category is resolved here, from the product. */
export interface ResellerActionSubject {
  readonly operation: DiscountablePurpose;
  readonly productId: string;
  readonly panelId: string;
}

/**
 * A reseller's standing in the commercial paths (`docs/wp9-reseller-audit.md` R1, R3, R5,
 * R6, R8, R9). Every question the order, pricing and payment paths ask about a reseller is
 * asked here, so none of them decides "is this a reseller" or "may they" alone.
 *
 * Nothing here opens a transaction or checks a permission: every method runs inside the
 * caller's, which has already done both. The operator's side is `ResellerAdminService`.
 */
export class ResellerService {
  constructor(private readonly deps: ResellerServiceDeps) {}

  /**
   * The customer's standing as a reseller, or null — for a customer with no reseller row
   * AND for a `SUSPENDED` one (R1): suspension withdraws every reseller privilege and
   * leaves an ordinary customer.
   */
  async standing(
    scope: TenantContext,
    customerId: string,
    tx: unknown,
  ): Promise<ResellerStanding | null> {
    /*
     * Inside a transaction the reseller row and then the tier row are read FOR SHARE.
     *
     * An operator's suspension UPDATEs the reseller row and a grants or rate change takes
     * the tier's `FOR UPDATE`, so each waits for a commercial transaction that has already
     * decided under the old terms, and that transaction commits what they allowed — or it
     * waits for them and decides under the new. Plain reads let a withdrawal commit, be
     * reported done, and a sale still commit under the grant it withdrew. Reseller then
     * tier, in that order, is the order the admin paths take too.
     * Outside a transaction (the catalogue courtesy) there is nothing to hold.
     */
    const reseller =
      tx === undefined
        ? await this.deps.resellers.findByCustomer(scope, customerId)
        : await this.deps.resellers.shareByCustomer(scope, customerId, tx);
    if (reseller === null || reseller.status !== 'ACTIVE') return null;
    const tier =
      tx === undefined
        ? await this.deps.resellers.findTier(scope, reseller.tierId)
        : await this.deps.resellers.shareTier(scope, reseller.tierId, tx);
    if (tier === null) {
      // The foreign key makes this unreachable; a reseller whose tier cannot be read is
      // refused everything rather than treated as an ordinary customer.
      throw errors.conflict(
        COMMERCE_ERROR_CODES.RESELLER_NOT_ENTITLED,
        'This purchase is not available.',
        { dimension: 'TIER' },
      );
    }
    /*
     * Round N R1: the reseller's own override, read after the reseller row it belongs to.
     * Its writer holds that row `FOR UPDATE` (`ResellerAdminService.replaceOverrides`), so
     * inside a transaction the `FOR SHARE` above already orders it against this read.
     */
    const tierGrants = await this.deps.resellers.grantsOf(scope, tier.id, tx);
    const override = await this.deps.resellers.overridesOf(scope, reseller.customerId, tx);
    return { reseller, tier, grants: effectiveGrants(tierGrants, override) };
  }

  /**
   * Refuses a commercial action the reseller's tier does not grant (R5, R6). The ONE
   * evaluator: the draft, the confirmation, a commercial action and the purchase record all
   * come through here. The bot is the scope's: the Telegram surface carries it, and a
   * request that arrived through no bot passes only a tier granting every bot.
   */
  async assertEntitled(
    scope: TenantContext,
    standing: ResellerStanding,
    subject: ResellerActionSubject,
    tx: unknown,
  ): Promise<void> {
    const product = await this.deps.products.findById(scope, subject.productId as ProductId, tx);
    const decision = decideEntitlement(standing.grants, {
      operation: subject.operation,
      productId: subject.productId,
      categoryId: product?.categoryId ?? null,
      panelId: subject.panelId,
      botInstanceId: scope.botInstanceId,
    });
    if (!decision.allowed) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.RESELLER_NOT_ENTITLED,
        'This purchase is not available.',
        { dimension: decision.dimension, tierId: standing.tier.id },
      );
    }
  }

  /**
   * The SAME evaluator as `assertEntitled`, as a pure answer over data the caller already
   * holds — no read, no throw. For a caller weighing several panels for one product inside
   * its own transaction (Phase C3's placement, Codex on #163), where re-reading the product
   * once per candidate under the draft's locks was both slow and pointless: the product and
   * its category were read once already. `assertEntitled` stays the authoritative refusal
   * for the panel finally chosen.
   */
  entitles(
    scope: TenantContext,
    standing: ResellerStanding,
    subject: {
      readonly operation: ResellerActionSubject['operation'];
      readonly productId: string;
      readonly categoryId: string | null;
      readonly panelId: string;
    },
  ): boolean {
    return decideEntitlement(standing.grants, {
      operation: subject.operation,
      productId: subject.productId,
      categoryId: subject.categoryId,
      panelId: subject.panelId,
      botInstanceId: scope.botInstanceId,
    }).allowed;
  }

  /**
   * The layer that prices this customer for this subject, or null for an ordinary customer
   * (R3). A price-table tier refuses a product its table does not price, unless the tier
   * sells unpriced products at list (Round 4 PR-G): the draft's authoritative refusal, made
   * at the one pricing boundary.
   */
  async pricingTerms(
    scope: TenantContext,
    customerId: string,
    subject: ResellerPricingSubject,
    tx?: unknown,
  ): Promise<ResellerPricingTerms | null> {
    const standing = await this.standing(scope, customerId, tx);
    return standing === null ? null : this.termsFor(scope, standing, subject, tx);
  }

  /**
   * The price this reseller would be quoted, before promotions, for each product — what a
   * catalogue or a renewal menu SHOWS (Round 4 PR-G), from `resellerCostMinor`, the function
   * the quote itself uses. Null for a product a price-table tier does not sell. A courtesy:
   * the price charged is `PricingService.price`'s, decided again at the draft.
   */
  async offeredPrices(
    scope: TenantContext,
    standing: ResellerStanding,
    purpose: DiscountablePurpose,
    items: readonly { readonly id: string; readonly price: Money | null }[],
  ): Promise<ReadonlyMap<string, Money | null>> {
    const gate = tierPriceGateOf(standing);
    const table =
      gate === null || !isResellerTierPricePurpose(purpose)
        ? new Map<string, { readonly price: Money }>()
        : await this.deps.resellers.tierPricesFor(
            scope,
            gate.tierId,
            items.map((i) => i.id),
          );
    const offered = new Map<string, Money | null>();
    for (const item of items) {
      if (item.price === null) {
        offered.set(item.id, null);
        continue;
      }
      const terms = this.termsFrom(standing, purpose, item.price.currency, table.get(item.id));
      offered.set(
        item.id,
        terms === 'UNSELLABLE'
          ? null
          : money(resellerCostMinor(item.price.amountMinor, terms), item.price.currency),
      );
    }
    return offered;
  }

  private async termsFor(
    scope: TenantContext,
    standing: ResellerStanding,
    subject: ResellerPricingSubject,
    tx: unknown,
  ): Promise<ResellerPricingTerms> {
    const gate = tierPriceGateOf(standing);
    const row =
      gate === null || !isResellerTierPricePurpose(subject.purpose) || subject.productId === null
        ? undefined
        : (
            await this.deps.resellers.tierPricesFor(scope, gate.tierId, [subject.productId], tx)
          ).get(subject.productId);
    const terms = this.termsFrom(standing, subject.purpose, subject.currency, row);
    if (terms === 'UNSELLABLE') throw tierPriceMissing(standing.tier.id);
    return terms;
  }

  /** The one statement of a standing's terms for one subject, from the row already read. */
  private termsFrom(
    standing: ResellerStanding,
    purpose: DiscountablePurpose,
    currency: CurrencyCode,
    row: { readonly price: Money } | undefined,
  ): ResellerPricingTerms | 'UNSELLABLE' {
    const terms = termsOf(standing);
    const gate = tierPriceGateOf(standing);
    if (gate === null) return terms;
    // The table prices products only; everything else keeps its own pricing at list.
    if (!isResellerTierPricePurpose(purpose)) return { ...terms, layer: 'LIST', percent: null };
    const decision = decideTierPrice(row?.price ?? null, currency, gate.unpricedListFallback);
    if (decision.kind === 'UNSELLABLE') return 'UNSELLABLE';
    if (decision.kind === 'LIST') return { ...terms, layer: 'LIST', percent: null };
    return { ...terms, layer: 'TIER', percent: null, fixedPrice: decision.price };
  }

  /**
   * The credit allowance below zero for a wallet debit: ZERO, for every customer. Reseller
   * credit was removed (owner decision, 2026-10-01: no reseller debt, no credit purchases),
   * so a stored limit, however large, grants nothing. Still the one place settlement asks,
   * so the answer stays in `creditAllowanceOf` rather than in a payment-path literal.
   */
  async creditAllowance(
    _scope: TenantContext,
    _customerId: string,
    _currency: CurrencyCode,
    _tx: unknown,
  ): Promise<bigint> {
    return creditAllowanceOf();
  }

  /**
   * The purchase record, written at confirmation (R6, R7, R9). Called by
   * `PricingService.redeem`, inside the confirming transaction, for every order path.
   *
   * 1. The entitlement is decided again, from live grants: the authoritative decision.
   * 2. The quote's reseller layer is compared with the layer the live terms produce now:
   *    the cost, and the step and rule that took it off the list. A difference in either —
   *    a tier re-priced, an override changed, a discounted reseller suspended or a
   *    customer registered onto a discount — refuses with `RESELLER_TERMS_CHANGED`. The
   *    order is never re-priced.
   *
   *    A change that leaves the layer as it was is NOT refused, and that is deliberate: a
   *    list-priced reseller (layer `LIST`, or an `OVERRIDE` with no percent) who is
   *    suspended, or an ordinary customer registered onto a list-priced tier, pays exactly
   *    the price they were quoted. Such an order confirms under the standing in force NOW —
   *    as an ordinary customer with no terms row, or as a reseller with a `LIST` or
   *    `OVERRIDE` row — and the audience (`assertOrderable`) and the entitlement (step 1)
   *    are still enforced for that standing. The terms row records the standing at
   *    confirmation, not the one at the quote.
   * 3. The terms are written, once per order.
   */
  async recordPurchase(
    scope: TenantContext,
    order: OrderRecord,
    now: Date,
    tx: TransactionScope,
  ): Promise<void> {
    if (!isDiscountablePurpose(order.purpose)) return;
    /*
     * A custom service carries no reseller layer and records no terms (Package D §7): an
     * ACTIVE reseller is priced by the custom-service rules written for their tier, and
     * applying the tier's percentage on top would be a second answer to what they pay.
     * Its quote was built without `applyResellerLayer`, so there is nothing to compare.
     */
    if (order.purpose === 'CUSTOM_SERVICE') return;
    const quoted = quotedResellerLayer(order.totals.quote.trace);
    const standing = await this.standing(scope, order.customerId, tx);

    if (standing === null) {
      if (quoted !== null) throw termsChanged();
      return;
    }

    const productId = order.line.productId;
    // Every purpose but CUSTOM_SERVICE names a product (`orders_product_purpose_check`).
    if (productId === null) throw new Error(`order ${order.id} names no product`);
    await this.assertEntitled(
      scope,
      standing,
      { operation: order.purpose, productId, panelId: order.line.panelId },
      tx,
    );

    /*
     * The live terms for THIS order's product and purpose — a price-table tier's row is
     * read here, under the tier's `FOR SHARE` taken by `standing`, so a price changed
     * since the quote is seen (and refused below) or waits for this to commit. A product
     * the table no longer prices is refused as not entitled, exactly as at the draft.
     */
    const terms = await this.termsFor(
      scope,
      standing,
      { purpose: order.purpose, productId, currency: order.totals.currency },
      tx,
    );
    const base = order.totals.quote.trace.find((s) => s.step === 'BASE_PRICE');
    if (base === undefined) throw termsChanged();
    const list = base.amountAfter.amountMinor;
    const cost = resellerCostMinor(list, terms);
    const quotedCost = quoted?.cost ?? list;
    const expectedStep =
      cost === list ? null : terms.layer === 'TIER' ? 'TIER_PRICE' : 'USER_OVERRIDE';
    const expectedRule =
      expectedStep === 'TIER_PRICE'
        ? terms.tierId
        : expectedStep === null
          ? null
          : terms.resellerId;
    if (
      quotedCost !== cost ||
      order.totals.subtotal.amountMinor !== cost ||
      (quoted?.step ?? null) !== expectedStep ||
      (quoted?.ruleId ?? null) !== expectedRule
    ) {
      throw termsChanged();
    }

    /*
     * A table price that took nothing off the list (a tier price at or above list) charged
     * the list: recorded as the LIST layer, so `fixed_price` always means a table price was
     * what the reseller paid.
     */
    const fixedPrice = terms.fixedPrice !== null && cost < list;
    const layer = terms.fixedPrice !== null && !fixedPrice ? 'LIST' : terms.layer;
    await this.deps.resellers.recordTerms(
      scope,
      {
        orderId: order.id,
        resellerCustomerId: order.customerId,
        tierId: terms.tierId,
        tierName: terms.tierName,
        layer,
        percent: terms.percent,
        fixedPrice,
        listAmount: list,
        costAmount: cost,
        promotionAmount: order.totals.discount.amountMinor,
        saleAmount: order.totals.total.amountMinor,
        marginAmount: list - cost,
        currency: order.totals.currency,
        botInstanceId: scope.botInstanceId,
        now,
      },
      tx,
    );
  }
}

function termsOf(standing: ResellerStanding): ResellerPricingTerms {
  const { layer, percent } = resellerPriceLayer(
    { mode: standing.tier.pricingMode, percent: standing.tier.discountPercentage },
    { mode: standing.reseller.pricingMode, percent: standing.reseller.discountPercentage },
  );
  return {
    resellerId: standing.reseller.id,
    customerId: standing.reseller.customerId,
    tierId: standing.tier.id,
    tierName: standing.tier.name,
    layer,
    percent,
    fixedPrice: null,
  };
}

/**
 * A price-table tier's product with no price for it (Round 4 PR-G): not sellable to the tier.
 * The customer's sentence is the entitlement refusal's — the reason is for the operator.
 */
function tierPriceMissing(tierId: string) {
  return errors.conflict(
    COMMERCE_ERROR_CODES.RESELLER_NOT_ENTITLED,
    'This purchase is not available.',
    {
      dimension: 'CATALOGUE',
      tierId,
      reason: 'TIER_PRICE_MISSING',
    },
  );
}

function termsChanged() {
  return errors.conflict(
    COMMERCE_ERROR_CODES.RESELLER_TERMS_CHANGED,
    'The price of this order has changed. Start the order again.',
  );
}
