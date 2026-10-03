import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  customerNoteCreateRequestSchema,
  customerNoteListQuerySchema,
  customerTagArchiveRequestSchema,
  customerTagAssignmentRequestSchema,
  customerTagCreateRequestSchema,
  customerTagUpdateRequestSchema,
  type CustomerAssignedTagResponse,
  type CustomerNoteCreateResponse,
  type CustomerNoteListResponse,
  type CustomerNoteResponse,
  type CustomerTagAssignmentResponse,
  type CustomerTagListResponse,
  type CustomerTagResponse,
  type CustomerTagsResponse,
  type CustomerTagWriteResponse,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { singleValued } from './query.js';
import { decodeKeysetCursor, encodeKeysetCursor } from './keyset-cursor.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type {
  CustomerAssignedTagRecord,
  CustomerNoteRecord,
  CustomerTagRecord,
} from '../../modules/commerce/customers/application/customer-crm-ports.js';

/**
 * Customer notes and tags over HTTP (program §8, `docs/customer-notes-tags.md`).
 *
 * The WEB ADMIN surface, and the only one: no Telegram handler, no customer API and no
 * client-app route reaches `CustomerCrmService` (`tests/unit/customer-crm-privacy.test.ts`).
 *
 * Authentication happens here; AUTHORIZATION does not. Every method calls the service, which
 * charges its own permission through the guard — `users.view` for reading tags,
 * `users.tags.manage` for the catalogue, `users.tags.assign` for a customer's tags,
 * `users.notes.view` / `users.notes.write` for notes. Every write carries its idempotency key
 * in the body and is refused from an origin the installation does not list.
 */
@Controller(`${API_PREFIX}`)
export class CustomerCrmController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  // --- The tag catalogue ----------------------------------------------------------------

  @Get('customer-tags')
  async listTags(@Req() request: FastifyRequest): Promise<CustomerTagListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const tags = await this.container.customerCrm.listTags(scope, actor);
    return { tags: tags.map(toTag) };
  }

  @Post('customer-tags')
  async createTag(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<CustomerTagWriteResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = customerTagCreateRequestSchema.parse(body);
    const result = await this.container.customerCrm.createTag(scope, actor, command);
    return { tag: toTag(result.tag), changed: result.changed };
  }

  @Post('customer-tags/:tagId')
  async updateTag(
    @Req() request: FastifyRequest,
    @Param('tagId') tagId: string,
    @Body() body: unknown,
  ): Promise<CustomerTagWriteResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = customerTagUpdateRequestSchema.parse(body);
    const result = await this.container.customerCrm.updateTag(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      tagId,
      label: command.label,
      color: command.color,
    });
    return { tag: toTag(result.tag), changed: result.changed };
  }

  @Post('customer-tags/:tagId/archive')
  async archiveTag(
    @Req() request: FastifyRequest,
    @Param('tagId') tagId: string,
    @Body() body: unknown,
  ): Promise<CustomerTagWriteResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = customerTagArchiveRequestSchema.parse(body);
    const result = await this.container.customerCrm.setTagArchived(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      tagId,
      archived: command.archived,
    });
    return { tag: toTag(result.tag), changed: result.changed };
  }

  // --- One customer's tags --------------------------------------------------------------

  @Get('users/:id/tags')
  async customerTags(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<CustomerTagsResponse> {
    const { scope, actor } = await this.authenticate(request);
    const tags = await this.container.customerCrm.tagsOf(scope, actor, id);
    return { tags: tags.map(toAssigned) };
  }

  @Post('users/:id/tags')
  async assignTag(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CustomerTagAssignmentResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = customerTagAssignmentRequestSchema.parse(body);
    const result = await this.container.customerCrm.assignTag(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      customerId: id,
      tagId: command.tagId,
    });
    return { tags: result.tags.map(toAssigned), changed: result.changed };
  }

  @Post('users/:id/tags/remove')
  async removeTag(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CustomerTagAssignmentResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = customerTagAssignmentRequestSchema.parse(body);
    const result = await this.container.customerCrm.removeTag(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      customerId: id,
      tagId: command.tagId,
    });
    return { tags: result.tags.map(toAssigned), changed: result.changed };
  }

  // --- Notes ----------------------------------------------------------------------------

  @Get('users/:id/notes')
  async notes(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Query() raw: Record<string, unknown>,
  ): Promise<CustomerNoteListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const query = customerNoteListQuerySchema.parse(singleValued(raw));
    const page = await this.container.customerCrm.notesOf(scope, actor, {
      customerId: id,
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { cursor: decodeKeysetCursor(query.cursor) }),
    });
    return {
      notes: page.items.map(toNote),
      nextCursor: page.nextCursor === null ? null : encodeKeysetCursor(page.nextCursor),
    };
  }

  @Post('users/:id/notes')
  async addNote(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CustomerNoteCreateResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = customerNoteCreateRequestSchema.parse(body);
    const result = await this.container.customerCrm.addNote(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      customerId: id,
      body: command.body,
    });
    return { note: toNote(result.note), created: result.created };
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
      // A customer belongs to the TENANT, not to a bot: see `CustomersController`.
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }

  private get isProduction(): boolean {
    return this.container.config.NODE_ENV === 'production';
  }
}

function toTag(tag: CustomerTagRecord): CustomerTagResponse {
  return {
    id: tag.id,
    label: tag.label,
    color: tag.color,
    archivedAt: tag.archivedAt?.toISOString() ?? null,
    createdAt: tag.createdAt.toISOString(),
    updatedAt: tag.updatedAt.toISOString(),
  };
}

function toAssigned(tag: CustomerAssignedTagRecord): CustomerAssignedTagResponse {
  return { ...toTag(tag), assignedAt: tag.assignedAt.toISOString() };
}

function toNote(note: CustomerNoteRecord): CustomerNoteResponse {
  return {
    id: note.id,
    body: note.body,
    authorAdminId: note.authorAdminId,
    authorLabel: note.authorLabel,
    createdAt: note.createdAt.toISOString(),
  };
}
