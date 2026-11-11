import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  MINIAPP_API_PREFIX,
  MINIAPP_ROUTES,
  miniAppCaptchaAnswerRequestSchema,
  miniAppSessionRequestSchema,
  miniAppTermsAcceptRequestSchema,
  money,
  telegramChannelJoinUrl,
  type MiniAppCaptchaResult,
  type MiniAppMeResponse,
  type MiniAppSessionResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import type { StartCaptchaOutcome } from '../../modules/commerce/customers/application/start-captcha.service.js';
import type {
  MiniAppContext,
  MiniAppGateState,
} from '../../modules/commerce/miniapp/application/miniapp-session.service.js';
import {
  miniAppCall,
  miniAppKey,
  notFound,
  parseWith,
  sessionCorrelation,
  sessionRateLimit,
} from './miniapp-request.js';
import { wire } from './projections.js';

type MiniAppCaptchaQuestion = NonNullable<
  Extract<NonNullable<MiniAppMeResponse['gate']>, { kind: 'CAPTCHA' }>['question']
>;

/**
 * The mini app's session and identity routes (Round 9, C5): the launch exchange, `/me`, the
 * membership re-check, accepting the terms, and the support screen. The last four are the
 * routes the bot also lets a held customer reach (support, help, the check, the accept
 * button) and they are therefore not gated; everything else is.
 */
/**
 * The refresh request's identity: the same whichever question a retry finds (a swapped picture
 * has a new id), so one idempotency key replays the first outcome instead of clashing.
 */
const REFRESH_IDENTITY = 'MINIAPP_CAPTCHA_REFRESH';

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

  /**
   * `captcha.kind` IMAGE_NUMBER: the PNG of the session's pending question, drawn again from
   * the row (never stored, never on disk) and never cached. The session is authenticated
   * first, so without one nothing is drawn; a customer with no picture question to answer —
   * not held, another kind, expired or in a cooldown — gets the one not-found answer.
   */
  @Get(MINIAPP_ROUTES.captchaImage)
  async captchaImage(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const call = await miniAppCall(this.container, request, { gated: false });
    const drawn = await this.container.startCaptcha.renderImage(
      call.context.scope,
      call.context.customer.id,
    );
    if (drawn === null) throw notFound();
    await reply
      .header('Content-Type', 'image/png')
      .header('Cache-Control', 'no-store, no-cache, max-age=0')
      .header('Pragma', 'no-cache')
      .send(Buffer.from(drawn.png));
  }

  /** The digits typed under the picture, judged exactly as the bot judges a typed answer. */
  @Post(MINIAPP_ROUTES.captchaAnswer)
  async captchaAnswer(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<MiniAppCaptchaResult> {
    const call = await miniAppCall(this.container, request, { gated: false });
    const input = parseWith(miniAppCaptchaAnswerRequestSchema, body);
    const outcome = await this.container.startCaptcha.answerText(
      call.context.scope,
      call.actor,
      call.context.customer.id,
      { idempotencyKey: miniAppKey(request, call, 'captcha'), text: input.text },
    );
    return this.captchaResult(call, outcome);
  }

  /**
   * «🔄 تصویر جدید»: a new picture, not a spent attempt. It also renews a question that has
   * expired, so the mini app never has to leave for the bot to be asked again.
   */
  @Post(MINIAPP_ROUTES.captchaRefresh)
  async captchaRefresh(@Req() request: FastifyRequest): Promise<MiniAppCaptchaResult> {
    const call = await miniAppCall(this.container, request, { gated: false });
    const { startCaptcha } = this.container;
    const key = miniAppKey(request, call, 'captcha');
    const shown = await startCaptcha.peek(call.context.scope, call.context.customer.id);
    const outcome: StartCaptchaOutcome =
      shown === null
        ? { kind: 'FREE' }
        : shown.state === 'CURRENT'
          ? await startCaptcha.refresh(call.context.scope, call.actor, call.context.customer.id, {
              idempotencyKey: key,
              challengeId: shown.question.challengeId,
              requestIdentity: REFRESH_IDENTITY,
            })
          : // Expired or in a cooldown: `present` renews or reports it, as the bot's turn does.
            await startCaptcha.present(call.context.scope, call.actor, call.context.customer.id, {
              idempotencyKey: key,
              requestIdentity: REFRESH_IDENTITY,
            });
    return this.captchaResult(call, outcome);
  }

  private async captchaResult(
    call: Awaited<ReturnType<typeof miniAppCall>>,
    outcome: StartCaptchaOutcome,
  ): Promise<MiniAppCaptchaResult> {
    const gate = await this.container.miniApp.sessions.gateFor(call.context, call.correlationId);
    return {
      result:
        outcome.kind === 'ASK'
          ? outcome.reason === 'WRONG'
            ? 'WRONG'
            : outcome.reason === 'REFRESHED'
              ? 'REFRESHED'
              : outcome.reason === 'CURRENT'
                ? 'CURRENT'
                : 'RENEWED'
          : outcome.kind,
      remaining: outcome.kind === 'ASK' ? outcome.remaining : null,
      minutes: outcome.kind === 'LOCKED' ? outcome.minutes : null,
      me: await this.meOf(call.context, gate, call),
    };
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

  /** The captcha gate with the question the customer is held at (read-only). */
  private async captchaGate(
    context: MiniAppContext,
  ): Promise<{ kind: 'CAPTCHA'; question?: MiniAppCaptchaQuestion }> {
    const shown = await this.container.startCaptcha.peek(context.scope, context.customer.id);
    if (shown === null) return { kind: 'CAPTCHA' };
    return {
      kind: 'CAPTCHA',
      question: {
        kind: shown.question.kind,
        state: shown.state,
        refreshesLeft: shown.question.refreshesLeft,
      },
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
    // NEXA v095 PR-4 C: what the mini app polls after `requestContact()`.
    const phoneVerified = context.customer.phoneVerifiedAt !== null;
    // NEXA v099: a number stored as NOT accepted, while IRAN_ONLY still refuses it.
    const phoneNotAccepted = await this.container.miniApp.sessions.phoneNotAccepted(context);
    if (gate !== null) {
      return {
        customer,
        botLink,
        phoneVerified,
        phoneNotAccepted,
        gate:
          gate.kind === 'CAPTCHA'
            ? await this.captchaGate(context)
            : gate.kind === 'BLOCKED' || gate.kind === 'PHONE' || gate.kind === 'PHONE_NOT_ACCEPTED'
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
      phoneVerified,
      phoneNotAccepted,
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
