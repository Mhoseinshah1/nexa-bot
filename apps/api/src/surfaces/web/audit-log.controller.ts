import { Controller, Get, Inject, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  AUDIT_LOG_ROUTES,
  auditLogExportQuerySchema,
  auditLogListQuerySchema,
  type AuditLogListResponse,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, requireSessionToken } from './authenticated-request.js';
import { singleValued } from './query.js';
import { decodeKeysetCursor, encodeKeysetCursor } from './keyset-cursor.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type { AuditLogQuery } from '../../modules/platform/audit/application/audit-log.service.js';

/**
 * The audit log browser over HTTP (Phase D1, `docs/audit-log.md`).
 *
 * Both routes are GETs. Authority is charged by `AuditLogService` — `audit.view`, and
 * `audit.export` for the file — before anything is read. The tenant comes from the session,
 * never from the request, which is the whole of tenant isolation here: a cursor minted in
 * one tenant and replayed in another selects inside the other and finds nothing of the first.
 */
@Controller(`${API_PREFIX}`)
export class AuditLogController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(AUDIT_LOG_ROUTES.list)
  async list(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<AuditLogListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const query = auditLogListQuerySchema.parse(singleValued(raw));
    // The cursor is decoded only after the session and the schema: an unreadable one is a
    // 400 (`keyset-cursor.ts`), never page one.
    const position = query.cursor === undefined ? undefined : decodeKeysetCursor(query.cursor);
    const page = await this.container.auditLog.list(scope, actor, filtersOf(query), {
      limit: query.limit,
      ...(position === undefined
        ? {}
        : { after: { occurredAt: position.createdAt, id: position.id } }),
    });
    return {
      entries: [...page.entries],
      nextCursor:
        page.next === null
          ? null
          : encodeKeysetCursor({ createdAt: page.next.occurredAt, id: page.next.id }),
    };
  }

  /**
   * The same filters as a CSV download. `attachment`, `nosniff` and `no-store` for the
   * reasons the report export gives; the file name is built on the server from the clock.
   */
  @Get(AUDIT_LOG_ROUTES.export)
  async export(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query() raw: Record<string, unknown>,
  ): Promise<void> {
    const { scope, actor } = await this.authenticate(request);
    const query = auditLogExportQuerySchema.parse(singleValued(raw));
    const file = await this.container.auditLog.export(scope, actor, filtersOf(query));
    await reply
      .header('content-type', file.contentType)
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', `attachment; filename="${file.fileName}"`)
      .header('content-length', String(file.bytes.byteLength))
      .header('cache-control', 'no-store')
      .send(Buffer.from(file.bytes));
  }

  private async authenticate(
    request: FastifyRequest,
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request, this.isProduction);
    const { admin, session } = await this.container.auth.authenticate(token);
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    // The log is the TENANT's: every bot it runs writes into the same trail.
    return {
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }

  private get isProduction(): boolean {
    return this.container.config.NODE_ENV === 'production';
  }
}

/** The parsed filters, with the two instants read here — the surface may parse a timestamp. */
function filtersOf(query: {
  readonly actor?: string | undefined;
  readonly actorType?: AuditLogQuery['actorType'];
  readonly customerId?: string | undefined;
  readonly action?: string | undefined;
  readonly entityType?: string | undefined;
  readonly entityId?: string | undefined;
  readonly result?: AuditLogQuery['result'];
  readonly security?: AuditLogQuery['security'];
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}): AuditLogQuery {
  return {
    actor: query.actor,
    actorType: query.actorType,
    customerId: query.customerId,
    action: query.action,
    entityType: query.entityType,
    entityId: query.entityId,
    result: query.result,
    security: query.security,
    from: query.from === undefined ? undefined : new Date(query.from),
    to: query.to === undefined ? undefined : new Date(query.to),
  };
}
