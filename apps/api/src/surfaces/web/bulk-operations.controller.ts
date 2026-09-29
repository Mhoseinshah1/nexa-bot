import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  BULK_PAGE_DEFAULT,
  bulkItemListQuerySchema,
  bulkOperationListQuerySchema,
  bulkPreviewRequestSchema,
  createBulkOperationRequestSchema,
  type BulkCounts,
  type BulkItemListResponse,
  type BulkOperationListResponse,
  type BulkOperationResponse,
  type BulkOperationResponseItem,
  type BulkPreviewResponse,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { singleValued } from './query.js';
import { decodeKeysetCursor, encodeKeysetCursor } from './keyset-cursor.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type { BulkOperationRecord } from '../../modules/commerce/bulk-operations/application/ports.js';

const EMPTY: BulkCounts = {
  total: 0,
  pending: 0,
  credited: 0,
  planned: 0,
  awaitingReconciliation: 0,
  succeeded: 0,
  failed: 0,
  skipped: 0,
  cancelled: 0,
  notified: 0,
};

/**
 * Safe mass actions over HTTP (round N, B2): «عملیات گروهی». Authorization is the service's:
 * `bulk_operations.view` to read, `users.wallet.mass` for a wallet credit and
 * `services.mass.grant` for a traffic or time grant — preview, confirm and cancel alike.
 */
@Controller(`${API_PREFIX}/bulk-operations`)
export class BulkOperationsController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get()
  async list(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<BulkOperationListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const query = bulkOperationListQuerySchema.parse(singleValued(raw));
    const limit = query.limit ?? BULK_PAGE_DEFAULT;
    const position = query.cursor === undefined ? null : decodeKeysetCursor(query.cursor);
    const records = await this.container.bulkOperations.list(scope, actor, {
      limit: limit + 1,
      cursor:
        position === null ? null : { createdAt: new Date(position.createdAt), id: position.id },
    });
    const page = records.slice(0, limit);
    const progress = await this.container.bulkOperations.progress(
      scope,
      actor,
      page.map((record) => record.id),
    );
    const last = page.at(-1);
    return {
      operations: page.map((record) =>
        toItem(record, progress.counts.get(record.id) ?? EMPTY, progress.credited.get(record.id)),
      ),
      nextCursor:
        records.length > limit && last !== undefined
          ? encodeKeysetCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : null,
    };
  }

  /** ADR-0010's dry run and counted preview. Writes nothing. */
  @Post('preview')
  async preview(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<BulkPreviewResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = bulkPreviewRequestSchema.parse(body);
    return { preview: await this.container.bulkOperations.preview(scope, actor, command) };
  }

  @Post()
  async create(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<BulkOperationResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = createBulkOperationRequestSchema.parse(body);
    const record = await this.container.bulkOperations.create(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      grant: command.grant,
      definition: command.definition,
      notify: command.notify,
      note: command.note,
      expectedDefinitionHash: command.expectedDefinitionHash,
      expectedCount: command.expectedCount,
      expectedFingerprint: command.expectedFingerprint,
      expectedTotalMinor: command.expectedTotalMinor,
      typedCount: command.typedCount,
      notBefore: command.notBefore === null ? null : new Date(command.notBefore),
    });
    return this.respond(scope, actor, record);
  }

  @Get(':id')
  async one(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<BulkOperationResponse> {
    const { scope, actor } = await this.authenticate(request);
    return this.respond(scope, actor, await this.container.bulkOperations.get(scope, actor, id));
  }

  @Post(':id/cancel')
  async cancel(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<BulkOperationResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return this.respond(scope, actor, await this.container.bulkOperations.cancel(scope, actor, id));
  }

  @Get(':id/items')
  async items(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Query() raw: Record<string, unknown>,
  ): Promise<BulkItemListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const query = bulkItemListQuerySchema.parse(singleValued(raw));
    const limit = query.limit ?? BULK_PAGE_DEFAULT;
    const rows = await this.container.bulkOperations.items(scope, actor, id, {
      state: query.state ?? null,
      limit: limit + 1,
      after: query.cursor ?? null,
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => ({
        id: row.id,
        customerId: row.customerId,
        firstName: row.firstName,
        username: row.username,
        serviceId: row.serviceId,
        serviceLabel: row.serviceLabel,
        state: row.state,
        skipReason: row.skipReason,
        operationState: row.operationState,
        failureKind: row.failureKind,
        notified: row.notified,
        processedAt: row.processedAt?.toISOString() ?? null,
      })),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  private async respond(
    scope: TenantContext,
    actor: ReturnType<typeof adminActor>,
    record: BulkOperationRecord,
  ): Promise<BulkOperationResponse> {
    const progress = await this.container.bulkOperations.progress(scope, actor, [record.id]);
    return {
      operation: toItem(
        record,
        progress.counts.get(record.id) ?? EMPTY,
        progress.credited.get(record.id),
      ),
    };
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

/** The one record → HTTP conversion. */
export function toItem(
  record: BulkOperationRecord,
  counts: BulkCounts,
  credited: bigint | undefined,
): BulkOperationResponseItem {
  const done = counts.total - counts.pending - counts.planned;
  const money = (amount: bigint | null) =>
    amount === null || record.currency === null
      ? null
      : { amountMinor: amount.toString(), currency: record.currency };
  return {
    id: record.id,
    kind: record.kind,
    state: record.state,
    amount: money(record.amountMinor),
    trafficBytes: record.trafficBytes?.toString() ?? null,
    durationDays: record.durationDays,
    notify: record.notify,
    note: record.note,
    audience: record.audienceDefinition,
    audienceHash: record.audienceHash,
    audienceAsOf: record.audienceAsOf.toISOString(),
    notBefore: record.notBefore?.toISOString() ?? null,
    itemCount: record.itemCount,
    fingerprint: record.audienceFingerprint,
    totalLiability: money(
      record.amountMinor === null ? null : record.amountMinor * BigInt(record.itemCount),
    ),
    creditedTotal: record.kind === 'WALLET_CREDIT' ? money(credited ?? 0n) : null,
    counts,
    progressPercent: counts.total === 0 ? 0 : Math.floor((done * 100) / counts.total),
    createdBy: record.createdBy,
    createdAt: record.createdAt.toISOString(),
    completedAt: record.completedAt?.toISOString() ?? null,
    cancelledAt: record.cancelledAt?.toISOString() ?? null,
  };
}
