import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  RESELLER_API_PREFIX,
  RESELLER_PANEL_ROUTES,
  money,
  resellerActivityQuerySchema,
  resellerExchangeRequestSchema,
  toWire,
  type ResellerActivityResponse,
  type ResellerExchangeResponse,
  type ResellerMeResponse,
  type ResellerPreferences,
  type ResellerSessionsResponse,
  type ResellerTotpEnrolResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import {
  clearResellerCookie,
  parseWith,
  readResellerToken,
  requestFacts,
  resellerCall,
  resellerGate,
  setResellerCookie,
} from './reseller-request.js';

/**
 * PR-4 §5.1 — the reseller panel's sign-in, its sessions and its security card, over
 * `/api/reseller/v1`. Every rule is `ResellerWebAccessService`'s; this file reads the cookie,
 * sets it, and shapes the answer.
 */
@Controller(RESELLER_API_PREFIX)
export class ResellerAccessController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  /** `/r/login` posts the token from its fragment; the answer sets the session cookie. */
  @Post(RESELLER_PANEL_ROUTES.exchange)
  @HttpCode(200)
  async exchange(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
  ): Promise<ResellerExchangeResponse> {
    const tenant = await resellerGate(this.container, request);
    await this.container.resellerWeb.loginLimiter.check(request.ip ?? null);
    const input = parseWith(resellerExchangeRequestSchema, body);
    const opened = await this.container.resellerWeb.access.exchange(
      tenant,
      requestFacts(this.container, request),
      input.token,
    );
    setResellerCookie(this.container, reply, opened.token, opened.expiresAt);
    return { state: opened.state, expiresAt: opened.expiresAt.toISOString() };
  }

  @Post(RESELLER_PANEL_ROUTES.secondFactor)
  @HttpCode(200)
  async secondFactor(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
  ): Promise<ResellerExchangeResponse> {
    const tenant = await resellerGate(this.container, request);
    await this.container.resellerWeb.loginLimiter.check(request.ip ?? null);
    const token = readResellerToken(this.container, request);
    const opened = await this.container.resellerWeb.access.secondFactor(
      tenant,
      requestFacts(this.container, request),
      token,
      body,
    );
    // The same token, now ACTIVE: the cookie's lifetime becomes the session's 90 days.
    if (token !== null) setResellerCookie(this.container, reply, token, opened.expiresAt);
    return { state: 'ACTIVE', expiresAt: opened.expiresAt.toISOString() };
  }

  @Post(RESELLER_PANEL_ROUTES.logout)
  @HttpCode(200)
  async logout(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ ok: true }> {
    const context = await resellerCall(this.container, request);
    await this.container.resellerWeb.access.logout(context);
    clearResellerCookie(this.container, reply);
    return { ok: true };
  }

  @Get(RESELLER_PANEL_ROUTES.me)
  async me(@Req() request: FastifyRequest): Promise<ResellerMeResponse> {
    const context = await resellerCall(this.container, request);
    const balance = await this.container.wallet.balanceForCustomer(
      context.scope,
      context.actor,
      context.customer.id,
    );
    const bot = await this.container.botInstances.findById(context.botInstanceId);
    return {
      customer: {
        firstName: context.customer.firstName,
        username: context.customer.username,
        telegramUserId: context.customer.telegramUserId,
      },
      reseller: {
        tierName: context.standing.tier.name,
        since: context.standing.reseller.createdAt.toISOString(),
      },
      balance: toWire(money(balance.amountMinor, balance.currency)),
      botUsername: bot?.username ?? null,
      secondFactor: await this.container.resellerWeb.access.secondFactorOn(context),
      session: { id: context.sessionId, expiresAt: context.sessionExpiresAt.toISOString() },
    };
  }

  @Get(RESELLER_PANEL_ROUTES.sessions)
  async sessions(@Req() request: FastifyRequest): Promise<ResellerSessionsResponse> {
    const context = await resellerCall(this.container, request);
    return this.container.resellerWeb.access.sessions(context);
  }

  @Post(RESELLER_PANEL_ROUTES.sessionRevoke)
  @HttpCode(200)
  async revoke(
    @Req() request: FastifyRequest,
    @Param('sessionId') sessionId: string,
  ): Promise<{ ok: true }> {
    const context = await resellerCall(this.container, request);
    await this.container.resellerWeb.access.revoke(context, sessionId);
    return { ok: true };
  }

  /** 'sign out everywhere': this one too, so the cookie is cleared. */
  @Post(RESELLER_PANEL_ROUTES.sessionsRevokeAll)
  @HttpCode(200)
  async revokeAll(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ ended: number }> {
    const context = await resellerCall(this.container, request);
    const ended = await this.container.resellerWeb.access.revokeAll(context);
    clearResellerCookie(this.container, reply);
    return { ended };
  }

  @Get(RESELLER_PANEL_ROUTES.activity)
  async activity(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
  ): Promise<ResellerActivityResponse> {
    const context = await resellerCall(this.container, request);
    const { cursor } = parseWith(resellerActivityQuerySchema, query);
    return this.container.resellerWeb.access.activity(context, cursor ?? null);
  }

  @Post(RESELLER_PANEL_ROUTES.totpEnrol)
  @HttpCode(200)
  async totpEnrol(@Req() request: FastifyRequest): Promise<ResellerTotpEnrolResponse> {
    const context = await resellerCall(this.container, request);
    return this.container.resellerWeb.access.enrolTotp(context);
  }

  @Post(RESELLER_PANEL_ROUTES.totpActivate)
  @HttpCode(200)
  async totpActivate(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<{ ended: number }> {
    const context = await resellerCall(this.container, request);
    return this.container.resellerWeb.access.activateTotp(context, body);
  }

  @Post(RESELLER_PANEL_ROUTES.totpDisable)
  @HttpCode(200)
  async totpDisable(@Req() request: FastifyRequest, @Body() body: unknown): Promise<{ ok: true }> {
    const context = await resellerCall(this.container, request);
    await this.container.resellerWeb.access.disableTotp(context, body);
    return { ok: true };
  }

  @Get(RESELLER_PANEL_ROUTES.preferences)
  async preferences(@Req() request: FastifyRequest): Promise<ResellerPreferences> {
    const context = await resellerCall(this.container, request);
    return this.container.resellerWeb.access.preferences(context);
  }

  @Put(RESELLER_PANEL_ROUTES.preferences)
  async setPreferences(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<ResellerPreferences> {
    const context = await resellerCall(this.container, request);
    return this.container.resellerWeb.access.setPreferences(context, body);
  }
}
