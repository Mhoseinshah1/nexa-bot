import { Controller, Get, Inject, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  REPORT_ROUTES,
  reportExportQuerySchema,
  reportOperationsQuerySchema,
  reportOrdersQuerySchema,
  reportPaymentAttemptsQuerySchema,
  reportProductsQuerySchema,
  reportRangeQuerySchema,
  reportReferralsQuerySchema,
  reportTrendQuerySchema,
  type ReportFailuresResponse,
  type ReportInfrastructureResponse,
  type ReportOperationsResponse,
  type ReportOrdersResponse,
  type ReportPaymentAttemptsResponse,
  type ReportPaymentsResponse,
  type ReportProductsResponse,
  type ReportReferralsResponse,
  type ReportResellersResponse,
  type ReportServicesResponse,
  type ReportSummaryResponse,
  type ReportTrendResponse,
  type ReportWalletResponse,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, requireSessionToken } from './authenticated-request.js';
import { singleValued } from './query.js';
import { decodeKeysetCursor, encodeKeysetCursor } from './keyset-cursor.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type { ReportRangeRequest } from '../../modules/commerce/reporting/application/reporting.service.js';
import type { KeysetPosition } from '../../modules/commerce/reporting/application/ports.js';

/**
 * WP12's business reports, over HTTP (`docs/wp12-business-analytics-audit.md` §7).
 *
 * Every route is a GET and every one is Super Admin only. Authentication happens here;
 * AUTHORITY is charged by `ReportingService` — `reports.view` (or `reports.export`) AND the
 * owner role — before it reads anything, so hiding the page in the Web Admin protects
 * nothing and is not relied on. The tenant comes from the session, never from the request.
 */
@Controller(`${API_PREFIX}`)
export class ReportsController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(REPORT_ROUTES.summary)
  async summary(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<ReportSummaryResponse> {
    const { scope, actor } = await this.authenticate(request);
    return this.container.reports.summary(scope, actor, rangeOf(raw));
  }

  @Get(REPORT_ROUTES.trend)
  async trend(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<ReportTrendResponse> {
    const { scope, actor } = await this.authenticate(request);
    const query = reportTrendQuerySchema.parse(pick(raw, ['metric', 'currency']));
    return this.container.reports.trend(scope, actor, rangeOf(raw), query.metric, query.currency);
  }

  @Get(REPORT_ROUTES.products)
  async products(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<ReportProductsResponse> {
    const { scope, actor } = await this.authenticate(request);
    const query = reportProductsQuerySchema.parse(pick(raw, ['by', 'limit', 'page']));
    return this.container.reports.products(scope, actor, rangeOf(raw), query.by, {
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.page === undefined ? {} : { page: query.page }),
    });
  }

  @Get(REPORT_ROUTES.services)
  async services(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<ReportServicesResponse> {
    const { scope, actor } = await this.authenticate(request);
    return this.container.reports.services(scope, actor, rangeOf(raw));
  }

  @Get(REPORT_ROUTES.infrastructure)
  async infrastructure(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<ReportInfrastructureResponse> {
    const { scope, actor } = await this.authenticate(request);
    return this.container.reports.infrastructure(scope, actor, rangeOf(raw));
  }

  @Get(REPORT_ROUTES.payments)
  async payments(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<ReportPaymentsResponse> {
    const { scope, actor } = await this.authenticate(request);
    return this.container.reports.payments(scope, actor, rangeOf(raw));
  }

  @Get(REPORT_ROUTES.wallet)
  async wallet(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<ReportWalletResponse> {
    const { scope, actor } = await this.authenticate(request);
    return this.container.reports.wallet(scope, actor, rangeOf(raw));
  }

  @Get(REPORT_ROUTES.referrals)
  async referrals(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<ReportReferralsResponse> {
    const { scope, actor } = await this.authenticate(request);
    const query = reportReferralsQuerySchema.parse(pick(raw, ['by', 'limit', 'page']));
    return this.container.reports.referrals(scope, actor, rangeOf(raw), query.by ?? 'SIGNUPS', {
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.page === undefined ? {} : { page: query.page }),
    });
  }

  @Get(REPORT_ROUTES.resellers)
  async resellers(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<ReportResellersResponse> {
    const { scope, actor } = await this.authenticate(request);
    return this.container.reports.resellers(scope, actor, rangeOf(raw));
  }

  @Get(REPORT_ROUTES.failures)
  async failures(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<ReportFailuresResponse> {
    const { scope, actor } = await this.authenticate(request);
    return this.container.reports.failures(scope, actor, rangeOf(raw));
  }

  @Get(REPORT_ROUTES.orders)
  async orders(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<ReportOrdersResponse> {
    const { scope, actor } = await this.authenticate(request);
    const query = reportOrdersQuerySchema.parse(
      pick(raw, ['purpose', 'productId', 'limit', 'cursor']),
    );
    const result = await this.container.reports.orders(scope, actor, rangeOf(raw), {
      ...(query.purpose === undefined ? {} : { purpose: query.purpose }),
      ...(query.productId === undefined ? {} : { productId: query.productId }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { after: positionOf(query.cursor) }),
    });
    return { ...result.response, nextCursor: cursorOf(result.next) };
  }

  @Get(REPORT_ROUTES.paymentAttempts)
  async paymentAttempts(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<ReportPaymentAttemptsResponse> {
    const { scope, actor } = await this.authenticate(request);
    const query = reportPaymentAttemptsQuerySchema.parse(
      pick(raw, ['method', 'provider', 'kind', 'state', 'limit', 'cursor']),
    );
    const result = await this.container.reports.paymentAttempts(scope, actor, rangeOf(raw), {
      ...(query.method === undefined ? {} : { method: query.method }),
      ...(query.provider === undefined ? {} : { provider: query.provider }),
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.state === undefined ? {} : { state: query.state }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { after: positionOf(query.cursor) }),
    });
    return { ...result.response, nextCursor: cursorOf(result.next) };
  }

  @Get(REPORT_ROUTES.operations)
  async operations(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<ReportOperationsResponse> {
    const { scope, actor } = await this.authenticate(request);
    const query = reportOperationsQuerySchema.parse(pick(raw, ['group', 'limit', 'cursor']));
    const result = await this.container.reports.operations(scope, actor, rangeOf(raw), {
      ...(query.group === undefined ? {} : { group: query.group }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { after: positionOf(query.cursor) }),
    });
    return { ...result.response, nextCursor: cursorOf(result.next) };
  }

  /**
   * One report as a CSV or XLSX download.
   *
   * `@Res()` for the reason the backup download gives: a returned buffer would be
   * serialised as JSON. `attachment` and `nosniff`, and `no-store`, because a financial
   * report must not sit in a proxy or a browser cache. The file name is built on the
   * server from the report kind and tenant-calendar dates only — Latin digits and dashes —
   * which is what makes it safe inside the header.
   */
  @Get(REPORT_ROUTES.export)
  async export(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query() raw: Record<string, unknown>,
  ): Promise<void> {
    const { scope, actor } = await this.authenticate(request);
    const query = reportExportQuerySchema.parse(pick(raw, ['report', 'format']));
    const file = await this.container.reports.export(
      scope,
      actor,
      rangeOf(raw),
      query.report,
      query.format,
    );
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
    // A report is the TENANT's: every bot it runs sells into the same orders.
    return {
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }

  private get isProduction(): boolean {
    return this.container.config.NODE_ENV === 'production';
  }
}

/** The period every report takes, proved to be single-valued and well-formed. */
function rangeOf(raw: Record<string, unknown>): ReportRangeRequest {
  const parsed = reportRangeQuerySchema.parse(pick(raw, ['range', 'from', 'to']));
  return {
    range: parsed.range,
    ...(parsed.from === undefined ? {} : { from: parsed.from }),
    ...(parsed.to === undefined ? {} : { to: parsed.to }),
  };
}

/** The named parameters only, each a single value (`singleValued`), absent ones omitted. */
function pick(raw: Record<string, unknown>, keys: readonly string[]): Record<string, string> {
  const query = singleValued(raw);
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = query[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function positionOf(raw: string): KeysetPosition {
  const position = decodeKeysetCursor(raw);
  return { at: position.createdAt, id: position.id };
}

function cursorOf(next: KeysetPosition | null): string | null {
  return next === null ? null : encodeKeysetCursor({ createdAt: next.at, id: next.id });
}
