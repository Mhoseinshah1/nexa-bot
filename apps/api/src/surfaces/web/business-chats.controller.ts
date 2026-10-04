import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  BUSINESS_CHAT_LIST_LIMIT,
  BUSINESS_CHAT_ROUTES,
  businessChatControlRequestSchema,
  businessChatListQuerySchema,
  businessChatSendRequestSchema,
  businessConnectionStatus,
  routePattern,
  type BusinessChatControlResponse,
  type BusinessChatDetailResponse,
  type BusinessChatListResponse,
  type BusinessChatSendResponse,
  type BusinessConnectionListResponse,
  type BusinessConversationSummary,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type { BusinessConversationListItem } from '../../modules/commerce/business-chats/application/ports.js';

/**
 * TB2 — Telegram Business conversations over HTTP: the inbox, one conversation, the
 * operator's reply, take over and resume (ADR-0033).
 *
 * Authentication and the origin check happen here; AUTHORIZATION does not.
 * `BusinessConversationService` charges `business_chats.view` and `business_chats.reply`
 * itself, inside its transactions — a hidden button is never the authorization.
 */
@Controller(`${API_PREFIX}`)
export class BusinessChatsController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(BUSINESS_CHAT_ROUTES.list)
  async list(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
  ): Promise<BusinessChatListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const input = businessChatListQuerySchema.parse(query ?? {});
    const before = decodeCursor(input.cursor);
    const items = await this.container.businessConversations.list(scope, actor, {
      ...(input.state === undefined ? {} : { state: input.state }),
      ...(before === null ? {} : { before }),
      limit: BUSINESS_CHAT_LIST_LIMIT + 1,
    });
    const page = items.slice(0, BUSINESS_CHAT_LIST_LIMIT);
    const last = page[page.length - 1];
    return {
      conversations: page.map(toSummary),
      nextCursor:
        items.length > BUSINESS_CHAT_LIST_LIMIT && last !== undefined ? encodeCursor(last) : null,
    };
  }

  @Get(BUSINESS_CHAT_ROUTES.connections)
  async connections(@Req() request: FastifyRequest): Promise<BusinessConnectionListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const rows = await this.container.businessConversations.connections(scope, actor);
    return {
      connections: rows.map((row) => ({
        id: row.id,
        botInstanceId: row.botInstanceId,
        ownerTelegramUserId: row.ownerTelegramUserId,
        status: row.status,
        rights: [...row.rights],
        connectedAt: row.connectedAt.toISOString(),
        lastConfirmedAt: row.lastConfirmedAt.toISOString(),
      })),
    };
  }

  @Get(routePattern(BUSINESS_CHAT_ROUTES.detail, 'conversationId'))
  async detail(
    @Req() request: FastifyRequest,
    @Param('conversationId') conversationId: string,
  ): Promise<BusinessChatDetailResponse> {
    const { scope, actor } = await this.authenticate(request);
    const found = await this.container.businessConversations.detail(scope, actor, conversationId);
    const summary = toSummary(found.item);
    return {
      conversation: {
        ...summary,
        controlEpoch: found.item.conversation.controlEpoch,
        lastHumanAt: found.item.conversation.lastHumanAt?.toISOString() ?? null,
      },
      messages: found.messages.map((message) => ({
        id: message.id,
        origin: message.origin,
        kind: message.kind,
        text: message.text,
        sentAt: message.sentAt.toISOString(),
        edited: message.editedAt !== null,
        deleted: message.deletedAt !== null,
      })),
      outbound: found.outbound.map((row) => ({
        id: row.id,
        origin: row.origin,
        state: row.state,
        text: row.body,
        createdAt: row.createdAt.toISOString(),
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
        failureCode: row.failureCode,
      })),
    };
  }

  @Post(routePattern(BUSINESS_CHAT_ROUTES.send, 'conversationId'))
  async send(
    @Req() request: FastifyRequest,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ): Promise<BusinessChatSendResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = businessChatSendRequestSchema.parse(body);
    const row = await this.container.businessConversations.send(scope, actor, {
      conversationId,
      idempotencyKey: command.idempotencyKey,
      text: command.text,
    });
    return { outboundId: row.id, state: row.state };
  }

  @Post(routePattern(BUSINESS_CHAT_ROUTES.takeover, 'conversationId'))
  async takeover(
    @Req() request: FastifyRequest,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ): Promise<BusinessChatControlResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = businessChatControlRequestSchema.parse(body);
    return this.container.businessConversations.takeOver(scope, actor, {
      conversationId,
      idempotencyKey: command.idempotencyKey,
    });
  }

  @Post(routePattern(BUSINESS_CHAT_ROUTES.resume, 'conversationId'))
  async resume(
    @Req() request: FastifyRequest,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ): Promise<BusinessChatControlResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = businessChatControlRequestSchema.parse(body);
    return this.container.businessConversations.resume(scope, actor, {
      conversationId,
      idempotencyKey: command.idempotencyKey,
    });
  }

  private async authenticate(
    request: FastifyRequest,
    options: { write?: boolean } = {},
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request, this.container.config.NODE_ENV === 'production');
    if (options.write === true) {
      assertOriginAllowed(request, this.container.config.WEB_ADMIN_ORIGINS);
    }
    const { admin, session } = await this.container.auth.authenticate(token);
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    return {
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }
}

function toSummary(item: BusinessConversationListItem): BusinessConversationSummary {
  const conversation = item.conversation;
  return {
    id: conversation.id,
    state: conversation.state,
    takeoverReason: conversation.takeoverReason,
    handoffReason: conversation.handoffReason,
    peerTelegramUserId: conversation.peerTelegramUserId,
    customer: item.customer,
    connectionStatus: businessConnectionStatus(item.connection),
    lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
    lastInboundAt: conversation.lastInboundAt?.toISOString() ?? null,
    preview: item.preview,
  };
}

/** `<iso>|<id>` of the last row's activity — an opaque cursor to the client. */
function encodeCursor(item: BusinessConversationListItem): string {
  return `${item.activityAt.toISOString()}|${item.conversation.id}`;
}

function decodeCursor(cursor: string | undefined): { at: Date; id: string } | null {
  if (cursor === undefined) return null;
  const [at, id] = cursor.split('|');
  if (at === undefined || at === '' || id === undefined || id === '') return null;
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? null : { at: parsed, id };
}
