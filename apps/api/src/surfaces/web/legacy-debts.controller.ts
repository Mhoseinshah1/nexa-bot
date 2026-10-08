import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  LEGACY_WALLET_DEBT_ROUTES,
  legacyWalletDebtListQuerySchema,
  routePattern,
  uuidV7Schema,
  type LegacyWalletDebtListResponse,
  type LegacyWalletDebtResponse,
  type LegacyWalletDebtSummaryResponse,
  type LegacyWalletDebtView,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type { LegacyWalletDebtRecord } from '../../modules/commerce/legacy-wallet-debts/application/ports.js';

/**
 * Mirza migration PR4 — legacy wallet debts over HTTP (owner decision 6).
 *
 * Its OWN service, `LegacyWalletDebtService`: the list of negative legacy balances held for
 * review, and the owner's per-customer decision. Never the opening-balance service (the
 * migration-only writer that records a debt; its boundary test forbids naming it here), and
 * never a wallet, ledger or payment path: a decision is a label and moves no money. The
 * service charges `legacy.debts.view` to read and `legacy.debts.decide` to decide, inside
 * its transaction.
 */
@Controller(`${API_PREFIX}`)
export class LegacyDebtsController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(LEGACY_WALLET_DEBT_ROUTES.list)
  async list(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
  ): Promise<LegacyWalletDebtListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const input = legacyWalletDebtListQuerySchema.parse(query ?? {});
    const page = await this.service.list(scope, actor, input);
    return { debts: page.items.map(toView), nextCursor: page.nextCursor };
  }

  @Get(LEGACY_WALLET_DEBT_ROUTES.summary)
  async summary(@Req() request: FastifyRequest): Promise<LegacyWalletDebtSummaryResponse> {
    const { scope, actor } = await this.authenticate(request);
    const s = await this.service.summary(scope, actor);
    return {
      currency: s.currency,
      total: { count: s.total.count, sumMinor: s.total.sumMinor.toString() },
      byState: Object.fromEntries(
        Object.entries(s.byState).map(([k, v]) => [
          k,
          { count: v.count, sumMinor: v.sumMinor.toString() },
        ]),
      ) as LegacyWalletDebtSummaryResponse['byState'],
    };
  }

  @Get(routePattern(LEGACY_WALLET_DEBT_ROUTES.detail, 'id'))
  async detail(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<LegacyWalletDebtResponse> {
    const { scope, actor } = await this.authenticate(request);
    return { debt: toView(await this.service.get(scope, actor, uuidV7Schema.parse(id))) };
  }

  @Post(routePattern(LEGACY_WALLET_DEBT_ROUTES.decide, 'id'))
  async decide(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<LegacyWalletDebtResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return { debt: toView(await this.service.decide(scope, actor, uuidV7Schema.parse(id), body)) };
  }

  @Post(routePattern(LEGACY_WALLET_DEBT_ROUTES.reopen, 'id'))
  async reopen(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<LegacyWalletDebtResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return { debt: toView(await this.service.reopen(scope, actor, uuidV7Schema.parse(id), body)) };
  }

  private get service() {
    return this.container.legacyWalletDebts;
  }

  private async authenticate(
    request: FastifyRequest,
    options: { write?: boolean } = {},
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request, this.container.config.NODE_ENV === 'production');
    if (options.write) assertOriginAllowed(request, this.container.config.WEB_ADMIN_ORIGINS);
    const { admin, session } = await this.container.auth.authenticate(token);
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    return {
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }
}

/** The wire shape: the amount as a decimal string of minor units, dates as ISO. */
export function toView(r: LegacyWalletDebtRecord): LegacyWalletDebtView {
  return {
    id: r.id,
    customerId: r.customerId,
    legacyUserId: r.legacyUserId,
    amountMinor: r.amountMinor.toString(),
    currency: r.currency,
    state: r.state,
    sourceFingerprint: r.sourceFingerprint,
    rowChecksum: r.rowChecksum,
    runId: r.runId,
    synthetic: r.synthetic,
    decisionReason: r.decisionReason,
    decidedByAdminId: r.decidedByAdminId,
    decidedAt: r.decidedAt === null ? null : r.decidedAt.toISOString(),
    version: r.version,
    recordedAt: r.recordedAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
