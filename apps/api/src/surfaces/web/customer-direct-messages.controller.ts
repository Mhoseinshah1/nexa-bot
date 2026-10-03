import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  directMessageDeliveryState,
  directMessageListQuerySchema,
  sendDirectMessageRequestSchema,
  type DirectMessageListResponse,
  type DirectMessageResponse,
  type DirectMessageResponseItem,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type { DirectMessageHistoryRow } from '../../modules/commerce/direct-messages/application/ports.js';

/**
 * Phase A2: «ارسال پیام» from Customer 360, under `/users/:id/direct-messages`.
 *
 * Authentication here; authorization in the service, which charges `users.message.send` for
 * a send and `users.message.view` for the history — so neither is protected merely by the
 * Web Admin not drawing it. A send carries its idempotency key in the body and is refused
 * from an origin the installation does not list. Nothing about Telegram is answered here:
 * the response says where the lane row is, and nothing claims "delivered" or "read".
 */
@Controller(`${API_PREFIX}`)
export class CustomerDirectMessagesController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get('users/:id/direct-messages')
  async list(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Query() query: unknown,
  ): Promise<DirectMessageListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const parsed = directMessageListQuerySchema.parse(query);
    const before =
      parsed.beforeAt === undefined || parsed.beforeId === undefined
        ? null
        : { at: new Date(parsed.beforeAt), id: parsed.beforeId };
    const rows = await this.container.customerDirectMessages.history(scope, actor, {
      customerId: id,
      limit: parsed.limit + 1,
      before,
    });
    const page = rows.slice(0, parsed.limit);
    const last = page.at(-1);
    return {
      messages: page.map(toItem),
      nextCursor:
        rows.length > parsed.limit && last !== undefined
          ? { at: last.message.createdAt.toISOString(), id: last.message.id }
          : null,
    };
  }

  @Post('users/:id/direct-messages')
  async send(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<DirectMessageResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = sendDirectMessageRequestSchema.parse(body);
    const sent = await this.container.customerDirectMessages.send(scope, actor, {
      customerId: id,
      idempotencyKey: command.idempotencyKey,
      text: command.text,
      file: command.file,
    });
    return { message: toItem(sent.row), replayed: sent.replayed };
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
      // A customer belongs to the TENANT, not to a bot: see `CustomersController`.
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }
}

/** The wire shape. Never the bot, the chat id or Telegram's file handle. */
export function toItem(row: DirectMessageHistoryRow): DirectMessageResponseItem {
  const { message, lane } = row;
  return {
    id: message.id,
    contentKind: message.contentKind,
    text: message.body,
    file:
      message.file === null
        ? null
        : {
            fileName: message.file.fileName,
            mimeType: message.file.mimeType,
            byteLength: message.file.byteLength,
          },
    sentBy:
      row.authorUsername === null
        ? null
        : { id: message.authorAdminId, username: row.authorUsername },
    createdAt: message.createdAt.toISOString(),
    delivery: directMessageDeliveryState(
      lane === null ? null : { state: lane.state, sendStarted: lane.sendStarted },
    ),
    attempts: lane?.attempts ?? 0,
    resolvedAt: lane?.resolvedAt?.toISOString() ?? null,
  };
}
