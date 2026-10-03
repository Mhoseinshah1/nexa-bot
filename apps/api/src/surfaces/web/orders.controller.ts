import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  ORDER_ROUTES,
  classifyListSearch,
  orderListQuerySchema,
  type OrderId,
  type OrderListResponse,
  type OrderPlacementEnvelope,
  type OrderResponse,
  type OrderSummaryResponse,
  type ProductId,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, requireSessionToken } from './authenticated-request.js';
import { singleValued } from './query.js';
import { decodeKeysetCursor, encodeKeysetCursor } from './keyset-cursor.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type {
  OrderCursor,
  OrderCustomerIdentity,
  OrderRecord,
} from '../../modules/commerce/orders/application/ports.js';

/**
 * Orders over HTTP, at `/orders`. Two reads and NO writes.
 *
 * There is no cancel, no mark-paid, no refund, no settle and no fulfil, and the
 * absence is the point rather than an unfinished edge:
 *
 * - **mark-paid** would be an operator asserting money arrived, which is exactly what
 *   `settlementIsFunded` refuses to take anyone's word for. Settling happens through a
 *   confirmed payment, at `POST /payments/:id/confirm`, where the evidence and the
 *   reviewer are recorded with it.
 * - **refund** is the payments surface's, at `POST /payments/:id/refunds`, because a
 *   refund is bounded by a payment and not by an order.
 * - **fulfil** existed for one release and is gone with the state it served. An order
 *   this installation cannot deliver is refunded automatically, in the transaction
 *   that discovers it — so there is no stranded order for an operator to retry, and a
 *   button that retried one would be a button for a state no row can hold.
 *
 * A "mark paid" button with nothing behind it is the legacy silent-success pattern, and
 * it is the single easiest thing to add here by accident.
 *
 * Authentication happens here; AUTHORIZATION does not — `OrderService` charges
 * `orders.view` itself, so no endpoint is protected merely by the Web Admin not drawing
 * a link.
 */
@Controller(`${API_PREFIX}`)
export class OrdersController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(ORDER_ROUTES.list)
  async list(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<OrderListResponse> {
    const { scope, actor } = await this.authenticate(request);
    // A repeated parameter is an ARRAY, not a string — the same guard every other list
    // on this surface uses rather than trusting the schema to refuse it.
    const query = singleValued(raw);
    const page = orderListQuerySchema.parse({
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.state === undefined ? {} : { state: query.state }),
      ...(query.customerId === undefined ? {} : { customerId: query.customerId }),
      ...(query.productId === undefined ? {} : { productId: query.productId }),
      ...(query.q === undefined ? {} : { q: query.q }),
    });
    const text = page.q === undefined ? null : classifyListSearch(page.q);
    const result = await this.container.orders.list(scope, actor, {
      ...(page.limit === undefined ? {} : { limit: page.limit }),
      ...(page.cursor === undefined ? {} : { cursor: orderCursorFrom(page.cursor) }),
      search: {
        ...(page.state === undefined ? {} : { state: page.state }),
        ...(page.customerId === undefined ? {} : { customerId: page.customerId as UserId }),
        ...(page.productId === undefined ? {} : { productId: page.productId as ProductId }),
        ...(text === null ? {} : { text }),
      },
    });
    // Who each order is for, as Telegram knows them — one read for the page (spec §10).
    const identities = await this.container.orders.customerIdentities(scope, actor, result.items);
    return {
      orders: result.items.map((record) => toSummary(record, identities.get(record.customerId))),
      nextCursor: result.nextCursor === null ? null : encodeKeysetCursor(result.nextCursor),
    };
  }

  @Get('orders/:id')
  async detail(@Req() request: FastifyRequest, @Param('id') id: string): Promise<OrderResponse> {
    const { scope, actor } = await this.authenticate(request);
    // The id is NOT cast here: `OrderService.get` validates it, so a malformed path
    // segment is a 400 rather than a 500 at the `uuid` cast.
    const order = await this.container.orders.get(scope, actor, id);
    const identities = await this.container.orders.customerIdentities(scope, actor, [order]);
    return { order: toSummary(order, identities.get(order.customerId)) };
  }

  /**
   * Phase C3: why this order landed on its panel. `orders.view`, charged by the service;
   * `placement: null` for an order routed to its product's own panel explicitly.
   */
  @Get('orders/:id/placement')
  async placement(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<OrderPlacementEnvelope> {
    const { scope, actor } = await this.authenticate(request);
    const placement = await this.container.orders.placement(scope, actor, id);
    return {
      placement:
        placement === null
          ? null
          : {
              homePanelId: placement.homePanelId,
              chosenPanelId: placement.chosenPanelId,
              group: placement.group,
              strategy: placement.strategy,
              decidedBy: placement.decidedBy,
              candidates: placement.candidates.map((row) => ({ ...row })),
              decidedAt: placement.decidedAt.toISOString(),
            },
    };
  }

  private async authenticate(
    request: FastifyRequest,
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request, this.isProduction);
    const { admin, session } = await this.container.auth.authenticate(token);
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    // `botInstanceId: null`: an order belongs to the TENANT. A customer who arrived
    // through one bot and a tenant running two are the same shop.
    return {
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }

  private get isProduction(): boolean {
    return this.container.config.NODE_ENV === 'production';
  }
}

/** The shared cursor, branded for this list. A cursor this server did not mint is a 400. */
function orderCursorFrom(raw: string): OrderCursor {
  const position = decodeKeysetCursor(raw);
  return { createdAt: position.createdAt, id: position.id as OrderId };
}

/**
 * The only `OrderRecord` → JSON conversion on this surface.
 *
 * Every `line*` field is the SNAPSHOT, and the names say so: `lineTitle` is what the
 * customer bought, not what the plan is called now. An operator reading this response is
 * reading the purchase, which is the question the legacy system cannot answer for any
 * order it ever took.
 */
function toSummary(
  record: OrderRecord,
  identity: OrderCustomerIdentity | undefined,
): OrderSummaryResponse {
  return {
    id: record.id,
    customerId: record.customerId,
    customerTelegramUserId: identity?.telegramUserId ?? null,
    customerUsername: identity?.username ?? null,
    state: record.state,
    purpose: record.purpose,
    productId: record.line.productId,
    panelId: record.line.panelId,
    lineTitle: record.line.title,
    // Null together, and null means unknown — never "uncategorised", and never a cue to
    // go and look up what category this product is in NOW.
    lineCategoryId: record.line.category?.categoryId ?? null,
    lineCategoryName: record.line.category?.name ?? null,
    lineCategoryEmoji: record.line.category?.emoji ?? null,
    lineDurationDays: record.line.specification.durationDays,
    // Text on the wire, for the reason `productSummarySchema` states: JSON has one
    // number type and these pass 2^53.
    lineTrafficBytes: record.line.specification.trafficBytes.toString(),
    lineDeviceLimit: record.line.specification.deviceLimit,
    lineUnitPriceAmount: record.line.unitPrice.amountMinor.toString(),
    lineQuantity: record.line.quantity,
    subtotalAmount: record.totals.subtotal.amountMinor.toString(),
    discountAmount: record.totals.discount.amountMinor.toString(),
    totalAmount: record.totals.total.amountMinor.toString(),
    currency: record.totals.currency,
    expiresAt: record.expiresAt === null ? null : record.expiresAt.toISOString(),
    confirmedAt: record.confirmedAt === null ? null : record.confirmedAt.toISOString(),
    settledAt: record.settledAt === null ? null : record.settledAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
