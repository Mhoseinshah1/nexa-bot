import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  TICKET_ERROR_CODES,
  TICKET_PAGE_MAX,
  TICKET_ROUTES,
  errors,
  routePattern,
  ticketAssignRequestSchema,
  ticketCategoryCreateRequestSchema,
  ticketCategoryUpdateRequestSchema,
  ticketLinksRequestSchema,
  ticketListQuerySchema,
  ticketPriorityRequestSchema,
  ticketReplyRequestSchema,
  ticketStatusRequestSchema,
  type TenantContext,
  type TicketAssigneesResponse,
  type TicketCategoryListResponse,
  type TicketCategoryResponse,
  type TicketCategoryView,
  type TicketDetailResponse,
  type TicketListResponse,
  type TicketMessageView,
  type TicketMutationResponse,
  type TicketReplyResponse,
  type TicketSummary,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type {
  TicketCategoryRecord,
  TicketListItem,
  TicketMessageListItem,
  TicketMessageRecord,
} from '../../modules/commerce/tickets/application/ports.js';

/**
 * Support tickets over HTTP (WP-A7): the inbox, one conversation, the reply, and the three
 * triage writes — status, assignee, priority — plus the linked context and the categories.
 *
 * Authentication and the origin check happen here; AUTHORIZATION does not. `TicketService`
 * charges `tickets.view`, `tickets.reply`, `tickets.assign` and `tickets.close` itself, and
 * `TicketCategoryService` charges `tickets.categories.edit`, inside their transactions.
 * No write asks for a reason: a reply or a status change is ordinary support work, and each
 * is audited automatically with its before and after.
 */
@Controller(`${API_PREFIX}`)
export class TicketsController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(TICKET_ROUTES.list)
  async list(@Req() request: FastifyRequest, @Query() query: unknown): Promise<TicketListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const input = ticketListQuerySchema.parse(query ?? {});
    const limit = input.limit ?? 50;
    // One row past the page, so "there is another page" is read, never guessed.
    const items = await this.container.tickets.list(scope, actor, {
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.awaiting === 'support' ? { awaitingSupport: true } : {}),
      ...(input.categoryId === undefined ? {} : { categoryId: input.categoryId }),
      ...(input.customer === undefined ? {} : { customer: input.customer }),
      ...(input.assigned === undefined ? {} : { assigned: input.assigned }),
      ...(input.from === undefined ? {} : { from: new Date(input.from) }),
      ...(input.to === undefined ? {} : { to: new Date(input.to) }),
      ...(input.before === undefined || input.beforeId === undefined
        ? {}
        : { before: { at: new Date(input.before), id: input.beforeId } }),
      limit: Math.min(limit, TICKET_PAGE_MAX) + 1,
    });
    const page = items.slice(0, limit);
    const last = page[page.length - 1];
    return {
      tickets: page.map(toSummary),
      nextCursor:
        items.length > limit && last !== undefined
          ? { at: last.ticket.createdAt.toISOString(), id: last.ticket.id }
          : null,
    };
  }

  @Get(TICKET_ROUTES.assignees)
  async assignees(@Req() request: FastifyRequest): Promise<TicketAssigneesResponse> {
    const { scope, actor } = await this.authenticate(request);
    const admins = await this.container.tickets.assignees(scope, actor);
    return {
      admins: admins.map((admin) => ({
        id: admin.id,
        username: admin.username,
        displayName: admin.displayName,
      })),
    };
  }

  @Get(routePattern(TICKET_ROUTES.detail, 'ticketId'))
  async detail(
    @Req() request: FastifyRequest,
    @Param('ticketId') ticketId: string,
  ): Promise<TicketDetailResponse> {
    const { scope, actor } = await this.authenticate(request);
    const found = await this.container.tickets.detail(scope, actor, ticketId);
    const customer = found.customer;
    return {
      ticket: { ...toSummary(found.item), origin: found.item.ticket.origin },
      escalations: found.escalations.map((escalation) => ({
        conversationId: escalation.conversationId,
        reason: escalation.reason,
        summary: escalation.summary,
        createdAt: escalation.createdAt.toISOString(),
      })),
      messages: found.messages.map(toMessageView),
      customer: {
        id: found.item.ticket.customerId,
        telegramUserId: customer?.telegramUserId ?? found.item.customer?.telegramUserId ?? '',
        username: customer?.username ?? null,
        displayName: displayNameOf(customer),
        status: customer?.status ?? 'ACTIVE',
      },
    };
  }

  @Post(routePattern(TICKET_ROUTES.reply, 'ticketId'))
  async reply(
    @Req() request: FastifyRequest,
    @Param('ticketId') ticketId: string,
    @Body() body: unknown,
  ): Promise<TicketReplyResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const input = ticketReplyRequestSchema.parse(body);
    const posted = await this.container.tickets.reply(scope, actor, {
      ticketId,
      text: input.text,
      // HF-A7: one file beside the text, judged by the service against its bytes.
      attachment: input.attachment ?? null,
      idempotencyKey: input.idempotencyKey,
    });
    return {
      ticket: toSummary(await this.container.tickets.summary(scope, actor, posted.ticket.id)),
      // Read back through the detail's own join, so a replay reports the delivery as it is.
      message: toMessageView(
        await this.container.tickets.messageView(scope, actor, posted.ticket.id, posted.message.id),
      ),
    };
  }

  @Post(routePattern(TICKET_ROUTES.status, 'ticketId'))
  async status(
    @Req() request: FastifyRequest,
    @Param('ticketId') ticketId: string,
    @Body() body: unknown,
  ): Promise<TicketMutationResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const input = ticketStatusRequestSchema.parse(body);
    const result = await this.container.tickets.setStatus(scope, actor, {
      ticketId,
      status: input.status,
    });
    return this.mutation(scope, actor, result);
  }

  @Post(routePattern(TICKET_ROUTES.assign, 'ticketId'))
  async assign(
    @Req() request: FastifyRequest,
    @Param('ticketId') ticketId: string,
    @Body() body: unknown,
  ): Promise<TicketMutationResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const input = ticketAssignRequestSchema.parse(body);
    const result = await this.container.tickets.assign(scope, actor, {
      ticketId,
      adminId: input.adminId,
    });
    return this.mutation(scope, actor, result);
  }

  @Post(routePattern(TICKET_ROUTES.priority, 'ticketId'))
  async priority(
    @Req() request: FastifyRequest,
    @Param('ticketId') ticketId: string,
    @Body() body: unknown,
  ): Promise<TicketMutationResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const input = ticketPriorityRequestSchema.parse(body);
    const result = await this.container.tickets.setPriority(scope, actor, {
      ticketId,
      priority: input.priority,
    });
    return this.mutation(scope, actor, result);
  }

  @Post(routePattern(TICKET_ROUTES.links, 'ticketId'))
  async links(
    @Req() request: FastifyRequest,
    @Param('ticketId') ticketId: string,
    @Body() body: unknown,
  ): Promise<TicketMutationResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const input = ticketLinksRequestSchema.parse(body);
    const result = await this.container.tickets.setLinks(scope, actor, { ticketId, ...input });
    return this.mutation(scope, actor, result);
  }

  /**
   * The BYTES of one attachment, fetched by this process with the bot that received it —
   * the receipts' route, for the receipts' reasons: `content-disposition: attachment`,
   * `nosniff` and `application/octet-stream` whatever the customer declared, so a file a
   * customer uploaded is never rendered in the admin origin, and no `file_id` ever reaches
   * a browser.
   *
   * HF-A7: support's own file is served by the same route with the same headers — from the
   * bytes still staged here while Telegram has not taken it, and from Telegram, with the
   * ticket's bot, once it has.
   */
  @Get(routePattern(TICKET_ROUTES.attachment, 'messageId'))
  async attachment(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('messageId') messageId: string,
  ): Promise<void> {
    const { scope, actor } = await this.authenticate(request);
    const { message, source } = await this.container.tickets.attachmentOf(scope, actor, messageId);
    let bytes: Uint8Array;
    if (source.kind === 'STORED') {
      bytes = source.bytes;
    } else {
      const fetched = await this.container.receiptFiles.download(scope, source.binding);
      if (fetched.outcome !== 'SUCCEEDED') {
        throw errors.preconditionFailed(
          TICKET_ERROR_CODES.TICKET_ATTACHMENT_UNAVAILABLE,
          'This attachment can no longer be fetched from Telegram.',
        );
      }
      bytes = fetched.bytes;
    }
    await reply
      .header('content-type', 'application/octet-stream')
      .header('x-content-type-options', 'nosniff')
      // The message's UUID: no quote, newline or semicolon, so the header is safe to build.
      .header('content-disposition', `attachment; filename="${message.id}"`)
      .header('content-length', String(bytes.byteLength))
      .header('cache-control', 'no-store')
      .send(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  }

  @Get(TICKET_ROUTES.categories)
  async categories(@Req() request: FastifyRequest): Promise<TicketCategoryListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const categories = await this.container.ticketCategories.list(scope, actor);
    return { categories: categories.map(toCategoryView) };
  }

  @Post(TICKET_ROUTES.categories)
  async createCategory(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<TicketCategoryResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const input = ticketCategoryCreateRequestSchema.parse(body);
    const result = await this.container.ticketCategories.create(scope, actor, input);
    return { category: toCategoryView(result.category), changed: result.changed };
  }

  @Post(routePattern(TICKET_ROUTES.category, 'categoryId'))
  async updateCategory(
    @Req() request: FastifyRequest,
    @Param('categoryId') categoryId: string,
    @Body() body: unknown,
  ): Promise<TicketCategoryResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const input = ticketCategoryUpdateRequestSchema.parse(body);
    const result = await this.container.ticketCategories.update(scope, actor, categoryId, {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
      ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
    });
    return { category: toCategoryView(result.category), changed: result.changed };
  }

  /** A triage write's answer: the inbox row as it now stands, and whether anything moved. */
  private async mutation(
    scope: TenantContext,
    actor: ReturnType<typeof adminActor>,
    result: { readonly ticket: { readonly id: string }; readonly changed: boolean },
  ): Promise<TicketMutationResponse> {
    const item = await this.container.tickets.summary(scope, actor, result.ticket.id);
    return { ticket: toSummary(item), changed: result.changed };
  }

  private async authenticate(
    request: FastifyRequest,
    options: { write?: boolean } = {},
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request, this.isProduction);
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

  private get isProduction(): boolean {
    return this.container.config.NODE_ENV === 'production';
  }
}

function displayNameOf(
  customer: { readonly firstName: string | null; readonly lastName: string | null } | null,
): string | null {
  if (customer === null) return null;
  const name = [customer.firstName, customer.lastName]
    .filter((part): part is string => part !== null && part.trim() !== '')
    .join(' ');
  return name === '' ? null : name;
}

function toSummary(item: TicketListItem): TicketSummary {
  const { ticket } = item;
  return {
    id: ticket.id,
    number: ticket.number,
    status: ticket.status,
    priority: ticket.priority,
    categoryId: ticket.categoryId,
    categoryTitle: ticket.categoryTitle,
    subject: ticket.subject,
    customerId: ticket.customerId,
    customerTelegramUserId: item.customer?.telegramUserId ?? null,
    customerUsername: item.customer?.username ?? null,
    customerDisplayName: displayNameOf(item.customer),
    assignedAdminId: ticket.assignedAdminId,
    assignedAdminUsername: item.assignedAdminUsername,
    serviceId: ticket.serviceId,
    orderId: ticket.orderId,
    paymentId: ticket.paymentId,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
    lastMessageAt: ticket.lastMessageAt.toISOString(),
    closedAt: ticket.closedAt === null ? null : ticket.closedAt.toISOString(),
  };
}

/** A message, minus the one field a browser may not hold: the attachment's `file_id`. */
function toMessageView(item: TicketMessageListItem): TicketMessageView {
  const message: TicketMessageRecord = item.message;
  return {
    id: message.id,
    senderType: message.senderType,
    authorAdminId: message.authorAdminId,
    authorAdminUsername: item.authorUsername,
    body: message.body,
    systemEvent: message.systemEvent,
    attachment:
      message.attachment !== null
        ? {
            kind: message.attachment.kind,
            mimeType: message.attachment.mimeType,
            fileName: message.attachment.fileName,
            // Safe as a number: an attachment is bounded at ten megabytes.
            fileSize:
              message.attachment.fileSize === null ? null : Number(message.attachment.fileSize),
          }
        : item.replyFile !== null
          ? {
              // HF-A7: support's file — what it is, never where its bytes or handle are.
              kind: item.replyFile.kind,
              mimeType: item.replyFile.mimeType,
              fileName: item.replyFile.fileName,
              fileSize: item.replyFile.byteLength,
            }
          : null,
    delivery: message.senderType === 'ADMIN' ? item.delivery : null,
    attachmentDelivery: item.replyFile === null ? null : item.attachmentDelivery,
    createdAt: message.createdAt.toISOString(),
  };
}

function toCategoryView(record: TicketCategoryRecord): TicketCategoryView {
  return {
    id: record.id,
    title: record.title,
    sortOrder: record.sortOrder,
    isActive: record.isActive,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
