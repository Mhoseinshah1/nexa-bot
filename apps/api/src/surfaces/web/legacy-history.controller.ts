import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  legacyHistoryListQuerySchema,
  type LegacyHistoryResponse,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, requireSessionToken } from './authenticated-request.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';

/**
 * Mirza `.nxpkg` importer — a customer's archived Mirza history over HTTP, READ-ONLY
 * (`docs/legacy-migration/nxpkg-importer.md` §5). There is no write route: the archive is
 * written only by the migration role's history ingest. `LegacyHistoryReadService` charges
 * `users.view`, then `legacy.history.view`, and returns personal fields null unless the
 * reader holds `legacy.invoices.pii.view` too.
 */
@Controller(`${API_PREFIX}`)
export class LegacyHistoryController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get('users/:id/legacy-history')
  async list(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Query() query: unknown,
  ): Promise<LegacyHistoryResponse> {
    const { scope, actor } = await this.authenticate(request);
    const input = legacyHistoryListQuerySchema.parse(query ?? {});
    const page = await this.container.legacyHistoryRead.forCustomer(scope, actor, id, input);
    return {
      items: page.items.map((item) => ({
        id: item.id,
        recordType: item.recordType,
        occurredAt: item.occurredAt === null ? null : item.occurredAt.toISOString(),
        packageImportId: item.packageImportId,
        summary: { ...item.summary },
        payload: { ...item.payload },
        redacted: [...item.redacted],
        legacyUserId: item.legacyUserId,
      })),
      matching: page.matching,
      offset: page.offset,
      limit: page.limit,
      byType: page.byType.map((row) => ({ recordType: row.recordType, count: row.count })),
      piiRedacted: page.piiRedacted,
      invoiceArchive: page.invoiceArchive === null ? null : { ...page.invoiceArchive },
      walletDebts: page.walletDebts === null ? null : { ...page.walletDebts },
    };
  }

  private async authenticate(
    request: FastifyRequest,
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request, this.container.config.NODE_ENV === 'production');
    const { admin, session } = await this.container.auth.authenticate(token);
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    return {
      // A customer belongs to the TENANT, not to a bot (as on every Customer 360 route).
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }
}
