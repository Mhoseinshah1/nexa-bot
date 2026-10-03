import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  inboxListQuerySchema,
  markAllInboxRequestSchema,
  markInboxRequestSchema,
  type InboxListResponse,
  type InboxNotification,
  type InboxSummaryResponse,
  type MarkAllInboxResponse,
  type MarkInboxResponse,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type { InboxNotificationView } from '../../modules/platform/opslog/application/notification-center.service.js';

/**
 * Phase B3: the Web Admin Notification Center, under `/notification-center`
 * (`/notifications` is the Phase 2 operator-channel page). Authentication here; what each
 * administrator may see is decided in the service, by the guard's own permission
 * resolution, and every write is refused from an origin the installation does not list.
 */
@Controller(`${API_PREFIX}`)
export class NotificationCenterController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get('notification-center')
  async list(@Req() request: FastifyRequest, @Query() query: unknown): Promise<InboxListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const parsed = inboxListQuerySchema.parse(query);
    const before =
      parsed.beforeAt === undefined || parsed.beforeId === undefined
        ? null
        : { at: new Date(parsed.beforeAt), id: parsed.beforeId };
    const rows = await this.container.notificationCenter.list(scope, actor, {
      limit: parsed.limit + 1,
      unreadOnly: parsed.unread === true,
      before,
      ...(parsed.category === undefined ? {} : { category: parsed.category }),
    });
    const page = rows.slice(0, parsed.limit);
    const last = page.at(-1);
    return {
      notifications: page.map(toItem),
      nextCursor:
        rows.length > parsed.limit && last !== undefined
          ? { at: last.firstSeenAt.toISOString(), id: last.id }
          : null,
    };
  }

  @Get('notification-center/summary')
  async summary(@Req() request: FastifyRequest): Promise<InboxSummaryResponse> {
    const { scope, actor } = await this.authenticate(request);
    const summary = await this.container.notificationCenter.summary(scope, actor);
    return { unread: summary.unread, atLeast: summary.atLeast, highestUnread: summary.highest };
  }

  @Post('notification-center/read-all')
  async markAll(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<MarkAllInboxResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = markAllInboxRequestSchema.parse(body ?? {});
    const marked = await this.container.notificationCenter.markAll(scope, actor, {
      ...(command.category === undefined ? {} : { category: command.category }),
    });
    return { marked };
  }

  @Post('notification-center/:id/read')
  async mark(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<MarkInboxResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = markInboxRequestSchema.parse(body);
    const view = await this.container.notificationCenter.mark(scope, actor, {
      id,
      read: command.read,
    });
    return { notification: toItem(view) };
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

/** The wire shape: never the raw `context` — only the link derived from it. */
export function toItem(view: InboxNotificationView): InboxNotification {
  return {
    id: view.id,
    code: view.code,
    category: view.category,
    severity: view.severity,
    message: view.message,
    occurrenceCount: view.occurrenceCount,
    firstSeenAt: view.firstSeenAt.toISOString(),
    lastSeenAt: view.lastSeenAt.toISOString(),
    resolvedAt: view.resolvedAt?.toISOString() ?? null,
    read: view.read,
    link: view.link,
  };
}
