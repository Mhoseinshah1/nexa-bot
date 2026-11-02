import { Body, Controller, Get, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  COMMERCE_ERROR_CODES,
  MINIAPP_API_PREFIX,
  MINIAPP_ERROR_CODES,
  MINIAPP_ROUTES,
  errors,
  miniAppCreateOrderRequestSchema,
  miniAppDiscountRequestSchema,
  miniAppGatewayPayRequestSchema,
  miniAppPageQuerySchema,
  miniAppUsernameRequestSchema,
  toWire,
  type MiniAppCardInstruction,
  type MiniAppCategoriesResponse,
  type MiniAppCategoryResponse,
  type MiniAppGatewayAttempt,
  type MiniAppOrder,
  type MiniAppPaymentRoutesResponse,
  type MiniAppProduct,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import type { OrderRecord } from '../../modules/commerce/orders/application/ports.js';
import { miniAppCall, miniAppKey, owned, parseWith, type MiniAppCall } from './miniapp-request.js';
import { attemptWire, instructionWire, orderWire, productWire } from './projections.js';

/** One catalogue page. Larger than the bot's eight rows: a screen scrolls, a keyboard does not. */
const PAGE_SIZE = 20;

/**
 * The store and checkout (Round 9, C5): the catalogue with the bot's eligibility and
 * visibility, the draft and its pre-invoice, the username, a discount code, confirmation,
 * cancellation, the payment routes and the three ways to pay. Every call is the bot flow's
 * call, against the same service, with a `miniapp:` key in place of the update's.
 */
@Controller(MINIAPP_API_PREFIX)
export class MiniAppShopController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  /** The category list — what reaches it is decided in SQL, reseller tier included. */
  @Get(MINIAPP_ROUTES.categories)
  async categories(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
  ): Promise<MiniAppCategoriesResponse> {
    const call = await miniAppCall(this.container, request, { gated: true });
    const { page } = parseWith(miniAppPageQuerySchema, query);
    const result = await this.container.products.browseCategories(
      call.context.scope,
      call.actor,
      PAGE_SIZE,
      page * PAGE_SIZE,
      call.context.customer.id,
    );
    return {
      items: result.items.map((category) => ({
        id: category.id,
        name: category.name,
        emoji: category.emoji,
      })),
      page,
      hasMore: result.hasMore,
    };
  }

  @Get(MINIAPP_ROUTES.category)
  async category(
    @Req() request: FastifyRequest,
    @Param('categoryId') categoryId: string,
    @Query() query: unknown,
  ): Promise<MiniAppCategoryResponse> {
    const call = await miniAppCall(this.container, request, { gated: true });
    const { page } = parseWith(miniAppPageQuerySchema, query);
    const result = await owned(() =>
      this.container.products.browseCategory(
        call.context.scope,
        call.actor,
        categoryId,
        PAGE_SIZE,
        page * PAGE_SIZE,
        call.context.customer.id,
      ),
    );
    return {
      items: result.items
        .map(productWire)
        .filter((product): product is MiniAppProduct => product !== null),
      page,
      hasMore: result.hasMore,
    };
  }

  /**
   * A DRAFT for one product, then the username step exactly as the bot's `afterDraft`: a
   * name already reserved is kept, and a panel offering only AUTOMATIC draws one at once.
   */
  @Post(MINIAPP_ROUTES.orders)
  async createOrder(@Req() request: FastifyRequest, @Body() body: unknown): Promise<MiniAppOrder> {
    const call = await miniAppCall(this.container, request, { gated: true });
    const input = parseWith(miniAppCreateOrderRequestSchema, body);
    const key = miniAppKey(request, call, 'order');
    const order = await this.container.orders.createDraft(call.context.scope, call.actor, {
      idempotencyKey: `${key}:draft`,
      customerId: call.context.customer.id,
      productId: input.productId,
    });
    const step = await this.container.orders.usernameStep(call.context.scope, call.actor, {
      customerId: call.context.customer.id,
      orderId: order.id,
    });
    if (step.reservation === null && step.modes.length === 1 && step.modes[0] === 'AUTOMATIC') {
      await this.container.orders.chooseUsername(call.context.scope, call.actor, {
        idempotencyKey: `${key}:username`,
        customerId: call.context.customer.id,
        orderId: order.id,
        choice: { mode: 'AUTOMATIC' },
      });
    }
    return this.view(call, order);
  }

  @Get(MINIAPP_ROUTES.order)
  async order(
    @Req() request: FastifyRequest,
    @Param('orderId') orderId: string,
  ): Promise<MiniAppOrder> {
    const call = await miniAppCall(this.container, request, { gated: true });
    return this.view(call, await this.ownOrder(call, orderId));
  }

  @Post(MINIAPP_ROUTES.orderUsername)
  async username(
    @Req() request: FastifyRequest,
    @Param('orderId') orderId: string,
    @Body() body: unknown,
  ): Promise<MiniAppOrder> {
    const call = await miniAppCall(this.container, request, { gated: true });
    const input = parseWith(miniAppUsernameRequestSchema, body);
    const order = await this.ownOrder(call, orderId);
    await this.container.orders.chooseUsername(call.context.scope, call.actor, {
      idempotencyKey: `${miniAppKey(request, call, 'username')}:username`,
      customerId: call.context.customer.id,
      orderId: order.id,
      choice:
        input.mode === 'AUTOMATIC'
          ? { mode: 'AUTOMATIC' }
          : { mode: 'CUSTOM', raw: input.username },
    });
    return this.view(call, await this.ownOrder(call, orderId));
  }

  /** A code on (or off) a draft: re-quoted from the draft's own snapshot by `PricingService`. */
  @Put(MINIAPP_ROUTES.orderDiscount)
  async discount(
    @Req() request: FastifyRequest,
    @Param('orderId') orderId: string,
    @Body() body: unknown,
  ): Promise<MiniAppOrder> {
    const call = await miniAppCall(this.container, request, { gated: true });
    const input = parseWith(miniAppDiscountRequestSchema, body);
    const order = await this.ownOrder(call, orderId);
    const repriced = await this.container.orders.applyDiscountCode(call.context.scope, call.actor, {
      idempotencyKey: `${miniAppKey(request, call, 'discount')}:discount`,
      customerId: call.context.customer.id,
      orderId: order.id,
      code: input.code,
    });
    return this.view(call, repriced);
  }

  @Post(MINIAPP_ROUTES.orderConfirm)
  async confirm(
    @Req() request: FastifyRequest,
    @Param('orderId') orderId: string,
  ): Promise<MiniAppOrder> {
    const call = await miniAppCall(this.container, request, { gated: true });
    const order = await this.confirmedOrder(call, orderId, miniAppKey(request, call, 'confirm'));
    return this.view(call, order);
  }

  @Post(MINIAPP_ROUTES.orderCancel)
  async cancel(
    @Req() request: FastifyRequest,
    @Param('orderId') orderId: string,
  ): Promise<MiniAppOrder> {
    const call = await miniAppCall(this.container, request, { gated: true });
    const order = await this.ownOrder(call, orderId);
    await this.container.orders.cancelByCustomer(call.context.scope, call.actor, {
      idempotencyKey: `${miniAppKey(request, call, 'cancel')}:cancel-order`,
      customerId: call.context.customer.id,
      orderId: order.id,
    });
    return this.view(call, await this.ownOrder(call, orderId));
  }

  /** The wallet and exactly the routes the bot draws for this order — never a fixed list. */
  @Get(MINIAPP_ROUTES.orderRoutes)
  async routes(
    @Req() request: FastifyRequest,
    @Param('orderId') orderId: string,
  ): Promise<MiniAppPaymentRoutesResponse> {
    const call = await miniAppCall(this.container, request, { gated: true });
    const order = await this.ownOrder(call, orderId);
    if (order.state !== 'DRAFT' && order.state !== 'AWAITING_PAYMENT') {
      throw errors.conflict(COMMERCE_ERROR_CODES.ORDER_STATE_INVALID, 'Not payable.');
    }
    const coverage = await this.container.miniApp.checkout.walletCoverageFor(
      call.context.scope,
      call.actor,
      call.context.customer.id,
      order.totals.total,
    );
    const routes = await this.container.miniApp.checkout.orderRoutes(
      call.context.scope,
      call.context.customer.id,
      order.totals.total,
    );
    return {
      wallet: {
        balance: toWire(coverage.balance),
        sufficient: coverage.sufficient,
        shortfall: coverage.shortfall === null ? null : toWire(coverage.shortfall),
      },
      routes: await Promise.all(
        routes.map(async (route) => ({
          provider: route.provider,
          kind: route.kind,
          name: route.name,
          paysInChat: route.paysInChat,
          // R11 B5: the Stars route's invoice can also be opened here while the flag is on.
          paysInApp: await this.container.miniApp.starsInvoice.paysInApp(
            call.context.scope,
            route.provider,
          ),
        })),
      ),
    };
  }

  /**
   * Pay from the wallet: `CheckoutService.payFromWallet`, the bot's `walletPayment`. A DRAFT
   * whose total the balance does not cover is refused BEFORE it is confirmed (the shortfall
   * travels in the refusal), then the draft is confirmed through its own lane and
   * `settleFromWallet` decides — the one authoritative check, with its negative-wallet gate.
   */
  @Post(MINIAPP_ROUTES.orderPayWallet)
  async payWallet(@Req() request: FastifyRequest, @Param('orderId') orderId: string) {
    const call = await miniAppCall(this.container, request, { gated: true });
    const key = miniAppKey(request, call, 'pay-wallet');
    const before = await this.ownOrder(call, orderId);
    const paid = await this.container.miniApp.checkout.payFromWallet(
      call.context.scope,
      call.actor,
      call.context.customer.id,
      before,
      key,
    );
    if (paid.outcome === 'SHORT') {
      throw errors.conflict(COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS, 'Insufficient funds.', {
        shortfallMinor: paid.shortfall.amountMinor.toString(),
        currency: paid.shortfall.currency,
      });
    }
    return { order: await this.view(call, paid.order), paymentId: paid.payment.id };
  }

  /**
   * An online gateway: `CheckoutService.payByGateway`, the bot's `gatewayPayment`. The route
   * must be one this order is offered now — decided before a DRAFT is confirmed — then the
   * attempt.
   */
  @Post(MINIAPP_ROUTES.orderPayGateway)
  async payGateway(
    @Req() request: FastifyRequest,
    @Param('orderId') orderId: string,
    @Body() body: unknown,
  ): Promise<MiniAppGatewayAttempt> {
    const call = await miniAppCall(this.container, request, { gated: true });
    const input = parseWith(miniAppGatewayPayRequestSchema, body);
    const key = miniAppKey(request, call, 'pay-gateway');
    const before = await this.ownOrder(call, orderId);
    const paid = await this.container.miniApp.checkout.payByGateway(
      call.context.scope,
      call.actor,
      call.context.customer.id,
      before,
      key,
      input.provider,
    );
    if (paid.outcome === 'NOT_OFFERED') {
      throw errors.conflict(MINIAPP_ERROR_CODES.MINIAPP_ROUTE_UNAVAILABLE, 'Route not offered.');
    }
    return attemptWire(
      paid.attempt,
      await this.container.miniApp.starsInvoice.offersInApp(call.context, paid.attempt),
    );
  }

  /**
   * Card to card: `CheckoutService.payByCard`, the same instruction the bot sends — card and
   * the exact amount to transfer.
   */
  @Post(MINIAPP_ROUTES.orderPayCard)
  async payCard(
    @Req() request: FastifyRequest,
    @Param('orderId') orderId: string,
  ): Promise<MiniAppCardInstruction> {
    const call = await miniAppCall(this.container, request, { gated: true });
    const key = miniAppKey(request, call, 'pay-card');
    const before = await this.ownOrder(call, orderId);
    const instruction = await this.container.miniApp.checkout.payByCard(
      call.context.scope,
      call.actor,
      call.context.customer.id,
      before,
      key,
    );
    return instructionWire(instruction);
  }

  // -------------------------------------------------------------------------

  /** The customer's own order, by id and owner in one read: another's is "not found". */
  private ownOrder(call: MiniAppCall, orderId: string): Promise<OrderRecord> {
    return owned(() =>
      this.container.orders.orderForCustomer(call.context.scope, call.actor, {
        customerId: call.context.customer.id,
        orderId,
      }),
    );
  }

  private async confirmedOrder(
    call: MiniAppCall,
    orderId: string,
    key: string,
  ): Promise<OrderRecord> {
    const order = await this.ownOrder(call, orderId);
    if (order.state !== 'DRAFT') return order;
    return this.container.miniApp.checkout.confirmDraft(
      call.context.scope,
      call.actor,
      call.context.customer.id,
      order,
      key,
    );
  }

  private async view(call: MiniAppCall, order: OrderRecord): Promise<MiniAppOrder> {
    const purchase = order.purpose === 'NEW_SERVICE' || order.purpose === 'CUSTOM_SERVICE';
    const step = purchase
      ? await this.container.orders.usernameStep(call.context.scope, call.actor, {
          customerId: call.context.customer.id,
          orderId: order.id,
        })
      : null;
    const packaged =
      order.purpose === 'ADD_TRAFFIC' ||
      order.purpose === 'ADD_TIME' ||
      order.purpose === 'ADD_DEVICES' ||
      order.purpose === 'CHANGE_LOCATION';
    const display = packaged
      ? null
      : await this.container.miniApp.productDisplay.displayFor(
          call.context.scope,
          order.line.productId,
        );
    return orderWire(order, {
      username: step?.reservation?.username ?? null,
      usernameModes:
        step === null || step.reservation !== null || order.state !== 'DRAFT' ? [] : step.modes,
      display,
      serviceId: null,
    });
  }
}
