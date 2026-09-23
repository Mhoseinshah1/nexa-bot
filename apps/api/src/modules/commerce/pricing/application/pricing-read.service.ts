import {
  COMMERCE_ERROR_CODES,
  MAX_ORDER_QUANTITY,
  errors,
  orderIdSchema,
  productIdSchema,
  serviceAddonIdSchema,
  uuidV7Schema,
  type ActorContext,
  type Clock,
  type DiscountablePurpose,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import type { ProductRepository } from '../../catalog/application/ports.js';
import type { ServiceAddonRepository } from '../../catalog/application/addon-ports.js';
import type { CustomerRepository } from '../../customers/application/ports.js';
import type {
  OrderRecord,
  OrderRepository,
  OrderTotalsRecord,
} from '../../orders/application/ports.js';
import { quoteAddon, quoteProduct } from '../../orders/application/order-pricing.js';
import { ORDER_VIEW_PERMISSION } from '../../orders/application/order.service.js';
import type { PricingResult } from '../domain/pricing-engine.js';
import type { PricingService } from './pricing.service.js';
import type {
  CashbackReversalRecord,
  DiscountRepository,
  OrderCashbackRecord,
  OrderCashbackRepository,
  RedemptionRecord,
} from './ports.js';
import { DISCOUNT_VIEW_PERMISSION } from './discount-admin.service.js';

export interface PricingReadServiceDeps {
  readonly pricing: Pick<PricingService, 'price'>;
  readonly products: Pick<ProductRepository, 'findById'>;
  readonly addons: Pick<ServiceAddonRepository, 'findById'>;
  readonly customers: Pick<CustomerRepository, 'findById'>;
  readonly orders: Pick<OrderRepository, 'findById'>;
  readonly discounts: Pick<DiscountRepository, 'redemptionsForOrder'>;
  readonly orderCashback: Pick<OrderCashbackRepository, 'findByOrder' | 'reversals'>;
  readonly guard: PermissionGuard;
  readonly clock: Clock;
}

export interface PreviewRequest {
  readonly purpose: DiscountablePurpose;
  readonly productId?: string;
  readonly addonId?: string;
  readonly customerId?: string;
  readonly code?: string;
}

export interface PreviewResult extends PricingResult {
  readonly base: OrderTotalsRecord;
}

export interface OrderPricing {
  readonly order: OrderRecord;
  readonly redemptions: readonly RedemptionRecord[];
  /** Null when no promise was recorded — a draft, or a quote that promised nothing. */
  readonly cashback: {
    readonly promise: OrderCashbackRecord;
    readonly reversals: readonly CashbackReversalRecord[];
  } | null;
}

/**
 * The two things an operator READS about pricing (`docs/wp8-pricing-audit.md` P12).
 *
 * `preview` runs the SAME `PricingService.price` checkout runs — not a copy of it — and
 * outside any transaction, so it writes nothing, records no redemption and holds no
 * lock. It prices a product or add-on whatever its status, because "what would this
 * cost if I switched it on" is the question an operator asks before switching it on;
 * the offer checks are checkout's, and they say no there.
 *
 * `orderPricing` is the stored quote plus the two tables that record what happened to
 * it — the redemptions confirmation wrote and the cashback promise with its reversals —
 * under `orders.view`, because it is a view of an order.
 */
export class PricingReadService {
  constructor(private readonly deps: PricingReadServiceDeps) {}

  async preview(
    scope: TenantContext,
    actor: ActorContext,
    request: PreviewRequest,
  ): Promise<PreviewResult> {
    await this.deps.guard.check(scope, actor, DISCOUNT_VIEW_PERMISSION);
    const now = this.deps.clock.now();

    let customerId: UserId | null = null;
    if (request.customerId !== undefined) {
      const customer = await this.deps.customers.findById(
        scope,
        this.validId(request.customerId, 'customer') as UserId,
      );
      if (customer === null) {
        throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
      }
      customerId = customer.id;
    }

    let base: OrderTotalsRecord;
    let productId: string | null = null;
    let categoryId: string | null = null;

    if (request.purpose === 'NEW_SERVICE' || request.purpose === 'RENEW') {
      const parsed = productIdSchema.safeParse(request.productId);
      if (!parsed.success) throw invalid('That is not a valid product identifier.');
      const product = await this.deps.products.findById(scope, parsed.data);
      if (product === null) {
        throw errors.notFound(COMMERCE_ERROR_CODES.PRODUCT_NOT_FOUND, 'Unknown product.');
      }
      if (product.price === null) {
        throw errors.conflict(
          COMMERCE_ERROR_CODES.PRODUCT_NOT_PURCHASABLE,
          'This product has no price to preview.',
        );
      }
      base = quoteProduct(product, product.price, MAX_ORDER_QUANTITY, now);
      productId = product.id;
      categoryId = product.categoryId;
    } else {
      const parsed = serviceAddonIdSchema.safeParse(request.addonId);
      if (!parsed.success) throw invalid('That is not a valid add-on identifier.');
      const addon = await this.deps.addons.findById(scope, parsed.data);
      if (addon === null) {
        throw errors.notFound(COMMERCE_ERROR_CODES.ADDON_NOT_FOUND, 'Unknown add-on.');
      }
      if (addon.kind !== request.purpose || addon.price === null) {
        throw errors.conflict(
          COMMERCE_ERROR_CODES.ADDON_NOT_PURCHASABLE,
          'That package cannot be priced for this purpose.',
        );
      }
      // An add-on has no product and no category, exactly as `quoteAddon` prices it at
      // checkout: a product- or category-scoped rule is refused on scope.
      base = quoteAddon(addon.price, now);
    }

    const result = await this.deps.pricing.price(scope, {
      base,
      purpose: request.purpose,
      productId,
      categoryId,
      customerId,
      ...(request.code === undefined ? {} : { code: request.code }),
      now,
    });
    return { ...result, base };
  }

  async orderPricing(scope: TenantContext, actor: ActorContext, id: string): Promise<OrderPricing> {
    await this.deps.guard.check(scope, actor, ORDER_VIEW_PERMISSION);
    const parsed = orderIdSchema.safeParse(id);
    if (!parsed.success) throw invalid('That is not a valid order identifier.');
    const order = await this.deps.orders.findById(scope, parsed.data);
    if (order === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.ORDER_NOT_FOUND, 'Unknown order.');
    }
    const redemptions = await this.deps.discounts.redemptionsForOrder(scope, order.id);
    const promise = await this.deps.orderCashback.findByOrder(scope, order.id);
    const cashback =
      promise === null
        ? null
        : { promise, reversals: await this.deps.orderCashback.reversals(scope, promise.id) };
    return { order, redemptions, cashback };
  }

  private validId(candidate: string, what: string): string {
    const parsed = uuidV7Schema.safeParse(candidate);
    if (!parsed.success) throw invalid(`That is not a valid ${what} identifier.`);
    return parsed.data;
  }
}

function invalid(message: string) {
  return errors.validation(COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID, message);
}
