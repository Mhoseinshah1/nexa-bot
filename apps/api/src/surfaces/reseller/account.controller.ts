import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  MINIAPP_ERROR_CODES,
  NexaError,
  RESELLER_API_PREFIX,
  RESELLER_PANEL_ROUTES,
  RESELLER_WEB_ERROR_CODES,
  RESELLER_WEB_WALLET_PAGE_SIZE,
  errors,
  fromWire,
  miniAppReceiptRequestSchema,
  miniAppTicketCreateRequestSchema,
  miniAppTicketReplyRequestSchema,
  miniAppTopupQuoteRequestSchema,
  miniAppTopupRequestSchema,
  money,
  paymentTrackingCode,
  resellerWalletEntriesQuerySchema,
  ticketCodeOf,
  type Money,
  type MiniAppTicketDetail,
  type MiniAppTopupQuoteResponse,
  type MiniAppWalletEntries,
  type ResellerDashboard,
  type ResellerPricesResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import type { MiniAppContext } from '../../modules/commerce/miniapp/application/miniapp-session.service.js';
import type { ResellerWebContext } from '../../modules/commerce/reseller-panel/application/reseller-web-access.service.js';
import type { TicketRecord } from '../../modules/commerce/tickets/application/ports.js';
import type { WalletCursor } from '../../modules/commerce/wallet/application/ports.js';
import { attemptWire, instructionWire, wire } from '../miniapp/projections.js';
import { decodeKeysetCursor, encodeKeysetCursor } from '../web/keyset-cursor.js';
import { parseWith, resellerCall, resellerKey } from './reseller-request.js';

const TICKET_MESSAGES_SHOWN = 30;

/**
 * PR-4 §5.2 — the reseller's dashboard, wallet, price list and tickets. Each route calls the
 * service the bot and the mini app call: the wallet's own history and balance, the top-up's
 * own quote and request with the tenant's enabled routes and fees (no fee logic here), the
 * pricing engine's own reseller prices, the ticket desk's own tickets — whose replies reach
 * the bot exactly as today, because they are the same tickets.
 */
@Controller(RESELLER_API_PREFIX)
export class ResellerAccountController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(RESELLER_PANEL_ROUTES.dashboard)
  async dashboard(@Req() request: FastifyRequest): Promise<ResellerDashboard> {
    const context = await resellerCall(this.container, request);
    return this.container.resellerWeb.dashboard.dashboard(context);
  }

  @Get(RESELLER_PANEL_ROUTES.prices)
  async prices(@Req() request: FastifyRequest): Promise<ResellerPricesResponse> {
    const context = await resellerCall(this.container, request);
    return this.container.resellerWeb.dashboard.prices(context);
  }

  // --- Wallet -------------------------------------------------------------------------------

  @Get(RESELLER_PANEL_ROUTES.wallet)
  async wallet(@Req() request: FastifyRequest) {
    const context = await resellerCall(this.container, request);
    const { scope } = context;
    const [balance, presets, limits] = await Promise.all([
      this.container.wallet.balanceForCustomer(scope, context.actor, context.customer.id),
      this.container.payments.topupPresets(scope),
      this.container.miniApp.topup.limits(scope),
    ]);
    return {
      balance: wire(money(balance.amountMinor, balance.currency)),
      presets: presets.map(wire),
      minimum: limits.minimum === null ? null : wire(limits.minimum),
      maximum: limits.maximum === null ? null : wire(limits.maximum),
    };
  }

  /** All / credits / debits: the reseller's own ledger, newest first. */
  @Get(RESELLER_PANEL_ROUTES.walletEntries)
  async entries(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
  ): Promise<MiniAppWalletEntries> {
    const context = await resellerCall(this.container, request);
    const input = parseWith(resellerWalletEntriesQuerySchema, query);
    const page = await this.container.wallet.historyForCustomer(
      context.scope,
      context.actor,
      context.customer.id,
      {
        limit: RESELLER_WEB_WALLET_PAGE_SIZE,
        ...(input.cursor === undefined
          ? {}
          : { cursor: decodeKeysetCursor(input.cursor) as WalletCursor }),
        ...(input.direction === 'ALL' ? {} : { direction: input.direction }),
      },
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

  /** A top-up amount against the floor and ceiling, and the tenant's routes (with their fees). */
  @Post(RESELLER_PANEL_ROUTES.walletTopupQuote)
  @HttpCode(200)
  async topupQuote(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<MiniAppTopupQuoteResponse> {
    const context = await resellerCall(this.container, request);
    const input = parseWith(miniAppTopupQuoteRequestSchema, body);
    const quoted = await this.container.miniApp.topup.quoteAmount(
      context.scope,
      context.customer.id,
      positive(fromWire(input.amount)),
    );
    if (quoted.outcome === 'BELOW_MINIMUM') {
      return { outcome: 'BELOW_MINIMUM', minimum: wire(quoted.minimum) };
    }
    if (quoted.outcome === 'ABOVE_MAXIMUM') {
      return { outcome: 'ABOVE_MAXIMUM', maximum: wire(quoted.maximum) };
    }
    const routes = await this.container.miniApp.checkout.topupRoutes(context.scope, quoted.routes);
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

  /** The top-up itself: the same request the bot's chooser makes. */
  @Post(RESELLER_PANEL_ROUTES.walletTopup)
  @HttpCode(200)
  async topup(@Req() request: FastifyRequest, @Body() body: unknown) {
    const context = await resellerCall(this.container, request);
    const input = parseWith(miniAppTopupRequestSchema, body);
    const result = await this.container.miniApp.topup.requestDirect(context.scope, context.actor, {
      customerId: context.customer.id,
      amount: positive(fromWire(input.amount)),
      provider: input.provider,
      idempotencyKey: resellerKey(request, context, 'topup'),
    });
    if (result.outcome === 'GATEWAY_REQUESTED') {
      return { kind: 'GATEWAY' as const, attempt: attemptWire(result.attempt, false) };
    }
    if (result.outcome === 'REQUESTED') {
      return { kind: 'CARD_TO_CARD' as const, instruction: instructionWire(result.instruction) };
    }
    throw errors.conflict(
      MINIAPP_ERROR_CODES.MINIAPP_ROUTE_UNAVAILABLE,
      'Not offered for this amount.',
      { outcome: result.outcome },
    );
  }

  /** 'I have transferred': the bot's signal, which opens the receipt window. */
  @Post(RESELLER_PANEL_ROUTES.paymentTransferSent)
  @HttpCode(200)
  async transferSent(@Req() request: FastifyRequest, @Param('paymentId') paymentId: string) {
    const context = await resellerCall(this.container, request);
    const pending = await owned(() =>
      this.container.payments.pendingTransferForCustomer(
        context.scope,
        context.customer.id,
        paymentId,
      ),
    );
    const { payment, receiptWindow } = await this.container.payments.signalTransferSent(
      context.scope,
      context.actor,
      context.customer.id,
      {
        idempotencyKey: `${resellerKey(request, context, 'transfer-sent')}:pay-sent`,
        paymentId: pending.id,
        botInstanceId: context.botInstanceId,
      },
    );
    return {
      receiptWindowMinutes: receiptWindow?.minutes ?? null,
      reference: paymentTrackingCode(payment),
    };
  }

  /** The receipt image, filed by the bot's own receipt service (the mini app's upload path). */
  @Post(RESELLER_PANEL_ROUTES.paymentReceipt)
  @HttpCode(200)
  async receipt(
    @Req() request: FastifyRequest,
    @Param('paymentId') paymentId: string,
    @Body() body: unknown,
  ) {
    const context = await resellerCall(this.container, request);
    const input = parseWith(miniAppReceiptRequestSchema, body);
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(input.imageBase64) || input.imageBase64.length % 4 !== 0) {
      throw errors.validation(MINIAPP_ERROR_CODES.MINIAPP_RECEIPT_REFUSED, 'Not base64.', {
        reason: 'NOT_AN_IMAGE',
      });
    }
    return this.container.miniApp.receipts.submit(asLaneContext(context), context.actor, {
      paymentId,
      bytes: new Uint8Array(Buffer.from(input.imageBase64, 'base64')),
      declaredMimeType: input.mimeType,
      idempotencyKey: resellerKey(request, context, 'receipt'),
    });
  }

  // --- Support --------------------------------------------------------------------------------

  @Get(RESELLER_PANEL_ROUTES.ticketCategories)
  async ticketCategories(@Req() request: FastifyRequest) {
    const context = await resellerCall(this.container, request);
    const categories = await this.container.ticketCategories.activeForCustomer(context.scope);
    return { items: categories.map((category) => ({ id: category.id, title: category.title })) };
  }

  /** The reseller's tickets opened through the bot they signed in from. */
  @Get(RESELLER_PANEL_ROUTES.tickets)
  async tickets(@Req() request: FastifyRequest) {
    const context = await resellerCall(this.container, request);
    const tickets = await this.container.tickets.customerTickets(
      context.scope,
      context.customer.id,
      context.botInstanceId,
    );
    return { items: tickets.map(ticketSummary) };
  }

  @Get(RESELLER_PANEL_ROUTES.ticket)
  async ticket(
    @Req() request: FastifyRequest,
    @Param('ticketId') ticketId: string,
  ): Promise<MiniAppTicketDetail> {
    const context = await resellerCall(this.container, request);
    return this.ticketDetail(context, ticketId);
  }

  @Post(RESELLER_PANEL_ROUTES.tickets)
  @HttpCode(200)
  async openTicket(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<MiniAppTicketDetail> {
    const context = await resellerCall(this.container, request);
    const input = parseWith(miniAppTicketCreateRequestSchema, body);
    const posted = await this.container.tickets.openByCustomer(context.scope, context.actor, {
      customerId: context.customer.id,
      botInstanceId: context.botInstanceId,
      categoryId: input.categoryId,
      text: input.text,
      file: null,
      idempotencyKey: resellerKey(request, context, 'ticket-open'),
    });
    return this.ticketDetail(context, posted.ticket.id);
  }

  @Post(RESELLER_PANEL_ROUTES.ticketReplies)
  @HttpCode(200)
  async replyTicket(
    @Req() request: FastifyRequest,
    @Param('ticketId') ticketId: string,
    @Body() body: unknown,
  ): Promise<MiniAppTicketDetail> {
    const context = await resellerCall(this.container, request);
    const input = parseWith(miniAppTicketReplyRequestSchema, body);
    await this.ticketDetail(context, ticketId);
    await this.container.tickets.replyByCustomer(context.scope, context.actor, {
      customerId: context.customer.id,
      botInstanceId: context.botInstanceId,
      ticketId,
      text: input.text,
      file: null,
      idempotencyKey: resellerKey(request, context, 'ticket-reply'),
    });
    return this.ticketDetail(context, ticketId);
  }

  private async ticketDetail(
    context: ResellerWebContext,
    ticketId: string,
  ): Promise<MiniAppTicketDetail> {
    const found = await owned(() =>
      this.container.tickets.customerTicket(
        context.scope,
        context.customer.id,
        context.botInstanceId,
        ticketId,
        TICKET_MESSAGES_SHOWN,
      ),
    );
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

/**
 * The receipt lane takes the context a mini-app request runs in: the same facts — tenant and
 * bot scope, the customer, their Telegram id — derived here from the reseller's session.
 */
function asLaneContext(context: ResellerWebContext): MiniAppContext {
  return {
    scope: context.scope,
    botInstanceId: context.botInstanceId,
    sessionId: context.sessionId,
    customer: context.customer,
    telegramUserId: context.customer.telegramUserId,
  };
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

function positive(amount: Money): Money {
  if (amount.amountMinor <= 0n) {
    throw errors.validation(RESELLER_WEB_ERROR_CODES.REQUEST_INVALID, 'An amount is positive.');
  }
  return amount;
}

/** A read naming an id the browser sent; "not yours" and "does not exist" are one answer. */
async function owned<T>(read: () => Promise<T | null>): Promise<T> {
  let value: T | null;
  try {
    value = await read();
  } catch (error) {
    if (error instanceof NexaError && (error.kind === 'NOT_FOUND' || error.kind === 'VALIDATION')) {
      throw errors.notFound(RESELLER_WEB_ERROR_CODES.NOT_FOUND, 'Not found.');
    }
    throw error;
  }
  if (value === null) throw errors.notFound(RESELLER_WEB_ERROR_CODES.NOT_FOUND, 'Not found.');
  return value;
}
