import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  REFERRAL_ROUTES,
  referralCommissionListQuerySchema,
  referralListQuerySchema,
  type CustomerReferralResponse,
  type ReferralCommissionListResponse,
  type ReferralCommissionSummaryResponse,
  type ReferralListResponse,
  type ReferralSummaryResponse,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, requireSessionToken } from './authenticated-request.js';
import { singleValued } from './query.js';
import { decodeKeysetCursor, encodeKeysetCursor } from './keyset-cursor.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type {
  ReferralCommissionListing,
  ReferralCursor,
  ReferralListing,
} from '../../modules/commerce/referrals/application/ports.js';

/**
 * Referral attributions and commissions, over HTTP (`docs/wp9-referral-audit.md` F10).
 *
 * READ-ONLY: three GETs and no write, because there is no administrative write to an
 * attribution or a commission. Authentication here; `referrals.view` is charged by
 * `ReferralReadService`, so nothing is protected by the Web Admin not drawing a page.
 *
 * Every path is a literal, never a client URL builder called with `':id'`.
 */
@Controller(`${API_PREFIX}`)
export class ReferralsController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(REFERRAL_ROUTES.list)
  async list(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<ReferralListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const query = singleValued(raw);
    const page = referralListQuerySchema.parse({
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.referrerId === undefined ? {} : { referrerId: query.referrerId }),
    });
    const result = await this.container.referralsRead.list(scope, actor, {
      ...(page.limit === undefined ? {} : { limit: page.limit }),
      ...(page.cursor === undefined ? {} : { cursor: cursorFrom(page.cursor) }),
      ...(page.referrerId === undefined ? {} : { referrerId: page.referrerId }),
    });
    return {
      referrals: result.items.map(toReferralSummary),
      nextCursor: result.next === null ? null : encodeKeysetCursor(result.next),
    };
  }

  @Get(REFERRAL_ROUTES.commissions)
  async commissions(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<ReferralCommissionListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const query = singleValued(raw);
    const page = referralCommissionListQuerySchema.parse({
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.state === undefined ? {} : { state: query.state }),
      ...(query.referrerId === undefined ? {} : { referrerId: query.referrerId }),
    });
    const result = await this.container.referralsRead.commissions(scope, actor, {
      ...(page.limit === undefined ? {} : { limit: page.limit }),
      ...(page.cursor === undefined ? {} : { cursor: cursorFrom(page.cursor) }),
      ...(page.state === undefined ? {} : { state: page.state }),
      ...(page.referrerId === undefined ? {} : { referrerId: page.referrerId }),
    });
    return {
      commissions: result.items.map(toCommissionSummary),
      nextCursor: result.next === null ? null : encodeKeysetCursor(result.next),
    };
  }

  @Get('customers/:id/referral')
  async customer(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<CustomerReferralResponse> {
    const { scope, actor } = await this.authenticate(request);
    const summary = await this.container.referralsRead.customer(scope, actor, id);
    return {
      customerId: summary.customerId,
      referredBy: summary.referredBy === null ? null : toReferralSummary(summary.referredBy),
      referredCount: summary.referredCount,
      totals: summary.totals.map((t) => ({
        currency: t.currency,
        pendingAmount: t.pending.toString(),
        earnedAmount: t.earned.toString(),
        reversedAmount: t.reversed.toString(),
      })),
    };
  }

  private async authenticate(
    request: FastifyRequest,
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request, this.isProduction);
    const { admin, session } = await this.container.auth.authenticate(token);
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    // A referral belongs to the TENANT: one program for every bot the tenant runs.
    return {
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }

  private get isProduction(): boolean {
    return this.container.config.NODE_ENV === 'production';
  }
}

function cursorFrom(raw: string): ReferralCursor {
  const position = decodeKeysetCursor(raw);
  return { createdAt: position.createdAt, id: position.id };
}

function toReferralSummary(item: ReferralListing): ReferralSummaryResponse {
  return {
    id: item.id,
    referrer: item.referrer,
    referee: item.referee,
    trigger: item.trigger,
    createdAt: item.createdAt.toISOString(),
  };
}

function toCommissionSummary(item: ReferralCommissionListing): ReferralCommissionSummaryResponse {
  return {
    id: item.id,
    referralId: item.referralId,
    orderId: item.orderId,
    referrer: item.referrer,
    referee: item.referee,
    percent: item.percent,
    basisAmount: item.basis.amountMinor.toString(),
    promisedAmount: item.amount.amountMinor.toString(),
    currency: item.amount.currency,
    state: item.state,
    earnedAmount: item.earnedAmount === null ? null : item.earnedAmount.toString(),
    reversedAmount: item.reversed.toString(),
    unrecoveredAmount: item.unrecovered.toString(),
    createdAt: item.createdAt.toISOString(),
    earnedAt: item.earnedAt === null ? null : item.earnedAt.toISOString(),
    voidedAt: item.voidedAt === null ? null : item.voidedAt.toISOString(),
  };
}
