import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  CLIENT_APP_PLATFORMS,
  MINIAPP_API_PREFIX,
  MINIAPP_ERROR_CODES,
  MINIAPP_ROUTES,
  errors,
  fromWire,
  miniAppCursorQuerySchema,
  miniAppGiftCardRequestSchema,
  miniAppTicketCreateRequestSchema,
  miniAppTicketReplyRequestSchema,
  miniAppTopupQuoteRequestSchema,
  miniAppTopupRequestSchema,
  miniAppTrialClaimRequestSchema,
  money,
  ticketCodeOf,
  type ClientAppPlatform,
  type MiniAppGiftCardResponse,
  type MiniAppGuidePlatformResponse,
  type MiniAppReferralFriendsResponse,
  type MiniAppReferralResponse,
  type MiniAppTicketDetail,
  type MiniAppTopupQuoteResponse,
  type MiniAppTrialResponse,
  type MiniAppWalletEntries,
  type MiniAppWalletResponse,
  type TemplateKey,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import type { TicketRecord } from '../../modules/commerce/tickets/application/ports.js';
import type { WalletCursor } from '../../modules/commerce/wallet/application/ports.js';
import { decodeKeysetCursor, encodeKeysetCursor } from '../web/keyset-cursor.js';
import {
  miniAppCall,
  miniAppKey,
  notFound,
  parseWith,
  type MiniAppCall,
} from './miniapp-request.js';
import { attemptWire, instructionWire, wire } from './projections.js';

/** How many of a ticket's latest messages the conversation shows. */
const TICKET_MESSAGES_SHOWN = 30;

/** The guide a platform shows when no app is configured for it — the bot's own texts. */
const TUTORIAL_KEYS: Readonly<Partial<Record<ClientAppPlatform, TemplateKey>>> = {
  ANDROID: 'bot.tutorial.android',
  IOS: 'bot.tutorial.ios',
  WINDOWS: 'bot.tutorial.windows',
  MACOS: 'bot.tutorial.macos',
  LINUX: 'bot.tutorial.linux',
};

/**
 * The customer's account (Round 9, C5): the wallet (balance, the ledger read-only, a
 * top-up), the referral invite, the trial, support tickets and the connection guide. Each
 * is the bot flow's own service call; the ledger and the payment list are the customer's
 * own records only (owner correction 2026-10-25), read under the customer's permission.
 */
@Controller(MINIAPP_API_PREFIX)
export class MiniAppAccountController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(MINIAPP_ROUTES.wallet)
  async wallet(@Req() request: FastifyRequest): Promise<MiniAppWalletResponse> {
    const call = await miniAppCall(this.container, request, { gated: true });
    const { scope, customer } = call.context;
    const [balance, presets, limits, giftCards] = await Promise.all([
      this.container.wallet.balanceForCustomer(scope, call.actor, customer.id),
      this.container.payments.topupPresets(scope),
      this.container.miniApp.topup.limits(scope),
      this.container.giftCardRedemption.isEnabled(scope),
    ]);
    return {
      balance: wire(money(balance.amountMinor, balance.currency)),
      presets: presets.map(wire),
      minimum: limits.minimum === null ? null : wire(limits.minimum),
      maximum: limits.maximum === null ? null : wire(limits.maximum),
      giftCards,
    };
  }

  /**
   * R10 D4: a gift card typed into the wallet screen — the bot's own redemption service, so
   * the two surfaces cannot disagree. Behind the mini app's per-customer request budget as a
   * courtesy; the failed-attempt limit that matters is the service's own, counted in the
   * database. One answer for every refusal, so the endpoint is no oracle for which codes exist.
   */
  @Post(MINIAPP_ROUTES.walletGiftCard)
  async giftCard(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<MiniAppGiftCardResponse> {
    const call = await miniAppCall(this.container, request, { gated: true });
    const input = parseWith(miniAppGiftCardRequestSchema, body);
    const result = await this.container.giftCardRedemption.redeem(call.context.scope, call.actor, {
      customerId: call.context.customer.id,
      code: input.code,
      idempotencyKey: miniAppKey(request, call, 'gift-card'),
    });
    if (result.outcome === 'REDEEMED') {
      return { outcome: 'REDEEMED', amount: wire(result.amount), balance: wire(result.balance) };
    }
    return { outcome: result.outcome };
  }

  /** The customer's own ledger, newest first. Read-only: there is no write here. */
  @Get(MINIAPP_ROUTES.walletEntries)
  async entries(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
  ): Promise<MiniAppWalletEntries> {
    const call = await miniAppCall(this.container, request, { gated: true });
    const { cursor } = parseWith(miniAppCursorQuerySchema, query);
    const page = await this.container.wallet.historyForCustomer(
      call.context.scope,
      call.actor,
      call.context.customer.id,
      cursor === undefined ? {} : { cursor: decodeKeysetCursor(cursor) as WalletCursor },
    );
    return {
      items: page.items.map((entry) => ({
        id: entry.id,
        direction: entry.direction,
        reason: entry.reason,
        amount: wire(entry.amount),
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor === null ? null : encodeKeysetCursor(page.nextCursor),
    };
  }

  /** A top-up amount against the installation's floor and ceiling, and the routes for it. */
  @Post(MINIAPP_ROUTES.walletTopupQuote)
  async topupQuote(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<MiniAppTopupQuoteResponse> {
    const call = await miniAppCall(this.container, request, { gated: true });
    const input = parseWith(miniAppTopupQuoteRequestSchema, body);
    const amount = this.positive(fromWire(input.amount));
    const quoted = await this.container.miniApp.topup.quoteAmount(
      call.context.scope,
      call.context.customer.id,
      amount,
    );
    if (quoted.outcome === 'BELOW_MINIMUM')
      return { outcome: 'BELOW_MINIMUM', minimum: wire(quoted.minimum) };
    if (quoted.outcome === 'ABOVE_MAXIMUM')
      return { outcome: 'ABOVE_MAXIMUM', maximum: wire(quoted.maximum) };
    const routes = await this.container.miniApp.checkout.topupRoutes(
      call.context.scope,
      quoted.routes,
    );
    return {
      outcome: 'ROUTES',
      amount: wire(quoted.amount),
      routes: routes.map((route) => ({
        provider: route.provider,
        kind: route.kind,
        name: route.name,
        paysInChat: route.paysInChat,
        giftPercent: route.giftPercent,
      })),
    };
  }

  /** The top-up itself: the same request the bot's chooser makes, by the same descriptor rule. */
  @Post(MINIAPP_ROUTES.walletTopup)
  async topup(@Req() request: FastifyRequest, @Body() body: unknown) {
    const call = await miniAppCall(this.container, request, { gated: true });
    const input = parseWith(miniAppTopupRequestSchema, body);
    const result = await this.container.miniApp.topup.requestDirect(
      call.context.scope,
      call.actor,
      {
        customerId: call.context.customer.id,
        amount: this.positive(fromWire(input.amount)),
        provider: input.provider,
        idempotencyKey: miniAppKey(request, call, 'topup'),
      },
    );
    if (result.outcome === 'GATEWAY_REQUESTED') {
      return { kind: 'GATEWAY' as const, attempt: attemptWire(result.attempt) };
    }
    if (result.outcome === 'REQUESTED') {
      return { kind: 'CARD_TO_CARD' as const, instruction: instructionWire(result.instruction) };
    }
    throw errors.conflict(
      MINIAPP_ERROR_CODES.MINIAPP_ROUTE_UNAVAILABLE,
      'Not offered for this amount.',
      {
        outcome: result.outcome,
      },
    );
  }

  /** The invite: the program's terms, the customer's own link (minted once), and their figures. */
  @Get(MINIAPP_ROUTES.referral)
  async referral(@Req() request: FastifyRequest): Promise<MiniAppReferralResponse> {
    const call = await miniAppCall(this.container, request, { gated: true });
    const { scope, customer } = call.context;
    const terms = await this.container.referrals.terms(scope);
    if (!terms.active || terms.percent === null) return { active: false };
    const invite = await this.container.referrals.invite(scope, call.actor, {
      idempotencyKey: `miniapp:${call.context.botInstanceId}:${customer.id}:${call.context.sessionId}:referral`,
      customerId: customer.id,
      botInstanceId: call.context.botInstanceId,
    });
    if (invite.outcome !== 'READY') return { active: false };
    const stats = await this.container.referralSignupGifts.stats(scope, customer.id);
    return {
      active: true,
      commissionPercent: terms.percent,
      inviteLink: invite.link,
      stats: {
        referralCount: stats.referralCount,
        referredPurchaseCount: stats.referredPurchaseCount,
        commissionReceivedTotal: wire(stats.commissionReceivedTotal),
      },
    };
  }

  /**
   * R11 B3: the customer's OWN invited friends, newest first, one bounded page per call. The
   * referrer is the session's customer, never a parameter; the only input is the cursor. The
   * flag `referral_friends_list` is read by the service: off answers `{ enabled: false }`.
   */
  @Get(MINIAPP_ROUTES.referralFriends)
  async referralFriends(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
  ): Promise<MiniAppReferralFriendsResponse> {
    const call = await miniAppCall(this.container, request, { gated: true });
    const { cursor } = parseWith(miniAppCursorQuerySchema, query);
    const view = await this.container.referralFriends.list(
      call.context.scope,
      call.actor,
      call.context.customer.id,
      cursor === undefined ? null : decodeKeysetCursor(cursor),
    );
    if (!view.enabled) return { enabled: false };
    return {
      enabled: true,
      counts: view.counts,
      items: view.items.map((friend) => ({
        displayName: friend.displayName,
        joinedAt: friend.joinedAt.toISOString(),
        status: friend.status,
        rewardNotBefore:
          friend.rewardNotBefore === null ? null : friend.rewardNotBefore.toISOString(),
      })),
      nextCursor: view.next === null ? null : encodeKeysetCursor(view.next),
    };
  }

  @Get(MINIAPP_ROUTES.trial)
  async trial(@Req() request: FastifyRequest): Promise<MiniAppTrialResponse> {
    const call = await miniAppCall(this.container, request, { gated: true });
    const availability = await this.container.trials.availabilityFor(
      call.context.scope,
      call.actor,
      call.context.customer.id,
    );
    return {
      offers: availability.available
        ? availability.offers.map((offer) => ({
            panelId: offer.panelId,
            label: offer.label,
            trafficBytes: offer.trafficBytes.toString(),
            durationHours: offer.durationHours,
          }))
        : [],
    };
  }

  /** The claim, once per account; the trial's link arrives through the bot's delivery lane. */
  @Post(MINIAPP_ROUTES.trial)
  async claimTrial(@Req() request: FastifyRequest, @Body() body: unknown) {
    const call = await miniAppCall(this.container, request, { gated: true });
    const input = parseWith(miniAppTrialClaimRequestSchema, body);
    const result = await this.container.trials.claim(
      call.context.scope,
      call.actor,
      call.context.customer.id,
      {
        idempotencyKey: `${miniAppKey(request, call, 'trial')}:trial`,
        ...(input.panelId === null ? {} : { panelId: input.panelId }),
      },
    );
    if (result.outcome !== 'ISSUED') {
      throw errors.conflict(
        MINIAPP_ERROR_CODES.MINIAPP_ROUTE_UNAVAILABLE,
        'No trial is available.',
        {
          outcome: result.outcome,
        },
      );
    }
    return { serviceId: result.serviceId };
  }

  @Get(MINIAPP_ROUTES.ticketCategories)
  async ticketCategories(@Req() request: FastifyRequest) {
    const call = await miniAppCall(this.container, request, { gated: true });
    const categories = await this.container.ticketCategories.activeForCustomer(call.context.scope);
    return { items: categories.map((category) => ({ id: category.id, title: category.title })) };
  }

  /** The customer's tickets opened through THIS bot — another bot's are, to it, nobody's. */
  @Get(MINIAPP_ROUTES.tickets)
  async tickets(@Req() request: FastifyRequest) {
    const call = await miniAppCall(this.container, request, { gated: true });
    const tickets = await this.container.tickets.customerTickets(
      call.context.scope,
      call.context.customer.id,
      call.context.botInstanceId,
    );
    return { items: tickets.map(ticketSummary) };
  }

  @Get(MINIAPP_ROUTES.ticket)
  async ticket(
    @Req() request: FastifyRequest,
    @Param('ticketId') ticketId: string,
  ): Promise<MiniAppTicketDetail> {
    const call = await miniAppCall(this.container, request, { gated: true });
    return this.ticketDetail(call, ticketId);
  }

  /** A new ticket: text only — a ticket's files are Telegram files, sent in the bot. */
  @Post(MINIAPP_ROUTES.tickets)
  async openTicket(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<MiniAppTicketDetail> {
    const call = await miniAppCall(this.container, request, { gated: true });
    const input = parseWith(miniAppTicketCreateRequestSchema, body);
    const posted = await this.container.tickets.openByCustomer(call.context.scope, call.actor, {
      customerId: call.context.customer.id,
      botInstanceId: call.context.botInstanceId,
      categoryId: input.categoryId,
      text: input.text,
      file: null,
      idempotencyKey: miniAppKey(request, call, 'ticket-open'),
    });
    return this.ticketDetail(call, posted.ticket.id);
  }

  @Post(MINIAPP_ROUTES.ticketReplies)
  async replyTicket(
    @Req() request: FastifyRequest,
    @Param('ticketId') ticketId: string,
    @Body() body: unknown,
  ): Promise<MiniAppTicketDetail> {
    const call = await miniAppCall(this.container, request, { gated: true });
    const input = parseWith(miniAppTicketReplyRequestSchema, body);
    // Owned first: another customer's ticket, or another bot's, is "not found".
    await this.ticketDetail(call, ticketId);
    await this.container.tickets.replyByCustomer(call.context.scope, call.actor, {
      customerId: call.context.customer.id,
      botInstanceId: call.context.botInstanceId,
      ticketId,
      text: input.text,
      file: null,
      idempotencyKey: miniAppKey(request, call, 'ticket-reply'),
    });
    return this.ticketDetail(call, ticketId);
  }

  /** The platforms the guide offers this customer (`OTHER` only when something is filed there). */
  @Get(MINIAPP_ROUTES.guide)
  async guide(@Req() request: FastifyRequest) {
    const call = await miniAppCall(this.container, request, { gated: true });
    const platforms = await this.container.clientAppCatalog.platformsFor(
      call.context.scope,
      call.context.customer.id,
    );
    return { platforms: [...platforms] };
  }

  /** One platform: the operator's apps for this customer's services, or the platform's own text. */
  @Get(MINIAPP_ROUTES.guidePlatform)
  async guidePlatform(
    @Req() request: FastifyRequest,
    @Param('platform') platform: string,
  ): Promise<MiniAppGuidePlatformResponse> {
    const call = await miniAppCall(this.container, request, { gated: true });
    if (!(CLIENT_APP_PLATFORMS as readonly string[]).includes(platform)) throw notFound();
    const which = platform as ClientAppPlatform;
    const { scope, customer } = call.context;
    const listed = await this.container.clientAppCatalog.appsFor(scope, customer.id, which);
    const apps: MiniAppGuidePlatformResponse['apps'][number][] = [];
    for (const entry of listed) {
      const detail = await this.container.clientAppCatalog.appFor(scope, customer.id, entry.id);
      if (detail === null) continue;
      apps.push({
        id: detail.id,
        name: detail.title,
        description: detail.description === '' ? null : detail.description,
        officialUrl: detail.officialUrl,
        alternativeUrl: detail.alternativeUrl,
        helpUrl: detail.helpUrl,
        guide: detail.guide === '' ? null : detail.guide,
      });
    }
    const fallbackKey = TUTORIAL_KEYS[which];
    const fallbackGuide =
      apps.length > 0 || fallbackKey === undefined
        ? null
        : plainText(await this.container.miniApp.tutorialText(scope, fallbackKey));
    return { platform: which, apps, fallbackGuide };
  }

  // -------------------------------------------------------------------------

  private positive(amount: ReturnType<typeof fromWire>) {
    if (amount.amountMinor <= 0n) {
      throw errors.validation(
        MINIAPP_ERROR_CODES.MINIAPP_REQUEST_INVALID,
        'An amount is positive.',
      );
    }
    return amount;
  }

  private async ticketDetail(call: MiniAppCall, ticketId: string): Promise<MiniAppTicketDetail> {
    const found = await this.container.tickets.customerTicket(
      call.context.scope,
      call.context.customer.id,
      call.context.botInstanceId,
      ticketId,
      TICKET_MESSAGES_SHOWN,
    );
    if (found === null) throw notFound();
    return {
      ...ticketSummary(found.ticket),
      messages: found.messages
        .filter((message) => message.senderType !== 'SYSTEM')
        .map((message) => ({
          author:
            message.senderType === 'CUSTOMER'
              ? ('CUSTOMER' as const)
              : message.senderType === 'AI'
                ? ('AI' as const)
                : ('SUPPORT' as const),
          text: message.body,
          hasAttachment: message.attachment !== null || found.filed.has(message.id),
          createdAt: message.createdAt.toISOString(),
        })),
    };
  }
}

function ticketSummary(ticket: TicketRecord) {
  return {
    id: ticket.id,
    code: ticketCodeOf(ticket),
    subject: ticket.subject,
    categoryTitle: ticket.categoryTitle,
    status: ticket.status,
    lastMessageAt: ticket.lastMessageAt.toISOString(),
  };
}

/** A rendered bot text as plain text: the mini app draws text, never the bot's markup. */
function plainText(rendered: string): string {
  return rendered.replace(/<[^>]*>/gu, '');
}
