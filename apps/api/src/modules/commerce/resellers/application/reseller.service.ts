import {
  COMMERCE_ERROR_CODES,
  errors,
  isDiscountablePurpose,
  resellerPriceLayer,
  resellerReductionMinor,
  type CurrencyCode,
  type DiscountablePurpose,
  type ProductId,
  type TenantContext,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { ProductRepository } from '../../catalog/application/ports.js';
import type { OrderRecord } from '../../orders/application/ports.js';
import { decideEntitlement } from '../domain/entitlement.js';
import { quotedResellerLayer, type ResellerPricingTerms } from '../domain/reseller-pricing.js';
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
  readonly grants: readonly ResellerTierGrantRecord[];
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
    const grants = await this.deps.resellers.grantsOf(scope, tier.id, tx);
    return { reseller, tier, grants };
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

  /** The layer that prices this customer, or null for an ordinary customer (R3). */
  async pricingTerms(
    scope: TenantContext,
    customerId: string,
    tx?: unknown,
  ): Promise<ResellerPricingTerms | null> {
    const standing = await this.standing(scope, customerId, tx);
    return standing === null ? null : termsOf(standing);
  }

  /**
   * The credit allowance below zero for a debit in `currency` (R8): the reseller's own
   * limit, else the tier's, in its own currency only. Zero for everyone else. Read inside
   * the wallet transaction, after the customer's lock, so it is the limit in force when
   * the money moves.
   */
  async creditAllowance(
    scope: TenantContext,
    customerId: string,
    currency: CurrencyCode,
    tx: unknown,
  ): Promise<bigint> {
    const standing = await this.standing(scope, customerId, tx);
    if (standing === null) return 0n;
    // R8's one statement, shared with the operator's credit view (WP14 D1).
    return creditAllowanceOf(
      {
        status: standing.reseller.status,
        ownLimit: standing.reseller.creditLimit,
        tierLimit: standing.tier.creditLimit,
      },
      currency,
    );
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
    const quoted = quotedResellerLayer(order.totals.quote.trace);
    const standing = await this.standing(scope, order.customerId, tx);

    if (standing === null) {
      if (quoted !== null) throw termsChanged();
      return;
    }

    await this.assertEntitled(
      scope,
      standing,
      { operation: order.purpose, productId: order.line.productId, panelId: order.line.panelId },
      tx,
    );

    const terms = termsOf(standing);
    const base = order.totals.quote.trace.find((s) => s.step === 'BASE_PRICE');
    if (base === undefined) throw termsChanged();
    const list = base.amountAfter.amountMinor;
    const cost = list - resellerReductionMinor(list, terms.percent);
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

    await this.deps.resellers.recordTerms(
      scope,
      {
        orderId: order.id,
        resellerCustomerId: order.customerId,
        tierId: terms.tierId,
        tierName: terms.tierName,
        layer: terms.layer,
        percent: terms.percent,
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
  };
}

function termsChanged() {
  return errors.conflict(
    COMMERCE_ERROR_CODES.RESELLER_TERMS_CHANGED,
    'The price of this order has changed. Start the order again.',
  );
}
