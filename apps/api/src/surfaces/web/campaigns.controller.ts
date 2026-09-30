import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  CAMPAIGN_ROUTES,
  campaignCommandRequestSchema,
  campaignCreateRequestSchema,
  campaignListQuerySchema,
  campaignScheduleRequestSchema,
  campaignUpdateRequestSchema,
  type CampaignActionView,
  type CampaignActions,
  type CampaignListResponse,
  type CampaignPreviewResponse,
  type CampaignResponse,
  type CampaignResultsResponse,
  type CampaignSummary,
  type CampaignTally,
  type CurrencyCode,
  type MoneyWire,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { singleValued } from './query.js';
import { decodeKeysetCursor, encodeKeysetCursor } from './keyset-cursor.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type {
  CampaignDetail,
  CampaignDraftInput,
} from '../../modules/commerce/campaigns/application/campaign.service.js';
import type {
  CampaignActionConfig,
  CampaignActionRecord,
  CampaignRecord,
  StateTally,
} from '../../modules/commerce/campaigns/application/ports.js';

/**
 * Campaigns over HTTP (round N, C1, `docs/round-n-campaigns-audit.md`).
 *
 * Authentication and the origin check here; every permission — `campaigns.view`,
 * `campaigns.manage` and each composed action's own key — is charged by `CampaignService`,
 * so nothing is protected by the Web Admin not drawing a button.
 */
@Controller(`${API_PREFIX}`)
export class CampaignsController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(CAMPAIGN_ROUTES.list)
  async list(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<CampaignListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const query = campaignListQuerySchema.parse(singleValued(raw));
    const page = await this.container.campaigns.list(scope, actor, {
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.state === undefined ? {} : { state: query.state }),
      ...(query.cursor === undefined ? {} : { cursor: decodeKeysetCursor(query.cursor) }),
    });
    return {
      campaigns: page.items.map((item) =>
        summaryOf(item.campaign, item.actionKinds, item.startLocal, item.endLocal),
      ),
      nextCursor: page.nextCursor === null ? null : encodeKeysetCursor(page.nextCursor),
      presentation: page.presentation,
    };
  }

  @Post(CAMPAIGN_ROUTES.create)
  async create(@Req() request: FastifyRequest, @Body() body: unknown): Promise<CampaignResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = campaignCreateRequestSchema.parse(body);
    const detail = await this.container.campaigns.createDraft(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      draft: draftOf(command),
    });
    return this.responseOf(detail);
  }

  @Get('campaigns/:id')
  async one(@Req() request: FastifyRequest, @Param('id') id: string): Promise<CampaignResponse> {
    const { scope, actor } = await this.authenticate(request);
    return this.responseOf(await this.container.campaigns.get(scope, actor, id));
  }

  @Post('campaigns/:id/draft')
  async update(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CampaignResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = campaignUpdateRequestSchema.parse(body);
    const detail = await this.container.campaigns.updateDraft(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      campaignId: id,
      draft: draftOf(command),
    });
    return this.responseOf(detail);
  }

  /** A read (writes nothing), so a GET: the figures the confirmation then binds to. */
  @Get('campaigns/:id/preview')
  async preview(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<CampaignPreviewResponse> {
    const { scope, actor } = await this.authenticate(request);
    const preview = await this.container.campaigns.preview(scope, actor, id);
    const gift = (kind: 'WALLET_GIFT' | 'TRAFFIC_GIFT' | 'TIME_GIFT') => {
      const found = preview.gifts[kind];
      return found === undefined
        ? null
        : {
            count: found.count,
            customers: found.customers,
            fingerprint: found.fingerprint,
            totalLiability: found.totalLiability,
          };
    };
    return {
      audience: preview.audience,
      discountMaxLiability:
        preview.discountMaxLiability === null
          ? null
          : moneyOf(
              preview.discountMaxLiability.amountMinor,
              preview.discountMaxLiability.currency,
            ),
      walletGift: gift('WALLET_GIFT'),
      trafficGift: gift('TRAFFIC_GIFT'),
      timeGift: gift('TIME_GIFT'),
      typedCountRequired: preview.typedCountRequired,
    };
  }

  @Post('campaigns/:id/schedule')
  async schedule(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CampaignResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = campaignScheduleRequestSchema.parse(body);
    const detail = await this.container.campaigns.schedule(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      campaignId: id,
      expectedDefinitionHash: command.expectedDefinitionHash,
      expectedRecipients: command.expectedRecipients,
      expectedFingerprint: command.expectedFingerprint,
      typedCount: command.typedCount,
      walletGift: command.walletGift,
      trafficGift: command.trafficGift,
      timeGift: command.timeGift,
    });
    return this.responseOf(detail);
  }

  @Post('campaigns/:id/launch')
  async launch(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CampaignResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    campaignCommandRequestSchema.parse(body);
    return this.responseOf(await this.container.campaigns.launchPending(scope, actor, id));
  }

  @Post('campaigns/:id/pause')
  async pause(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CampaignResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = campaignCommandRequestSchema.parse(body);
    return this.responseOf(
      await this.container.campaigns.pause(scope, actor, {
        idempotencyKey: command.idempotencyKey,
        campaignId: id,
      }),
    );
  }

  @Post('campaigns/:id/resume')
  async resume(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CampaignResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = campaignCommandRequestSchema.parse(body);
    return this.responseOf(
      await this.container.campaigns.resume(scope, actor, {
        idempotencyKey: command.idempotencyKey,
        campaignId: id,
      }),
    );
  }

  @Post('campaigns/:id/cancel')
  async cancel(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CampaignResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = campaignCommandRequestSchema.parse(body);
    return this.responseOf(
      await this.container.campaigns.cancel(scope, actor, {
        idempotencyKey: command.idempotencyKey,
        campaignId: id,
      }),
    );
  }

  @Get('campaigns/:id/results')
  async results(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<CampaignResultsResponse> {
    const { scope, actor } = await this.authenticate(request);
    const results = await this.container.campaigns.results(scope, actor, id);
    return {
      targeted: results.targeted,
      discountRedemptions:
        results.discount === null ? null : results.discount.byOrderState.map(tallyOf),
      cashback:
        results.cashback === null
          ? null
          : {
              byState: results.cashback.byState.map(tallyOf),
              totals: results.cashback.totals.map((total) => ({
                currency: total.currency,
                earned: moneyOf(total.earned, total.currency),
                reversedRecovered: moneyOf(total.reversedRecovered, total.currency),
                reversedUnrecovered: moneyOf(total.reversedUnrecovered, total.currency),
              })),
            },
      announcement: results.announcement,
      walletGift:
        results.walletGift === null
          ? null
          : {
              counts: results.walletGift.counts,
              creditedTotal:
                results.walletGift.credited === null
                  ? null
                  : moneyOf(
                      results.walletGift.credited.amountMinor,
                      results.walletGift.credited.currency,
                    ),
            },
      trafficGift: results.trafficGift === null ? null : { counts: results.trafficGift.counts },
      timeGift: results.timeGift === null ? null : { counts: results.timeGift.counts },
    };
  }

  private responseOf(detail: CampaignDetail): CampaignResponse {
    const summary = summaryOf(
      detail.campaign,
      detail.actions.map((a) => a.kind),
      detail.startLocal,
      detail.endLocal,
    );
    return {
      campaign: {
        ...summary,
        audience: detail.campaign.audience,
        audienceHash: detail.campaign.audienceHash,
        audienceFingerprint: detail.campaign.audienceFingerprint,
        actions: detail.actions.map((action) => actionViewOf(action, detail)),
      },
      presentation: detail.presentation,
    };
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
    // A campaign belongs to the TENANT, like the rules and the audience it composes.
    return {
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }

  private get isProduction(): boolean {
    return this.container.config.NODE_ENV === 'production';
  }
}

function summaryOf(
  campaign: CampaignRecord,
  kinds: readonly CampaignActionRecord['kind'][],
  startLocal: { readonly date: string; readonly time: string },
  endLocal: { readonly date: string; readonly time: string },
): CampaignSummary {
  const iso = (at: Date | null) => (at === null ? null : at.toISOString());
  return {
    id: campaign.id,
    name: campaign.name,
    description: campaign.description,
    state: campaign.state,
    startsAt: campaign.startsAt.toISOString(),
    endsAt: campaign.endsAt.toISOString(),
    startLocal: { ...startLocal },
    endLocal: { ...endLocal },
    audienceConfirmedCount: campaign.audienceConfirmedCount,
    actionKinds: [...kinds],
    scheduledAt: iso(campaign.scheduledAt),
    startedAt: iso(campaign.startedAt),
    pausedAt: iso(campaign.pausedAt),
    completedAt: iso(campaign.completedAt),
    cancelledAt: iso(campaign.cancelledAt),
    createdAt: campaign.createdAt.toISOString(),
    updatedAt: campaign.updatedAt.toISOString(),
  };
}

/**
 * One action as the page shows it. A discount or cashback action that has made its rule is
 * shown from the LIVE rule — its terms and its status now — because the rule is the
 * campaign's discount and may have been edited on the discounts page. Everything else is
 * shown as confirmed.
 */
function actionViewOf(action: CampaignActionRecord, detail: CampaignDetail): CampaignActionView {
  const liveDiscount =
    action.kind === 'DISCOUNT' &&
    detail.discount !== null &&
    detail.discount.id === action.discountId
      ? detail.discount
      : null;
  const liveCashback =
    action.kind === 'CASHBACK' &&
    detail.cashbackRule !== null &&
    detail.cashbackRule.id === action.cashbackRuleId
      ? detail.cashbackRule
      : null;
  return {
    kind: action.kind,
    state: action.state,
    terms:
      liveDiscount !== null
        ? discountTermsWire(liveDiscount)
        : liveCashback !== null
          ? {
              percent: liveCashback.percent,
              appliesTo: [...liveCashback.appliesTo],
              productId: liveCashback.productId,
              categoryId: liveCashback.categoryId,
            }
          : termsWire(action.config),
    ruleStatus: liveDiscount?.status ?? liveCashback?.status ?? null,
    discountId: action.discountId,
    cashbackRuleId: action.cashbackRuleId,
    broadcastId: action.broadcastId,
    bulkOperationId: action.bulkOperationId,
    failureCode: action.failureCode,
    launchedAt: action.launchedAt === null ? null : action.launchedAt.toISOString(),
  };
}

function discountTermsWire(rule: {
  kind: string;
  code: string | null;
  type: string;
  value: bigint;
  currency: string | null;
  appliesTo: readonly string[];
  productId: string | null;
  categoryId: string | null;
  firstPurchaseOnly: boolean;
  minimumSubtotal: bigint | null;
  totalLimit: number | null;
  perCustomerLimit: number | null;
  priority: number;
  stackable: boolean;
}): Record<string, unknown> {
  return {
    kind: rule.kind,
    code: rule.code,
    type: rule.type,
    value: rule.value.toString(),
    currency: rule.currency,
    appliesTo: [...rule.appliesTo],
    productId: rule.productId,
    categoryId: rule.categoryId,
    firstPurchaseOnly: rule.firstPurchaseOnly,
    minimumSubtotalAmount: rule.minimumSubtotal?.toString() ?? null,
    totalRedemptionsLimit: rule.totalLimit,
    perCustomerLimit: rule.perCustomerLimit,
    priority: rule.priority,
    stackable: rule.stackable,
  };
}

/** An action's terms as the wire spells them: minor units as text, like the request. */
function termsWire(config: CampaignActionConfig): unknown {
  if (config.kind === 'DISCOUNT') {
    const t = config.terms;
    return discountTermsWire({ ...t, stackable: t.stackable });
  }
  return config.terms;
}

/** The request's actions object as the service's list of action configurations. */
function actionsOf(actions: CampaignActions): CampaignActionConfig[] {
  const out: CampaignActionConfig[] = [];
  if (actions.discount !== null) {
    const d = actions.discount;
    out.push({
      kind: 'DISCOUNT',
      terms: {
        kind: d.kind,
        code: d.code,
        type: d.type,
        value: BigInt(d.value),
        currency: d.currency,
        appliesTo: d.appliesTo,
        productId: d.productId,
        categoryId: d.categoryId,
        firstPurchaseOnly: d.firstPurchaseOnly,
        minimumSubtotal: d.minimumSubtotalAmount === null ? null : BigInt(d.minimumSubtotalAmount),
        totalLimit: d.totalRedemptionsLimit,
        perCustomerLimit: d.perCustomerLimit,
        priority: d.priority,
        stackable: d.stackable,
      },
    });
  }
  if (actions.cashback !== null) out.push({ kind: 'CASHBACK', terms: actions.cashback });
  if (actions.walletGift !== null) out.push({ kind: 'WALLET_GIFT', terms: actions.walletGift });
  if (actions.trafficGift !== null) out.push({ kind: 'TRAFFIC_GIFT', terms: actions.trafficGift });
  if (actions.timeGift !== null) out.push({ kind: 'TIME_GIFT', terms: actions.timeGift });
  if (actions.announcement !== null) {
    out.push({ kind: 'ANNOUNCEMENT', terms: actions.announcement });
  }
  return out;
}

function draftOf(command: {
  name: string;
  description: string;
  start: { date: string; time: string };
  end: { date: string; time: string };
  audience: unknown;
  actions: CampaignActions;
}): CampaignDraftInput {
  return {
    name: command.name,
    description: command.description,
    startDate: command.start.date,
    startTime: command.start.time,
    endDate: command.end.date,
    endTime: command.end.time,
    audience: command.audience,
    actions: actionsOf(command.actions),
  };
}

function moneyOf(amountMinor: bigint, currency: CurrencyCode): MoneyWire {
  return { amountMinor: amountMinor.toString(), currency };
}

function moneyOrNull(amountMinor: bigint, currency: CurrencyCode | null): MoneyWire | null {
  return currency === null ? null : moneyOf(amountMinor, currency);
}

function tallyOf(tally: StateTally): CampaignTally {
  return {
    state: tally.state,
    count: tally.count,
    amount: moneyOrNull(tally.amount, tally.currency),
  };
}
