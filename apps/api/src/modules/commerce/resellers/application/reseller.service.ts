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
    const reseller = await this.deps.resellers.findByCustomer(scope, customerId, tx);
    if (reseller === null || reseller.status !== 'ACTIVE') return null;
    const tier = await this.deps.resellers.findTier(scope, reseller.tierId, tx);
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
    const limit = standing.reseller.creditLimit ?? standing.tier.creditLimit;
    if (limit.currency !== currency || limit.amountMinor <= 0n) return 0n;
    return limit.amountMinor;
  }

  /**
   * The purchase record, written at confirmation (R6, R7, R9). Called by
   * `PricingService.redeem`, inside the confirming transaction, for every order path.
   *
   * 1. The entitlement is decided again, from live grants: the authoritative decision.
   * 2. The quote's reseller layer is compared with what the live terms produce now. Any
   *    difference — a tier re-priced, an override changed, a reseller suspended or newly
   *    registered — refuses with `RESELLER_TERMS_CHANGED`. The order is never re-priced.
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
