import {
  COMMERCE_ERROR_CODES,
  errors,
  isDiscountablePurpose,
  money,
  normaliseDiscountCode,
  type ActorContext,
  type DiscountablePurpose,
  type IdGenerator,
  type TenantContext,
} from '@nexa/contracts';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { OrderRecord, OrderTotalsRecord } from '../../orders/application/ports.js';
import {
  applyAdjustments,
  redemptionRefusal,
  type PricingResult,
} from '../domain/pricing-engine.js';
import type {
  CashbackRuleRepository,
  DiscountRepository,
  OrderCashbackRepository,
} from './ports.js';

export interface PricingServiceDeps {
  readonly discounts: DiscountRepository;
  readonly cashbackRules: CashbackRuleRepository;
  readonly orderCashback: OrderCashbackRepository;
  readonly outbox: OutboxWriter;
  readonly ids: IdGenerator;
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

    return applyAdjustments({
      base: request.base,
      subject: {
        purpose: request.purpose,
        productId: request.productId,
        categoryId: request.categoryId,
        customerId: request.customerId,
        isFirstPurchase,
        now: request.now,
      },
      automatic,
      ...(coded === undefined ? {} : { coded }),
      usage,
      cashbackRules,
    });
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
    const applied = order.totals.quote.trace.filter(
      (step) => step.step === 'PROMOTIONAL_DISCOUNT' && step.ruleId !== null,
    );

    if (applied.length > 0) {
      const ids = [...new Set(applied.map((step) => step.ruleId as string))].sort();
      const rules = new Map(
        (await this.deps.discounts.lockForRedemption(scope, ids, tx)).map((r) => [r.id, r]),
      );

      let isFirstPurchase = true;
      if ([...rules.values()].some((r) => r.firstPurchaseOnly)) {
        // After the rule locks, and only here: see `lockFirstPurchase`.
        await this.deps.discounts.lockFirstPurchase(scope, order.customerId, tx);
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
  }
}
