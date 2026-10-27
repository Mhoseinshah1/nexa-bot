import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  MINIAPP_API_PREFIX,
  MINIAPP_ROUTES,
  miniAppSessionRequestSchema,
  miniAppTermsAcceptRequestSchema,
  money,
  telegramChannelJoinUrl,
  type MiniAppMeResponse,
  type MiniAppSessionResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import type {
  MiniAppContext,
  MiniAppGateState,
} from '../../modules/commerce/miniapp/application/miniapp-session.service.js';
import {
  miniAppCall,
  miniAppKey,
  parseWith,
  sessionCorrelation,
  sessionRateLimit,
} from './miniapp-request.js';
import { wire } from './projections.js';

/**
 * The mini app's session and identity routes (Round 9, C5): the launch exchange, `/me`, the
 * membership re-check, accepting the terms, and the support screen. The last four are the
 * routes the bot also lets a held customer reach (support, help, the check, the accept
 * button) and they are therefore not gated; everything else is.
 */
@Controller(MINIAPP_API_PREFIX)
export class MiniAppSessionController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  /**
   * One verified Telegram launch → one session. The bot is the one the URL names; the
   * launch carries no bot id, and verifying it with this bot's token is what proves it.
   */
  @Post(MINIAPP_ROUTES.session)
  async session(
    @Req() request: FastifyRequest,
    @Param('botInstanceId') botInstanceId: string,
    @Body() body: unknown,
  ): Promise<MiniAppSessionResponse> {
    await sessionRateLimit(this.container, request, botInstanceId);
    const input = parseWith(miniAppSessionRequestSchema, body);
    const minted = await this.container.miniApp.sessions.mint(
      botInstanceId,
      input.initData,
      sessionCorrelation(this.container),
    );
    return { token: minted.token, expiresAt: minted.expiresAt.toISOString() };
  }

  @Get(MINIAPP_ROUTES.me)
  async me(@Req() request: FastifyRequest): Promise<MiniAppMeResponse> {
    const call = await miniAppCall(this.container, request, { gated: false });
    const gate = await this.container.miniApp.sessions.gateFor(call.context, call.correlationId);
    return this.meOf(call.context, gate, call);
  }

  /** The membership asked of Telegram again, as the bot's check button does. */
  @Post(MINIAPP_ROUTES.gateCheck)
  async gateCheck(@Req() request: FastifyRequest): Promise<MiniAppMeResponse> {
    const call = await miniAppCall(this.container, request, { gated: false });
    const gate = await this.container.miniApp.sessions.gateFor(call.context, call.correlationId, {
      fresh: true,
    });
    return this.meOf(call.context, gate, call);
  }

  /** The terms' accept button: the version is recorded only while it is still the current one. */
  @Post(MINIAPP_ROUTES.termsAccept)
  async termsAccept(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<MiniAppMeResponse> {
    const call = await miniAppCall(this.container, request, { gated: false });
    const input = parseWith(miniAppTermsAcceptRequestSchema, body);
    await this.container.termsAcceptance.accept(call.context.scope, call.actor, {
      idempotencyKey: miniAppKey(request, call, 'terms'),
      customerId: call.context.customer.id,
      termsVersionId: input.termsVersionId,
      botInstanceId: call.context.botInstanceId,
    });
    const gate = await this.container.miniApp.sessions.gateFor(call.context, call.correlationId);
    return this.meOf(call.context, gate, call);
  }

  /** The FAQ and the support account, as the bot's support screen has them. Not gated, as there. */
  @Get(MINIAPP_ROUTES.support)
  async support(@Req() request: FastifyRequest) {
    const call = await miniAppCall(this.container, request, { gated: false });
    const screen = await this.container.supportScreen.screenFor(call.context.scope);
    return {
      faqs: screen.faqs.map((faq) => ({ question: faq.question, answer: faq.answer })),
      supportUrl: screen.supportUrl,
    };
  }

  private async meOf(
    context: MiniAppContext,
    gate: MiniAppGateState,
    call: { readonly actor: Parameters<Container['wallet']['balanceForCustomer']>[1] },
  ): Promise<MiniAppMeResponse> {
    const bot = await this.container.botInstances.findById(context.botInstanceId);
    const botLink =
      bot !== null && /^[A-Za-z][A-Za-z0-9_]{4,31}$/u.test(bot.username)
        ? `https://t.me/${bot.username}`
        : null;
    const customer = { firstName: context.customer.firstName, username: context.customer.username };
    if (gate !== null) {
      return {
        customer,
        botLink,
        gate:
          gate.kind === 'BLOCKED' || gate.kind === 'CAPTCHA'
            ? { kind: gate.kind }
            : gate.kind === 'CHANNELS'
              ? {
                  kind: 'CHANNELS',
                  channels: gate.channels.flatMap((channel) => {
                    const joinUrl = telegramChannelJoinUrl(channel);
                    return joinUrl === null ? [] : [{ handle: channel.handle ?? null, joinUrl }];
                  }),
                }
              : {
                  kind: 'TERMS',
                  terms: {
                    versionId: gate.terms.id,
                    title: gate.terms.title,
                    body: gate.terms.body,
                  },
                },
        wallet: null,
        reseller: null,
        // Nothing behind a gate is read for a customer held at one; no bell either.
        notifications: null,
      };
    }
    const balance = await this.container.wallet.balanceForCustomer(
      context.scope,
      call.actor,
      context.customer.id,
    );
    const standing = await this.container.resellers.standing(
      context.scope,
      context.customer.id,
      undefined,
    );
    return {
      customer,
      botLink,
      gate: null,
      wallet: { balance: wire(money(balance.amountMinor, balance.currency)) },
      reseller: standing === null ? null : { tierName: standing.tier.name },
      // Round 11, B1: null while `notification_centre` is off, which is what hides the bell.
      notifications: await this.container.miniApp.notificationCentre.summary(
        context.scope,
        call.actor,
        { customerId: context.customer.id, botInstanceId: context.botInstanceId },
      ),
    };
  }
}
