import { Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  MINIAPP_API_PREFIX,
  MINIAPP_ROUTES,
  miniAppCursorQuerySchema,
  type MiniAppNotificationReadResponse,
  type MiniAppNotificationsResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { decodeKeysetCursor, encodeKeysetCursor } from '../web/keyset-cursor.js';
import { miniAppCall, miniAppKey, notFound, parseWith } from './miniapp-request.js';

/** Any UUID: the lane's ids are v7, but a row written by SQL need not be, and it is still a legal key. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * The customer's notification centre (Round 11, B1): the bot messages already delivered to
 * them, newest first, with read and unread. Every route is the session's own customer and the
 * bot the mini app was opened from; none takes a customer id. With the flag
 * `notification_centre` off each answers `miniapp.unavailable` (404), as the mini app itself
 * does when it is off — the service decides, not this file.
 */
@Controller(MINIAPP_API_PREFIX)
export class MiniAppNotificationsController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(MINIAPP_ROUTES.notifications)
  async list(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
  ): Promise<MiniAppNotificationsResponse> {
    const call = await miniAppCall(this.container, request, { gated: true });
    const { cursor } = parseWith(miniAppCursorQuerySchema, query);
    const position = cursor === undefined ? null : decodeKeysetCursor(cursor);
    const page = await this.container.miniApp.notificationCentre.list(
      call.context.scope,
      call.actor,
      { customerId: call.context.customer.id, botInstanceId: call.context.botInstanceId },
      position === null ? null : { deliveredAtText: position.createdAt, id: position.id },
    );
    return {
      items: page.items.map((item) => ({
        id: item.id,
        text: item.text,
        createdAt: item.deliveredAt.toISOString(),
        read: item.read,
      })),
      nextCursor:
        page.next === null
          ? null
          : encodeKeysetCursor({ createdAt: page.next.deliveredAtText, id: page.next.id }),
      unreadCount: page.unreadCount,
    };
  }

  /** Every unread message of this customer, marked read. Declared before the `:id` route. */
  @Post(MINIAPP_ROUTES.notificationsReadAll)
  async readAll(@Req() request: FastifyRequest): Promise<MiniAppNotificationReadResponse> {
    const call = await miniAppCall(this.container, request, { gated: true });
    return this.container.miniApp.notificationCentre.markAllRead(call.context.scope, call.actor, {
      customerId: call.context.customer.id,
      botInstanceId: call.context.botInstanceId,
      idempotencyKey: miniAppKey(request, call, 'notifications-read-all'),
    });
  }

  @Post(MINIAPP_ROUTES.notificationRead)
  async read(
    @Req() request: FastifyRequest,
    @Param('notificationId') notificationId: string,
  ): Promise<MiniAppNotificationReadResponse> {
    const call = await miniAppCall(this.container, request, { gated: true });
    // A malformed id is, to the customer, an id that is nobody's.
    if (!UUID.test(notificationId)) throw notFound();
    return this.container.miniApp.notificationCentre.markRead(call.context.scope, call.actor, {
      customerId: call.context.customer.id,
      botInstanceId: call.context.botInstanceId,
      notificationId,
      idempotencyKey: miniAppKey(request, call, 'notification-read'),
    });
  }
}
