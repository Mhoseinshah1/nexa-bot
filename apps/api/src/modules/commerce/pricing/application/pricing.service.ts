import {
  COMMERCE_ERROR_CODES,
  PERSONAL_DISCOUNT_PURPOSES,
  errors,
  isDiscountablePurpose,
  money,
  normaliseDiscountCode,
  type ActorContext,
  type CurrencyCode,
  type DiscountablePurpose,
  type FeatureFlagKey,
  type IdGenerator,
  type Money,
  type TenantContext,
} from '@nexa/contracts';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { OrderRecord, OrderTotalsRecord } from '../../orders/application/ports.js';
import {
  FIRST_PURCHASE_PURPOSES,
  applyAdjustments,
  personalDiscountPercentOf,
  redemptionRefusal,
  type CashbackRule,
  type DiscountRule,
  type DiscountUsage,
  type PricingResult,
} from '../domain/pricing-engine.js';
import type {
  CashbackRuleRepository,
  DiscountRepository,
  OrderCashbackRepository,
  PersonalDiscountReader,
} from './ports.js';
import {
  applyResellerLayer,
  type ResellerPricingTerms,
} from '../../resellers/domain/reseller-pricing.js';

export interface PricingServiceDeps {
  readonly discounts: DiscountRepository;
  readonly cashbackRules: CashbackRuleRepository;
  readonly orderCashback: OrderCashbackRepository;
  /**
   * The referral commission a confirmation promises (`docs/wp9-referral-audit.md` F6).
   * Here because this is the one confirmation hook both order paths share; the program
   * decides everything about it, inside this transaction.
   */
  readonly referrals: {
    promise(
      scope: TenantContext,
      order: OrderRecord,
      now: Date,
      tx: TransactionScope,
    ): Promise<void>;
  };
  /**
   * The reseller layer (`docs/wp9-reseller-audit.md` R3, R9): what prices a reseller, and
   * the purchase record confirmation writes. `ResellerService` decides both; this service
   * only applies the layer and calls the record, so there is one statement of each.
   */
  readonly resellers: {
    pricingTerms(
      scope: TenantContext,
      customerId: string,
      subject: {
        readonly purpose: DiscountablePurpose;
        readonly productId: string | null;
        readonly currency: CurrencyCode;
      },
      tx?: unknown,
    ): Promise<ResellerPricingTerms | null>;
    /** R11 A9: `pricingTerms` for every line of a price list, in one read of the table. */
    pricingTermsForItems(
      scope: TenantContext,
      customerId: string,
      purpose: DiscountablePurpose,
      items: readonly { readonly productId: string | null; readonly currency: CurrencyCode }[],
      tx?: unknown,
    ): Promise<readonly (ResellerPricingTerms | 'UNSELLABLE')[] | null>;
    recordPurchase(
      scope: TenantContext,
      order: OrderRecord,
      now: Date,
      tx: TransactionScope,
    ): Promise<void>;
  };
  readonly outbox: OutboxWriter;
  readonly ids: IdGenerator;
  /** R10 D3: the customer's stored personal discount percent. */
  readonly personalDiscounts: PersonalDiscountReader;
  /** R10 D3: whether `personal_discount` is on, read inside the pricing transaction. */
  readonly featureFlags: {
    isEnabled(scope: TenantContext, key: FeatureFlagKey, tx?: unknown): Promise<boolean>;
  };
}

/** The flag behind the personal discount (R10 D3). */
export const PERSONAL_DISCOUNT_FEATURE: FeatureFlagKey = 'personal_discount';

/**
 * Whether a purpose is one a personal discount applies to: a purchase or a renewal, never
 * a top-up (which never reaches pricing), an add-on, a custom service or a location change.
 */
export function personalDiscountApplies(purpose: string): boolean {
  return (PERSONAL_DISCOUNT_PURPOSES as readonly string[]).includes(purpose);
}

/**
 * What is being priced, for `PricingService.price`.
 *
 * `base` is the list-price quote from `order-pricing.ts`, or a draft's own snapshot when a
 * draft is re-quoted for a code. `customerId` is null only for the operator's preview
 * without a customer. `code` is absent when none was entered.
 */
export interface PriceRequest {
  readonly base: OrderTotalsRecord;
  readonly purpose: DiscountablePurpose;
  readonly productId: string | null;
  readonly categoryId: string | null;
  readonly customerId: string | null;
  readonly code?: string;
  readonly now: Date;
  /** The draft being re-quoted, so its own row is never counted against it. */
  readonly orderId?: string;
}

/**
 * R11 A9: one line of a customer-facing price list, as `personalListPrices` prices it — the
 * same base, product and category its draft would hand `price`. `id` keys the answer.
 */
export interface ListPriceItem {
  readonly id: string;
  readonly base: OrderTotalsRecord;
  readonly productId: string | null;
  readonly categoryId: string | null;
}

/** R11 A9: a whole price list, for ONE customer and ONE purpose. */
export interface ListPriceRequest {
  readonly purpose: DiscountablePurpose;
  readonly customerId: string;
  readonly now: Date;
  readonly items: readonly ListPriceItem[];
}

/**
 * R11 A9: what a list shows for a line the personal discount wins: the percent, and the
 * total the line's checkout quotes — the figure the invoice will carry.
 */
export interface ListedPersonalDiscount {
  readonly percent: number;
  readonly price: Money;
}

/** The facts `price` gathers besides the reseller layer and the personal percent. */
interface PricingFacts {
  readonly automatic: readonly DiscountRule[];
  readonly coded?: DiscountRule | null;
  readonly usage: ReadonlyMap<string, DiscountUsage>;
  readonly isFirstPurchase: boolean | null;
  readonly cashbackRules: readonly CashbackRule[];
}

/**
 * Whether the reseller layer is asked for at all: only for a customer, and never for a
 * custom service, which is priced by its own tier rules — the reseller layer on top would
 * be a second answer to what a reseller pays (Package D §7).
 */
function resellerLayerApplies(
  request: Pick<PriceRequest, 'purpose' | 'customerId'>,
): request is Pick<PriceRequest, 'purpose'> & { readonly customerId: string } {
  return request.customerId !== null && request.purpose !== 'CUSTOM_SERVICE';
}

/**
 * The ONE composition of a quote from its facts: the reseller layer over the list base,
 * then the engine (`applyAdjustments`) with the promotions, the cashback rules and the
 * personal percent taken off the LIST base. `price` ends here, and so does every line of
 * `personalListPrices` — the reason a listed price and its invoice cannot disagree.
 */
function quoteWith(
  request: PriceRequest,
  terms: ResellerPricingTerms | null,
  facts: PricingFacts,
  personalPercent: number | null,
): PricingResult {
  const base = terms === null ? request.base : applyResellerLayer(request.base, terms);
  return applyAdjustments({
    base,
    subject: {
      purpose: request.purpose,
      productId: request.productId,
      categoryId: request.categoryId,
      customerId: request.customerId,
      isFirstPurchase: facts.isFirstPurchase,
      now: request.now,
    },
    automatic: facts.automatic,
    ...(facts.coded === undefined ? {} : { coded: facts.coded }),
    usage: facts.usage,
    cashbackRules: facts.cashbackRules,
    personal: personalPercent === null ? null : { percent: personalPercent, list: request.base },
  });
}

/**
 * The one door into the pricing engine (`docs/wp8-pricing-audit.md` P1, P6, P8).
 *
 * `price` gathers the facts — the live rules, the entered code's rule, the live usage,
 * the first-purchase answer, the cashback rules — and hands them to the pure engine.
 * Checkout, the code a customer enters, the commercial actions and the operator's
 * preview all come through it, so none of them can price differently from the others.
 *
 * `redeem` is confirmation's half: it re-decides, under the rules' own row locks, what
 * can have changed since the quote, and records what the quote spent.
 */
export class PricingService {
  constructor(private readonly deps: PricingServiceDeps) {}

  async price(scope: TenantContext, request: PriceRequest, tx?: unknown): Promise<PricingResult> {
    /*
     * The reseller layer first (R3): `TIER_PRICE` or `USER_OVERRIDE` replaces the list
     * subtotal, and every promotion below is taken off the reseller price. Only for a
     * customer: the operator's preview without one prices the list.
     */
    const terms = !resellerLayerApplies(request)
      ? null
      : await this.deps.resellers.pricingTerms(
          scope,
          request.customerId,
          // Round 4 PR-G: a price-table tier prices the PRODUCT, so the layer is asked for
          // this product and purpose — and refuses one its table does not sell.
          {
            purpose: request.purpose,
            productId: request.productId,
            currency: request.base.currency,
          },
          tx,
        );
    const facts = await this.factsFor(scope, request, tx);
    const personal = await this.personalPercentFor(scope, request, tx);
    return quoteWith(request, terms, facts, personal);
  }

  /**
   * R11 A9 — what a customer-facing price LIST shows for the personal discount: for each
   * line, the percent and the total the checkout of that line would quote, or nothing.
   *
   * Not a second pricing implementation: every line is priced by `quoteWith`, the function
   * `price` ends in, over the same facts `price` gathers — the reseller layer
   * (`ResellerService.pricingTermsForItems`, the statement `pricingTerms` itself uses), the
   * live automatic rules, their usage, the first-purchase answer, the cashback rules and
   * the customer's percent — so "the larger single discount wins" and the reseller tiers
   * decide a listed figure exactly as they decide the invoice. The facts are read ONCE per
   * list, never per line: the reseller's price table in one query, everything else is the
   * customer's and the tenant's, the same for every line.
   *
   * A line is in the answer only when the personal discount WINS its quote
   * (`personalDiscountPercentOf`); everywhere else the list shows what it showed before —
   * the flag off, no percent, a purpose it does not apply to, or another single discount as
   * large or larger (a reseller's tier price, an automatic rule). A line the reseller's
   * table does not sell is left out, as the draft would refuse it.
   *
   * A READ: no quote, no order, no row, no lock (outside a transaction, like the operator's
   * preview); with no code, exactly as a draft is priced before a code is entered. The
   * figure is a courtesy — the draft prices again at `price` and its quote is the one
   * honoured — but it is the same figure, because it is the same function.
   */
  async personalListPrices(
    scope: TenantContext,
    request: ListPriceRequest,
  ): Promise<ReadonlyMap<string, ListedPersonalDiscount>> {
    const listed = new Map<string, ListedPersonalDiscount>();
    if (request.items.length === 0) return listed;
    const context = { purpose: request.purpose, customerId: request.customerId };
    /*
     * The personal percent first: with none (the flag off, no percent, a purpose it does not
     * apply to) no line can carry one, and the list costs one flag read and nothing else.
     */
    const personal = await this.personalPercentFor(scope, context);
    if (personal === null) return listed;

    const terms = !resellerLayerApplies(context)
      ? null
      : await this.deps.resellers.pricingTermsForItems(
          scope,
          request.customerId,
          request.purpose,
          request.items.map((item) => ({
            productId: item.productId,
            currency: item.base.currency,
          })),
        );
    const facts = await this.factsFor(scope, context);
    request.items.forEach((item, index) => {
      const layer = terms === null ? null : terms[index];
      // The draft refuses a line its reseller's table does not sell: never listed at a price.
      if (layer === undefined || layer === 'UNSELLABLE') return;
      const result = quoteWith(
        {
          base: item.base,
          purpose: request.purpose,
          productId: item.productId,
          categoryId: item.categoryId,
          customerId: request.customerId,
          now: request.now,
        },
        layer,
        facts,
        personal,
      );
      const percent = personalDiscountPercentOf(result.totals.quote);
      if (percent !== null) listed.set(item.id, { percent, price: result.totals.total });
    });
    return listed;
  }

  /**
   * Phase 4 PR-2 — the TOTAL every line of a price list would be quoted at its checkout, for the
   * support AI's live catalogue: the figure the invoice of that line will carry.
   *
   * Not a second pricing implementation, exactly as `personalListPrices` is not: every line is
   * priced by `quoteWith`, the function `price` ends in, over the facts `price` gathers — the
   * reseller layer (`pricingTermsForItems`), the live automatic rules and their usage, the
   * first-purchase answer, the cashback rules and the customer's personal percent — read ONCE
   * for the list. Where `personalListPrices` answers only for the lines the personal discount
   * wins, this answers for every line, so an automatic promotion that wins is quoted too.
   *
   * `customerId` null (an unlinked conversation): no reseller layer and no personal percent —
   * what the operator's preview without a customer prices. A line the reseller's table does
   * not sell is left out, as its draft would refuse it.
   *
   * A READ: no quote is stored, no order, no row, no lock, no code — exactly as a draft is
   * priced before a code is entered. The draft still prices again at `price`, and its quote is
   * the one honoured; it is the same figure because it is the same function over the same facts.
   */
  async quoteListPrices(
    scope: TenantContext,
    request: Omit<ListPriceRequest, 'customerId'> & { readonly customerId: string | null },
  ): Promise<
    ReadonlyMap<string, { readonly total: Money; readonly personalPercent: number | null }>
  > {
    const quoted = new Map<
      string,
      { readonly total: Money; readonly personalPercent: number | null }
    >();
    if (request.items.length === 0) return quoted;
    const context = { purpose: request.purpose, customerId: request.customerId };
    const personal = await this.personalPercentFor(scope, context);
    const terms = !resellerLayerApplies(context)
      ? null
      : await this.deps.resellers.pricingTermsForItems(
          scope,
          context.customerId,
          request.purpose,
          request.items.map((item) => ({
            productId: item.productId,
            currency: item.base.currency,
          })),
        );
    const facts = await this.factsFor(scope, context);
    request.items.forEach((item, index) => {
      const layer = terms === null ? null : terms[index];
      if (layer === undefined || layer === 'UNSELLABLE') return;
      const result = quoteWith(
        {
          base: item.base,
          purpose: request.purpose,
          productId: item.productId,
          categoryId: item.categoryId,
          customerId: request.customerId,
          now: request.now,
        },
        layer,
        facts,
        personal,
      );
      quoted.set(item.id, {
        total: result.totals.total,
        personalPercent: personalDiscountPercentOf(result.totals.quote),
      });
    });
    return quoted;
  }

  /**
   * Every fact `price` hands the engine except the reseller layer and the personal percent:
   * the live automatic rules, the entered code's rule, their live usage, the first-purchase
   * answer and the cashback rules. One statement for `price` and `personalListPrices`.
   */
  private async factsFor(
    scope: TenantContext,
    request: Pick<PriceRequest, 'purpose' | 'customerId' | 'code' | 'orderId'>,
    tx?: unknown,
  ): Promise<PricingFacts> {
    const automatic = await this.deps.discounts.listLiveAutomatic(scope, tx);
    const coded =
      request.code === undefined
        ? undefined
        : await this.deps.discounts.findByCode(scope, normaliseDiscountCode(request.code), tx);

    const candidateIds = automatic.map((r) => r.id);
    if (coded !== undefined && coded !== null) candidateIds.push(coded.id);

    const usage = await this.deps.discounts.usage(
      scope,
      candidateIds,
      request.customerId,
      request.orderId ?? null,
      tx,
    );
    /*
     * Null without a customer: the preview reports a first-purchase rule as depending on
     * one. For any purpose but `NEW_SERVICE` the question does not arise — a
     * first-purchase rule applies to new purchases only, and the engine refuses it on
     * PURPOSE before it asks — so no query is spent on it.
     */
    let isFirstPurchase: boolean | null = null;
    if (request.customerId !== null) {
      isFirstPurchase =
        request.purpose === 'NEW_SERVICE'
          ? await this.deps.discounts.isFirstPurchase(
              scope,
              request.customerId,
              request.orderId ?? null,
              tx,
            )
          : false;
    }
    const cashbackRules = await this.deps.cashbackRules.listLive(scope, tx);
    return {
      automatic,
      ...(coded === undefined ? {} : { coded }),
      usage,
      isFirstPurchase,
      cashbackRules,
    };
  }

  /**
   * The personal discount percent that takes part in this price (R10 D3), or null.
   *
   * Only for a customer (the operator's preview without one prices no customer's percent),
   * only for `PERSONAL_DISCOUNT_PURPOSES`, only while the flag is on, and only for a
   * non-zero percent. `quoteWith` hands the engine `request.base` with it — the list price,
   * before the reseller layer — because the percent is never taken off a reseller's price.
   */
  private async personalPercentFor(
    scope: TenantContext,
    request: Pick<PriceRequest, 'purpose' | 'customerId'>,
    tx?: unknown,
  ): Promise<number | null> {
    if (request.customerId === null || !personalDiscountApplies(request.purpose)) return null;
    if (!(await this.deps.featureFlags.isEnabled(scope, PERSONAL_DISCOUNT_FEATURE, tx))) {
      return null;
    }
    const percent = await this.deps.personalDiscounts.percentOf(
      scope,
      request.customerId,
      { lock: false },
      tx,
    );
    if (percent === null || percent <= 0) return null;
    return percent;
  }

  /**
   * Confirmation's re-decision of a personal discount the quote APPLIED (R10 D3).
   *
   * The same status re-decision a promotional rule gets (`redemptionRefusal`), never a
   * re-price: the flag must still be on and the customer's percent must still be the one
   * the quote was made with, read under the customer row's lock. Otherwise the order is
   * refused with `DISCOUNT_NO_LONGER_VALID` and the customer starts again — the figure they
   * were shown is never charged at a different percent, and a percent withdrawn after the
   * summary is not honoured past its withdrawal.
   *
   * A quote where the personal discount took part and LOST (`NOT_LARGER`) is not
   * re-decided: its price is the ordinary one, honoured like any other quote.
   */
  private async confirmPersonal(
    scope: TenantContext,
    order: OrderRecord,
    tx: TransactionScope,
  ): Promise<void> {
    const quoted = order.totals.quote.personalDiscount;
    const applied = order.totals.quote.trace.some((step) => step.step === 'PERSONAL_DISCOUNT');
    if (!applied) return;
    const refuse = (reason: string) =>
      errors.conflict(
        COMMERCE_ERROR_CODES.DISCOUNT_NO_LONGER_VALID,
        'A discount on this order is no longer available. Start the order again.',
        { discount: 'PERSONAL', reason },
      );
    // A trace step with no recorded decision is a quote that cannot be believed.
    if (quoted === undefined || quoted.outcome !== 'APPLIED') throw refuse('NOT_RECORDED');
    /*
     * Under the customer row's lock. `OrderService.confirm` already holds it — taken after
     * the order and BEFORE the panel, the canonical `order -> customer -> panel` (Codex,
     * PR #339) — so there this is a re-entry that waits for nothing. A renewal's
     * confirmation holds no panel lock before `redeem`, so here it is its first lock on
     * the row and still precedes anything it could close a cycle with.
     */
    const percent = await this.deps.personalDiscounts.percentOf(
      scope,
      order.customerId,
      { lock: true },
      tx,
    );
    if (!(await this.deps.featureFlags.isEnabled(scope, PERSONAL_DISCOUNT_FEATURE, tx))) {
      throw refuse('FEATURE_OFF');
    }
    if (percent !== quoted.percent) throw refuse('PERCENT_CHANGED');
  }

  /**
   * Confirmation's half (P6, P8). Runs inside the confirming transaction, after the
   * order's own lock and before the order moves to `AWAITING_PAYMENT`.
   *
   * 1. Every rule the quote applied is locked, in id order, and re-decided with
   *    `redemptionRefusal` against the usage counted now. One that no longer holds
   *    refuses the confirmation with `DISCOUNT_NO_LONGER_VALID`: the order is never
   *    re-priced, because that would charge a number the customer did not see.
   * 2. A redemption row is written per applied rule, with the amount the trace took off,
   *    and `DiscountRedeemed` goes to the outbox for each row this call wrote.
   * 3. The quote's cashback, if any, becomes a `PENDING` promise.
   *
   * Idempotent: a replay of the same confirmation writes no second row of either kind
   * and emits nothing twice, and counts none of its own rows against the limits.
   */
  async redeem(
    scope: TenantContext,
    actor: ActorContext,
    order: OrderRecord,
    now: Date,
    tx: TransactionScope,
  ): Promise<void> {
    /*
     * The reseller's purchase record, and the authoritative entitlement decision, before
     * anything is redeemed (R6, R9): a reseller whose terms or grants changed since the
     * quote is refused here and this transaction takes nothing with it.
     */
    await this.deps.resellers.recordPurchase(scope, order, now, tx);

    /*
     * R10 D3: a personal discount the quote applied is re-decided — flag still on, percent
     * unchanged — before anything is redeemed, under the customer row's lock.
     */
    await this.confirmPersonal(scope, order, tx);

    const applied = order.totals.quote.trace.filter(
      (step) => step.step === 'PROMOTIONAL_DISCOUNT' && step.ruleId !== null,
    );

    /*
     * The first-purchase lock is taken by EVERY confirmation whose order the first-purchase
     * query counts, not only by one redeeming a first-purchase rule. A plain purchase that
     * skips it can move to AWAITING_PAYMENT while a discounted one is reading "no earlier
     * purchase", and both commit (Codex, PR #88). Taken after the rule locks, as before.
     */
    const countsAsPurchase = FIRST_PURCHASE_PURPOSES.includes(order.purpose);

    if (applied.length === 0 && countsAsPurchase) {
      await this.deps.discounts.lockFirstPurchase(scope, order.customerId, tx);
    }

    if (applied.length > 0) {
      const ids = [...new Set(applied.map((step) => step.ruleId as string))].sort();
      const rules = new Map(
        (await this.deps.discounts.lockForRedemption(scope, ids, tx)).map((r) => [r.id, r]),
      );

      const firstPurchaseRule = [...rules.values()].some((r) => r.firstPurchaseOnly);
      if (firstPurchaseRule || countsAsPurchase) {
        // After the rule locks: see `lockFirstPurchase`.
        await this.deps.discounts.lockFirstPurchase(scope, order.customerId, tx);
      }
      let isFirstPurchase = true;
      if (firstPurchaseRule) {
        isFirstPurchase = await this.deps.discounts.isFirstPurchase(
          scope,
          order.customerId,
          order.id,
          tx,
        );
      }

      const usage = await this.deps.discounts.usage(scope, ids, order.customerId, order.id, tx);
      for (const id of ids) {
        const rule = rules.get(id);
        const reason =
          rule === undefined
            ? 'INACTIVE'
            : redemptionRefusal(
                rule,
                now,
                usage.get(id) ?? { live: 0, liveForCustomer: 0 },
                isFirstPurchase,
              );
        if (reason !== null) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.DISCOUNT_NO_LONGER_VALID,
            'A discount on this order is no longer available. Start the order again.',
            { discountId: id, reason },
          );
        }
      }

      for (const step of applied) {
        const rule = rules.get(step.ruleId as string);
        if (rule === undefined) continue;
        const amount = money(
          step.amountBefore.amountMinor - step.amountAfter.amountMinor,
          order.totals.currency,
        );
        const wrote = await this.deps.discounts.recordRedemption(
          scope,
          {
            id: this.deps.ids.uuid(),
            discountId: rule.id,
            customerId: order.customerId,
            orderId: order.id,
            amount,
            now,
          },
          tx,
        );
        if (wrote) {
          await this.deps.outbox.write(tx, actor, {
            eventType: 'DiscountRedeemed',
            aggregateType: 'Discount',
            aggregateId: rule.id,
            payload: {
              customerId: order.customerId,
              orderId: order.id,
              discountId: rule.id,
              code: rule.code,
              amountMinor: amount.amountMinor.toString(),
              currency: amount.currency,
            },
          });
        }
      }
    }

    const cashback = order.totals.quote.cashback;
    if (cashback !== undefined && isDiscountablePurpose(order.purpose)) {
      await this.deps.orderCashback.promise(
        scope,
        {
          id: this.deps.ids.uuid(),
          orderId: order.id,
          customerId: order.customerId,
          cashback,
          now,
        },
        tx,
      );
    }

    // 4. The referrer's commission, if the buyer was referred. Not a price: nothing the
    //    customer pays depends on it (WP9 F1).
    await this.deps.referrals.promise(scope, order, now, tx);
  }
}
