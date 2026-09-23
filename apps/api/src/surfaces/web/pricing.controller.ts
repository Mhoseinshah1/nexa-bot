import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  CASHBACK_RULE_ROUTES,
  DISCOUNT_ROUTES,
  PRICE_PREVIEW_ROUTE,
  cashbackRuleListQuerySchema,
  cashbackRuleWriteSchema,
  discountListQuerySchema,
  discountStatusRequestSchema,
  discountWriteSchema,
  pricePreviewQuerySchema,
  type CashbackRuleListResponse,
  type CashbackRuleResponse,
  type CashbackRuleSummaryResponse,
  type CashbackRuleWriteRequest,
  type DiscountListResponse,
  type DiscountResponse,
  type DiscountSummaryResponse,
  type DiscountWriteRequest,
  type OrderPricingResponse,
  type PricePreviewResponse,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { singleValued } from './query.js';
import { decodeKeysetCursor, encodeKeysetCursor } from './keyset-cursor.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import { priceQuoteToWire } from '../../modules/commerce/orders/application/order-pricing.js';
import type {
  CashbackRuleRecord,
  CashbackRuleWrite,
  DiscountRuleWrite,
  RuleCursor,
} from '../../modules/commerce/pricing/application/ports.js';
import type { DiscountListing } from '../../modules/commerce/pricing/application/discount-admin.service.js';
import type { OrderPricing } from '../../modules/commerce/pricing/application/pricing-read.service.js';

/**
 * Discounts, cashback rules, the price preview and an order's pricing, over HTTP (WP8).
 *
 * Authentication here; AUTHORIZATION in the three services — `catalog.view` to read a
 * rule or preview a price, `catalog.discounts.edit` to write a discount,
 * `catalog.pricing.edit` to write a cashback rule, `orders.view` for an order's
 * pricing. Nothing is protected by the Web Admin not drawing a button.
 *
 * Every path is a literal, never a client URL builder called with `':id'` — the
 * builder encodes the colon, and the route it registers matches nothing
 * (`tests/integration/route-registration.test.ts`).
 */
@Controller(`${API_PREFIX}`)
export class PricingController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  // --- Discounts -------------------------------------------------------------

  @Get(DISCOUNT_ROUTES.list)
  async listDiscounts(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<DiscountListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const query = singleValued(raw);
    const page = discountListQuerySchema.parse({
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.status === undefined ? {} : { status: query.status }),
    });
    const result = await this.container.discounts.list(scope, actor, {
      ...(page.limit === undefined ? {} : { limit: page.limit }),
      ...(page.cursor === undefined ? {} : { cursor: cursorFrom(page.cursor) }),
      search: {
        ...(page.kind === undefined ? {} : { kind: page.kind }),
        ...(page.status === undefined ? {} : { status: page.status }),
      },
    });
    return {
      discounts: result.items.map(toDiscountSummary),
      nextCursor: result.nextCursor === null ? null : encodeKeysetCursor(result.nextCursor),
    };
  }

  @Post(DISCOUNT_ROUTES.create)
  async createDiscount(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<DiscountResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = discountWriteSchema.parse(body);
    const listing = await this.container.discounts.create(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      write: discountWriteFrom(command),
    });
    return { discount: toDiscountSummary(listing) };
  }

  @Get('discounts/:id')
  async discountDetail(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<DiscountResponse> {
    const { scope, actor } = await this.authenticate(request);
    return { discount: toDiscountSummary(await this.container.discounts.get(scope, actor, id)) };
  }

  @Post('discounts/:id')
  async updateDiscount(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<DiscountResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = discountWriteSchema.parse(body);
    const listing = await this.container.discounts.update(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      discountId: id,
      write: discountWriteFrom(command),
    });
    return { discount: toDiscountSummary(listing) };
  }

  @Post('discounts/:id/activate')
  async activateDiscount(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<DiscountResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = discountStatusRequestSchema.parse(body);
    const listing = await this.container.discounts.activate(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      discountId: id,
    });
    return { discount: toDiscountSummary(listing) };
  }

  @Post('discounts/:id/deactivate')
  async deactivateDiscount(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<DiscountResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = discountStatusRequestSchema.parse(body);
    const listing = await this.container.discounts.deactivate(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      discountId: id,
    });
    return { discount: toDiscountSummary(listing) };
  }

  // --- Cashback rules --------------------------------------------------------

  @Get(CASHBACK_RULE_ROUTES.list)
  async listCashbackRules(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<CashbackRuleListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const query = singleValued(raw);
    const page = cashbackRuleListQuerySchema.parse({
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.status === undefined ? {} : { status: query.status }),
    });
    const result = await this.container.cashbackRules.list(scope, actor, {
      ...(page.limit === undefined ? {} : { limit: page.limit }),
      ...(page.cursor === undefined ? {} : { cursor: cursorFrom(page.cursor) }),
      ...(page.status === undefined ? {} : { status: page.status }),
    });
    return {
      rules: result.items.map(toCashbackSummary),
      nextCursor: result.nextCursor === null ? null : encodeKeysetCursor(result.nextCursor),
    };
  }

  @Post(CASHBACK_RULE_ROUTES.create)
  async createCashbackRule(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<CashbackRuleResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = cashbackRuleWriteSchema.parse(body);
    const rule = await this.container.cashbackRules.create(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      write: cashbackWriteFrom(command),
    });
    return { rule: toCashbackSummary(rule) };
  }

  @Get('cashback-rules/:id')
  async cashbackRuleDetail(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<CashbackRuleResponse> {
    const { scope, actor } = await this.authenticate(request);
    return { rule: toCashbackSummary(await this.container.cashbackRules.get(scope, actor, id)) };
  }

  @Post('cashback-rules/:id')
  async updateCashbackRule(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CashbackRuleResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = cashbackRuleWriteSchema.parse(body);
    const rule = await this.container.cashbackRules.update(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      ruleId: id,
      write: cashbackWriteFrom(command),
    });
    return { rule: toCashbackSummary(rule) };
  }

  @Post('cashback-rules/:id/activate')
  async activateCashbackRule(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CashbackRuleResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = discountStatusRequestSchema.parse(body);
    const rule = await this.container.cashbackRules.activate(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      ruleId: id,
    });
    return { rule: toCashbackSummary(rule) };
  }

  @Post('cashback-rules/:id/deactivate')
  async deactivateCashbackRule(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CashbackRuleResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = discountStatusRequestSchema.parse(body);
    const rule = await this.container.cashbackRules.deactivate(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      ruleId: id,
    });
    return { rule: toCashbackSummary(rule) };
  }

  // --- Reads -----------------------------------------------------------------

  /** A GET that writes nothing: the preview holds no lock and records no redemption. */
  @Get(PRICE_PREVIEW_ROUTE)
  async preview(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<PricePreviewResponse> {
    const { scope, actor } = await this.authenticate(request);
    const query = singleValued(raw);
    const parsed = pricePreviewQuerySchema.parse({
      ...(query.purpose === undefined ? {} : { purpose: query.purpose }),
      ...(query.productId === undefined ? {} : { productId: query.productId }),
      ...(query.addonId === undefined ? {} : { addonId: query.addonId }),
      ...(query.customerId === undefined ? {} : { customerId: query.customerId }),
      ...(query.code === undefined ? {} : { code: query.code }),
    });
    const result = await this.container.pricingRead.preview(scope, actor, {
      purpose: parsed.purpose,
      ...(parsed.productId === undefined ? {} : { productId: parsed.productId }),
      ...(parsed.addonId === undefined ? {} : { addonId: parsed.addonId }),
      ...(parsed.customerId === undefined ? {} : { customerId: parsed.customerId }),
      ...(parsed.code === undefined ? {} : { code: parsed.code }),
    });
    return {
      quote: priceQuoteToWire(result.totals.quote),
      subtotalAmount: result.totals.subtotal.amountMinor.toString(),
      discountAmount: result.totals.discount.amountMinor.toString(),
      totalAmount: result.totals.total.amountMinor.toString(),
      currency: result.totals.currency,
      rules: result.outcomes.map((o) => ({
        discountId: o.rule.id,
        label: o.rule.label,
        kind: o.rule.kind,
        outcome: o.outcome,
        reason: o.reason,
      })),
      code: result.code,
    };
  }

  @Get('orders/:id/pricing')
  async orderPricing(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<OrderPricingResponse> {
    const { scope, actor } = await this.authenticate(request);
    return toOrderPricing(await this.container.pricingRead.orderPricing(scope, actor, id));
  }

  private async authenticate(
    request: FastifyRequest,
    options: { write?: boolean } = {},
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request, this.isProduction);
    if (options.write === true) {
      assertOriginAllowed(request, this.container.config.WEB_ADMIN_ORIGINS);
    }
    const { admin, session } = await this.container.auth.authenticate(token);
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    // A rule belongs to the TENANT, like the catalogue it prices: one set of rules for
    // every bot the tenant runs.
    return {
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }

  private get isProduction(): boolean {
    return this.container.config.NODE_ENV === 'production';
  }
}

function cursorFrom(raw: string): RuleCursor {
  const position = decodeKeysetCursor(raw);
  return { createdAt: position.createdAt, id: position.id };
}

function date(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

/** The wire shape as the application's write. The schema has already refused every bad combination. */
function discountWriteFrom(command: DiscountWriteRequest): DiscountRuleWrite {
  return {
    kind: command.kind,
    code: command.code,
    label: command.label,
    type: command.type,
    value: BigInt(command.value),
    currency: command.currency,
    appliesTo: command.appliesTo,
    productId: command.productId,
    categoryId: command.categoryId,
    customerId: command.customerId,
    firstPurchaseOnly: command.firstPurchaseOnly,
    minimumSubtotal:
      command.minimumSubtotalAmount === null ? null : BigInt(command.minimumSubtotalAmount),
    startsAt: date(command.startsAt),
    endsAt: date(command.endsAt),
    totalLimit: command.totalRedemptionsLimit,
    perCustomerLimit: command.perCustomerLimit,
    priority: command.priority,
    stackable: command.stackable,
  };
}

function cashbackWriteFrom(command: CashbackRuleWriteRequest): CashbackRuleWrite {
  return {
    label: command.label,
    percent: command.percent,
    appliesTo: command.appliesTo,
    productId: command.productId,
    categoryId: command.categoryId,
    startsAt: date(command.startsAt),
    endsAt: date(command.endsAt),
  };
}

/** The only discount → JSON conversion on this surface. Amounts are text: JSON has one number type. */
function toDiscountSummary(listing: DiscountListing): DiscountSummaryResponse {
  const rule = listing.rule;
  return {
    id: rule.id,
    kind: rule.kind,
    code: rule.code,
    label: rule.label,
    type: rule.type,
    value: rule.value.toString(),
    currency: rule.currency,
    appliesTo: [...rule.appliesTo],
    productId: rule.productId,
    categoryId: rule.categoryId,
    customerId: rule.customerId,
    firstPurchaseOnly: rule.firstPurchaseOnly,
    minimumSubtotalAmount: rule.minimumSubtotal?.toString() ?? null,
    startsAt: rule.startsAt?.toISOString() ?? null,
    endsAt: rule.endsAt?.toISOString() ?? null,
    totalRedemptionsLimit: rule.totalLimit,
    perCustomerLimit: rule.perCustomerLimit,
    priority: rule.priority,
    stackable: rule.stackable,
    status: rule.status,
    liveRedemptions: listing.liveRedemptions,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  };
}

function toCashbackSummary(rule: CashbackRuleRecord): CashbackRuleSummaryResponse {
  return {
    id: rule.id,
    label: rule.label,
    percent: rule.percent,
    appliesTo: [...rule.appliesTo],
    productId: rule.productId,
    categoryId: rule.categoryId,
    startsAt: rule.startsAt?.toISOString() ?? null,
    endsAt: rule.endsAt?.toISOString() ?? null,
    status: rule.status,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  };
}

/**
 * The stored quote's adjustments beside the two tables that say what became of them.
 *
 * `cashback` comes from the QUOTE, so a draft shows what it would earn with a null
 * `state`; the promise row, once confirmation wrote it, supplies the state and the
 * running figures. A promise without a quote cashback cannot exist — the promise is
 * written from the quote.
 */
function toOrderPricing(pricing: OrderPricing): OrderPricingResponse {
  const { order } = pricing;
  const quoted = order.totals.quote.cashback;
  const promise = pricing.cashback?.promise ?? null;
  const reversals = pricing.cashback?.reversals ?? [];
  const reseller = pricing.reseller;
  return {
    reseller:
      reseller === null
        ? null
        : {
            resellerCustomerId: reseller.resellerCustomerId,
            tierId: reseller.tierId,
            tierName: reseller.tierName,
            layer: reseller.layer,
            percent: reseller.percent,
            listAmount: reseller.listAmount.toString(),
            costAmount: reseller.costAmount.toString(),
            promotionAmount: reseller.promotionAmount.toString(),
            saleAmount: reseller.saleAmount.toString(),
            marginAmount: reseller.marginAmount.toString(),
            botInstanceId: reseller.botInstanceId,
            createdAt: reseller.createdAt.toISOString(),
          },
    orderId: order.id,
    discountCode: order.discountCode,
    subtotalAmount: order.totals.subtotal.amountMinor.toString(),
    discountAmount: order.totals.discount.amountMinor.toString(),
    totalAmount: order.totals.total.amountMinor.toString(),
    currency: order.totals.currency,
    adjustments: order.totals.quote.trace
      .filter((step) => step.step === 'PROMOTIONAL_DISCOUNT')
      .map((step) => ({
        ruleId: step.ruleId,
        label: step.ruleLabel,
        amountBefore: step.amountBefore.amountMinor.toString(),
        amountAfter: step.amountAfter.amountMinor.toString(),
      })),
    redemptions: pricing.redemptions.map((r) => ({
      discountId: r.discountId,
      amount: r.amount.amountMinor.toString(),
      createdAt: r.createdAt.toISOString(),
    })),
    cashback:
      quoted === undefined
        ? null
        : {
            ruleId: quoted.ruleId,
            label: quoted.ruleLabel,
            percent: quoted.percent,
            promisedAmount: quoted.amount.amountMinor.toString(),
            state: promise?.state ?? null,
            earnedAmount: (promise?.earnedAmount ?? 0n).toString(),
            reversedAmount: reversals.reduce((sum, r) => sum + r.due, 0n).toString(),
            unrecoveredAmount: reversals.reduce((sum, r) => sum + r.unrecovered, 0n).toString(),
          },
  };
}
