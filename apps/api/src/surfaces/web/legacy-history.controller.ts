import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  LEGACY_INVOICE_PRICE_CURRENCY,
  legacyCustomerAdoptionsQuerySchema,
  legacyCustomerInvoicesQuerySchema,
  legacyHistoryListQuerySchema,
  type LegacyCustomerAdoptionsResponse,
  type LegacyCustomerInvoicesResponse,
  type LegacyHistoryResponse,
  type LegacyMoneyHistoryResponse,
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
        ...(item.ticketRecordId === undefined ? {} : { ticketRecordId: item.ticketRecordId }),
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

  /**
   * The customer's Mirza invoices beside the importer's outcome for each (read-only). The
   * service charges `users.view` and `legacy.invoices.view`, and nulls the candidate without
   * `legacy.services.view` and the username without `legacy.invoices.pii.view`.
   */
  @Get('users/:id/legacy-invoices')
  async invoices(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Query() query: unknown,
  ): Promise<LegacyCustomerInvoicesResponse> {
    const { scope, actor } = await this.authenticate(request);
    const input = legacyCustomerInvoicesQuerySchema.parse(query ?? {});
    const page = await this.container.legacyHistoryRead.invoicesForCustomer(
      scope,
      actor,
      id,
      input,
    );
    return {
      invoices: page.rows.map((row) => ({
        archiveId: row.archiveId,
        invoiceKey: row.invoiceKey,
        revision: row.revision,
        classification: row.classification,
        live: row.live,
        status: row.status,
        isTest: row.isTest,
        username: row.username,
        panelCode: row.panelCode,
        productCode: row.productCode,
        productName: row.productName,
        priceMinor: row.priceMinor === null ? null : row.priceMinor.toString(),
        // The archive's CHECK admits IRT or NULL (owner decision 7).
        priceCurrency:
          row.priceCurrency === LEGACY_INVOICE_PRICE_CURRENCY
            ? LEGACY_INVOICE_PRICE_CURRENCY
            : null,
        soldAt: row.soldAt === null ? null : row.soldAt.toISOString(),
        candidate: row.candidate === null ? null : { ...row.candidate },
      })),
      nextCursor: page.nextCursor,
      piiRedacted: page.piiRedacted,
      candidatesVisible: page.candidatesVisible,
    };
  }

  /** Which of the given services of the customer were adopted from Mirza (`legacy.services.view`). */
  @Get('users/:id/legacy-adopted-services')
  async adoptions(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Query() query: unknown,
  ): Promise<LegacyCustomerAdoptionsResponse> {
    const { scope, actor } = await this.authenticate(request);
    const input = legacyCustomerAdoptionsQuerySchema.parse(query ?? {});
    const adoptions = await this.container.legacyHistoryRead.adoptionsForCustomer(
      scope,
      actor,
      id,
      input,
    );
    return { adoptions: adoptions.map((row) => ({ ...row })) };
  }

  /**
   * The customer's Mirza money history beside the migrated opening figure (read-only, never
   * added to a balance). The service charges `users.view`, then `legacy.history.view`.
   */
  @Get('users/:id/legacy-money-history')
  async moneyHistory(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<LegacyMoneyHistoryResponse> {
    const { scope, actor } = await this.authenticate(request);
    return this.container.legacyMoneyHistory.forCustomer(scope, actor, id);
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
