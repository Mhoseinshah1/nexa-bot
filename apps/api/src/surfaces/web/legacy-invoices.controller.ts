import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  LEGACY_INVOICE_PRICE_CURRENCY,
  LEGACY_INVOICE_ARCHIVE_ROUTES,
  legacyInvoiceArchiveListQuerySchema,
  routePattern,
  uuidV7Schema,
  type LegacyInvoiceArchiveDetailResponse,
  type LegacyInvoiceArchiveListResponse,
  type LegacyInvoiceArchiveRowView,
  type LegacyInvoiceArchiveRunView,
  type LegacyInvoiceArchiveSummaryResponse,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, requireSessionToken } from './authenticated-request.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type { LegacyInvoiceArchiveReadRow } from '../../modules/platform/legacy-invoice-archive/application/legacy-invoice-archive.service.js';
import type { LegacyInvoiceArchiveRun } from '../../modules/platform/legacy-invoice-archive/application/ports.js';

/**
 * Mirza migration PR3 — the legacy invoice archive over HTTP, READ-ONLY.
 *
 * Its own service, `LegacyInvoiceArchiveService` — never the importer, its review queue or
 * its adoption, which no surface may reach. There is no write route at all: the archive is
 * written only by `legacy-import invoices-read`. The service charges `legacy.invoices.view`
 * to read and `legacy.invoices.pii.view` to see (or search by) the personal cells, which it
 * otherwise returns NULL (`piiRedacted`).
 */
@Controller(`${API_PREFIX}`)
export class LegacyInvoicesController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(LEGACY_INVOICE_ARCHIVE_ROUTES.list)
  async list(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
  ): Promise<LegacyInvoiceArchiveListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const input = legacyInvoiceArchiveListQuerySchema.parse(query ?? {});
    const page = await this.service.list(scope, actor, input);
    return { rows: page.rows.map((row) => rowView(row)), nextCursor: page.nextCursor };
  }

  @Get(LEGACY_INVOICE_ARCHIVE_ROUTES.summary)
  async summary(@Req() request: FastifyRequest): Promise<LegacyInvoiceArchiveSummaryResponse> {
    const { scope, actor } = await this.authenticate(request);
    const summary = await this.service.summary(scope, actor);
    return {
      invoices: summary.invoices,
      revisions: summary.revisions,
      classes: { ...summary.classes },
      runs: summary.runs.map(runView),
    };
  }

  @Get(routePattern(LEGACY_INVOICE_ARCHIVE_ROUTES.detail, 'id'))
  async detail(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<LegacyInvoiceArchiveDetailResponse> {
    const { scope, actor } = await this.authenticate(request);
    const detail = await this.service.get(scope, actor, uuidV7Schema.parse(id));
    return {
      row: rowView(detail),
      raw: { ...detail.raw },
      redactedColumns: [...detail.redactedColumns],
      revisions: detail.revisions.map((revision) => ({
        id: revision.id,
        revision: revision.revision,
        revisionReason: revision.revisionReason,
        classification: revision.classification,
        rowChecksum: revision.rowChecksum,
        sourceFingerprint: revision.sourceFingerprint,
        readSetFingerprint: revision.readSetFingerprint,
        runId: revision.runId,
        archivedAt: revision.archivedAt.toISOString(),
        visible: revision.visible,
      })),
      importOutcome: detail.importOutcome,
    };
  }

  private get service() {
    return this.container.legacyInvoiceArchive;
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

/** The wire shape: bigints as decimal strings, dates as ISO. PII fields arrive already null. */
function rowView(row: LegacyInvoiceArchiveReadRow): LegacyInvoiceArchiveRowView {
  const r = row.record;
  return {
    id: r.id,
    invoiceKey: r.invoiceKey,
    revision: r.revision,
    revisionReason: r.revisionReason,
    keyShapeEvidenced: r.keyShapeEvidenced,
    classification: r.classification,
    live: r.live,
    status: r.status,
    isTest: r.isTest,
    ownerPresent: r.ownerPresent,
    piiRedacted: row.piiRedacted,
    legacyUserId: row.piiRedacted ? null : r.legacyUserId,
    username: row.piiRedacted ? null : r.username,
    panelCode: r.panelCode,
    productCode: r.productCode,
    productRef: r.productRef,
    productName: r.productName,
    priceRaw: r.priceRaw,
    priceMinor: r.priceMinor === null ? null : r.priceMinor.toString(),
    // The archive's CHECK admits IRT or NULL: the currency the owner stated (decision 7).
    priceCurrency:
      r.priceCurrency === LEGACY_INVOICE_PRICE_CURRENCY ? LEGACY_INVOICE_PRICE_CURRENCY : null,
    priceNote: r.priceNote,
    soldAtRaw: r.soldAtRaw,
    soldAt: r.soldAt === null ? null : r.soldAt.toISOString(),
    soldAtNote: r.soldAtNote,
    rowChecksum: r.rowChecksum,
    sourceFingerprint: r.sourceFingerprint,
    readSetFingerprint: r.readSetFingerprint,
    runId: r.runId,
    archivedAt: r.archivedAt.toISOString(),
  };
}

function runView(run: LegacyInvoiceArchiveRun): LegacyInvoiceArchiveRunView {
  const n = (value: bigint | null) => (value === null ? null : Number(value));
  return {
    id: run.id,
    state: run.state,
    failureCode: run.failureCode,
    readSetFingerprint: run.readSetFingerprint,
    sourceFingerprint: run.sourceFingerprint,
    synthetic: run.synthetic,
    sourceInvoiceRows: n(run.sourceInvoiceRows),
    insertedNew: Number(run.insertedNew),
    insertedRevision: Number(run.insertedRevision),
    unchanged: Number(run.unchanged),
    missingInSnapshot: n(run.missingInSnapshot),
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt === null ? null : run.finishedAt.toISOString(),
  };
}
