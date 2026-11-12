import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  RESELLER_API_PREFIX,
  RESELLER_BOT_ERROR_CODES,
  RESELLER_PANEL_ROUTES,
  errors,
  resellerOwnBotSubmitBodySchema,
  type ResellerBotRequestView,
  type ResellerOwnBotResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { parseWith, resellerCall, resellerKey } from './reseller-request.js';

/**
 * PR-6 «ربات اختصاصی» — the reseller's side of a dedicated hosted bot, on the reseller panel.
 *
 * The door is PR-4's (`resellerCall`: the Host's tenant, the `reseller_web_panel` flag — off is
 * 404 —, a write's Origin, the reseller cookie only, the reseller re-checked ACTIVE). Everything
 * after it is `ResellerBotRequestService`, exactly as the bot would call it: the token checked
 * with Telegram and sealed there, the request found by id AND the signed-in reseller's customer
 * id there (another reseller's request is the same 404 as none), the fee and the wallet there.
 * This file never reads a row and never decides who owns what.
 */
@Controller(RESELLER_API_PREFIX)
export class ResellerOwnBotController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(RESELLER_PANEL_ROUTES.ownBot)
  async overview(@Req() request: FastifyRequest): Promise<ResellerOwnBotResponse> {
    const context = await resellerCall(this.container, request);
    const bots = this.container.resellerBots;
    const offer = await bots.offer(context.scope, context.customer.id);
    const requests = await bots.listOwn(context.scope, context.customer.id);
    return { offer, requests: [...requests] } as ResellerOwnBotResponse;
  }

  @Post(RESELLER_PANEL_ROUTES.ownBotRequests)
  async submit(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<ResellerBotRequestView> {
    const context = await resellerCall(this.container, request);
    const input = parseWith(resellerOwnBotSubmitBodySchema, body);
    return this.container.resellerBots.submit(context.scope, context.actor, {
      customerId: context.customer.id,
      idempotencyKey: resellerKey(request, context, 'own-bot-submit'),
      botToken: input.botToken,
      domain: input.domain ?? null,
    });
  }

  @Post(RESELLER_PANEL_ROUTES.ownBotCancel)
  @HttpCode(200)
  async cancel(
    @Req() request: FastifyRequest,
    @Param('requestId') requestId: string,
  ): Promise<ResellerBotRequestView> {
    const context = await resellerCall(this.container, request);
    return this.container.resellerBots.cancel(context.scope, context.actor, {
      customerId: context.customer.id,
      requestId: requestIdOf(requestId),
      idempotencyKey: resellerKey(request, context, 'own-bot-cancel'),
    });
  }

  /** Pay-and-reactivate: the due period from the wallet now; no credit, never negative. */
  @Post(RESELLER_PANEL_ROUTES.ownBotPay)
  @HttpCode(200)
  async pay(
    @Req() request: FastifyRequest,
    @Param('requestId') requestId: string,
  ): Promise<ResellerBotRequestView> {
    const context = await resellerCall(this.container, request);
    return this.container.resellerBots.payAndReactivate(context.scope, context.actor, {
      customerId: context.customer.id,
      requestId: requestIdOf(requestId),
      idempotencyKey: resellerKey(request, context, 'own-bot-pay'),
    });
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * A path id that is not a UUID is the same 404 as an unknown or another reseller's request —
 * never a PostgreSQL cast error. (The idempotency key needs no id: the service's request hash
 * names it, so one key reused on another request is refused, never replayed.)
 */
function requestIdOf(raw: string): string {
  if (!UUID.test(raw)) {
    throw errors.notFound(RESELLER_BOT_ERROR_CODES.REQUEST_NOT_FOUND, 'No such request.');
  }
  return raw.toLowerCase();
}
