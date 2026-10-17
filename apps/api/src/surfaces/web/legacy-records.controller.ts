import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  COMMERCE_ERROR_CODES,
  errors,
  legacyRecordsListQuerySchema,
  type LegacyRecordsListResponse,
  type LegacyRecordsSummaryResponse,
  type LegacyServiceHistoryResponse,
  type TenantContext,
} from '@nexa/contracts';
import { z } from 'zod';
import { CONTAINER, type Container } from '../../container.js';
import type { LegacyRecordItem } from '../../modules/platform/legacy-history/application/legacy-records-read.service.js';
import { adminActor, requireSessionToken } from './authenticated-request.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';

/**
 * «سوابق و تنظیمات میرزا» over HTTP, READ-ONLY: the whole Mirza history archive (types,
 * counts, customer-less records, the registry's inactive panels) and one service's Mirza
 * records. There is no write route. `LegacyRecordsReadService` charges `legacy.history.view`
 * (and `services.view` for the service section) and redacts like the Customer 360 card.
 */
@Controller(`${API_PREFIX}`)
export class LegacyRecordsController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get('legacy-records/summary')
  async summary(@Req() request: FastifyRequest): Promise<LegacyRecordsSummaryResponse> {
    const { scope, actor } = await this.authenticate(request);
    const summary = await this.container.legacyRecordsRead.summary(scope, actor);
    return {
      byType: summary.byType.map((row) => ({
        recordType: row.recordType,
        total: row.records,
        unlinked: row.unlinked,
      })),
      total: summary.records,
      unlinked: summary.unlinked,
      inactivePanels: summary.inactivePanels.map((panel) => ({ ...panel })),
    };
  }

  @Get('legacy-records')
  async list(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
  ): Promise<LegacyRecordsListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const input = legacyRecordsListQuerySchema.parse(query ?? {});
    const page = await this.container.legacyRecordsRead.list(scope, actor, input);
    return {
      items: page.items.map(itemView),
      nextCursor: page.nextCursor,
      piiRedacted: page.piiRedacted,
    };
  }

  @Get('services/:id/legacy-history')
  async forService(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<LegacyServiceHistoryResponse> {
    const { scope, actor } = await this.authenticate(request);
    const parsed = z.uuid().safeParse(id);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not a valid service identifier.',
      );
    }
    const history = await this.container.legacyRecordsRead.forService(scope, actor, parsed.data);
    return {
      invoiceKeys: [...history.invoiceKeys],
      items: history.items.map(itemView),
      truncated: history.truncated,
      piiRedacted: history.piiRedacted,
    };
  }

  private async authenticate(
    request: FastifyRequest,
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request, this.container.config.NODE_ENV === 'production');
    const { admin, session } = await this.container.auth.authenticate(token);
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    return {
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }
}

function itemView(item: LegacyRecordItem) {
  return {
    id: item.id,
    recordType: item.recordType,
    occurredAt: item.occurredAt === null ? null : item.occurredAt.toISOString(),
    packageImportId: item.packageImportId,
    summary: { ...item.summary },
    payload: { ...item.payload },
    redacted: [...item.redacted],
    legacyUserId: item.legacyUserId,
    customerLinked: item.customerLinked,
  };
}
