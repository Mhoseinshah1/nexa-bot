import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  CONTROL_ERROR_CODES,
  RESELLER_MINIMUM_ROUTES,
  RESELLER_ROUTES,
  RESELLER_TIER_ROUTES,
  money,
  resellerGrantOverridesWriteSchema,
  resellerListQuerySchema,
  resellerMinimumQuerySchema,
  resellerMinimumWriteSchema,
  resellerTierMinimumWriteSchema,
  resellerPurchaseQuerySchema,
  resellerRegisterSchema,
  errors,
  resellerTierGrantsWriteSchema,
  resellerTierProductPricesQuerySchema,
  resellerTierProductPricesWriteSchema,
  resellerTierWriteSchema,
  resellerUpdateSchema,
  type CurrencyCode,
  type Money,
  type ResellerCreditResponse,
  type ResellerGrantKind,
  type ResellerHistoryEntry,
  type ResellerHistoryResponse,
  type ResellerListResponse,
  type ResellerMinimumReport,
  type ResellerPolicyResponse,
  type ResellerPurchasePage,
  type ResellerResponse,
  type ResellerSummaryResponse,
  type ResellerPricingMode,
  type ResellerTierListResponse,
  type ResellerTierProductPriceRow,
  type ResellerTierProductPricesPage,
  type ResellerTierProductPricesWriteResponse,
  type ResellerTierResponse,
  type ResellerTierSummaryResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { authenticateAdmin } from './authenticated-request.js';
import { singleValued } from './query.js';
import { decodeKeysetCursor, encodeKeysetCursor } from './keyset-cursor.js';
import type {
  ResellerListing,
  ResellerPurchaseRecord,
  ResellerTierListing,
  ResellerTierPriceCursor,
  ResellerTierPriceTableRow,
} from '../../modules/commerce/resellers/application/ports.js';
import type {
  ResellerCreditStandingRecord,
  ResellerPolicyRecord,
} from '../../modules/commerce/resellers/application/reseller-admin.service.js';
import type { ResellerMinimumReportRecord } from '../../modules/commerce/resellers/application/reseller-minimum.service.js';
import { effectiveLimitOf } from '../../modules/commerce/resellers/domain/reseller-credit.js';
import type { AuditHistoryRecord } from '../../modules/platform/audit/application/ports.js';

/**
 * Reseller tiers and resellers, over HTTP (`docs/wp9-reseller-audit.md` R11, R12).
 *
 * Authentication here; `resellers.view` and `resellers.edit` are charged by
 * `ResellerAdminService`, so nothing is protected by the Web Admin not drawing a button.
 * Every path is a literal, never a client URL builder called with `':id'`.
 */
@Controller(`${API_PREFIX}`)
export class ResellersController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(RESELLER_TIER_ROUTES.list)
  async tiers(@Req() request: FastifyRequest): Promise<ResellerTierListResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const tiers = await this.container.resellersAdmin.listTiers(scope, actor);
    return { tiers: tiers.map(toTierSummary) };
  }

  @Post(RESELLER_TIER_ROUTES.create)
  async createTier(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<ResellerTierResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const command = resellerTierWriteSchema.parse(body);
    const tier = await this.container.resellersAdmin.createTier(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      write: tierWriteFrom(command),
    });
    return { tier: toTierSummary(tier) };
  }

  @Get('reseller-tiers/:id')
  async tier(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<ResellerTierResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return { tier: toTierSummary(await this.container.resellersAdmin.getTier(scope, actor, id)) };
  }

  @Post('reseller-tiers/:id')
  async updateTier(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ResellerTierResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const command = resellerTierWriteSchema.parse(body);
    const tier = await this.container.resellersAdmin.updateTier(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      tierId: id,
      write: tierWriteFrom(command),
    });
    return { tier: toTierSummary(tier) };
  }

  @Post('reseller-tiers/:id/grants')
  async replaceGrants(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ResellerTierResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const command = resellerTierGrantsWriteSchema.parse(body);
    const tier = await this.container.resellersAdmin.replaceGrants(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      tierId: id,
      grants: command.grants.map((g) => ({ kind: g.kind, subject: g.subject })),
    });
    return { tier: toTierSummary(tier) };
  }

  /** Round 4 PR-G: one keyset page of the tier's price table. */
  @Get('reseller-tiers/:id/product-prices')
  async productPrices(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Query() raw: Record<string, unknown>,
  ): Promise<ResellerTierProductPricesPage> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const query = resellerTierProductPricesQuerySchema.parse(singleValued(raw));
    const page = await this.container.resellersAdmin.productPriceTable(scope, actor, id, {
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.categoryId === undefined ? {} : { categoryId: query.categoryId }),
      cursor: query.cursor === undefined ? null : decodePriceCursor(query.cursor),
    });
    return {
      tierId: page.tierId,
      items: page.items.map(toPriceRow),
      nextCursor: page.next === null ? null : encodePriceCursor(page.next),
    };
  }

  /** Round 4 PR-G: sets or clears the tier's price of each listed product. */
  @Post('reseller-tiers/:id/product-prices')
  async setProductPrices(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ResellerTierProductPricesWriteResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const command = resellerTierProductPricesWriteSchema.parse(body);
    return this.container.resellersAdmin.setProductPrices(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      tierId: id,
      prices: command.prices.map((p) => ({
        productId: p.productId,
        price: p.price === null ? null : money(BigInt(p.price.amount), p.price.currency),
      })),
    });
  }

  @Get(RESELLER_ROUTES.list)
  async list(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<ResellerListResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const query = singleValued(raw);
    const page = resellerListQuerySchema.parse({
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.tierId === undefined ? {} : { tierId: query.tierId }),
      ...(query.source === undefined ? {} : { source: query.source }),
      ...(query.search === undefined ? {} : { search: query.search }),
    });
    const result = await this.container.resellersAdmin.list(scope, actor, {
      ...(page.limit === undefined ? {} : { limit: page.limit }),
      ...(page.cursor === undefined
        ? {}
        : {
            cursor: (({ createdAt, id }) => ({ createdAt, id }))(decodeKeysetCursor(page.cursor)),
          }),
      ...(page.status === undefined ? {} : { status: page.status }),
      ...(page.tierId === undefined ? {} : { tierId: page.tierId }),
      ...(page.source === undefined ? {} : { source: page.source }),
      ...(page.search === undefined ? {} : { search: page.search }),
    });
    return {
      resellers: result.items.map(toResellerSummary),
      nextCursor: result.next === null ? null : encodeKeysetCursor(result.next),
    };
  }

  @Post(RESELLER_ROUTES.register)
  async register(@Req() request: FastifyRequest, @Body() body: unknown): Promise<ResellerResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const command = resellerRegisterSchema.parse(body);
    const reseller = await this.container.resellersAdmin.register(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      customerId: command.customerId,
      write: {
        tierId: command.tierId,
        pricingMode: command.pricingMode,
        discountPercentage: command.discountPercentage,
        creditLimit: creditLimitFrom(command.creditLimit),
      },
    });
    return { reseller: toResellerSummary(reseller) };
  }

  @Get('resellers/:customerId')
  async detail(
    @Req() request: FastifyRequest,
    @Param('customerId') customerId: string,
  ): Promise<ResellerResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return {
      reseller: toResellerSummary(
        await this.container.resellersAdmin.get(scope, actor, customerId),
      ),
    };
  }

  @Post('resellers/:customerId')
  async update(
    @Req() request: FastifyRequest,
    @Param('customerId') customerId: string,
    @Body() body: unknown,
  ): Promise<ResellerResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const command = resellerUpdateSchema.parse(body);
    const reseller = await this.container.resellersAdmin.update(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      customerId,
      write: {
        tierId: command.tierId,
        status: command.status,
        pricingMode: command.pricingMode,
        discountPercentage: command.discountPercentage,
        creditLimit: creditLimitFrom(command.creditLimit),
      },
    });
    return { reseller: toResellerSummary(reseller) };
  }

  @Get('reseller-tiers/:id/history')
  async tierHistory(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<ResellerHistoryResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const entries = await this.container.resellersAdmin.tierHistory(scope, actor, id);
    return { entries: entries.map(toHistoryEntry) };
  }

  @Get('resellers/:customerId/credit')
  async credit(
    @Req() request: FastifyRequest,
    @Param('customerId') customerId: string,
  ): Promise<ResellerCreditResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return {
      credit: toCreditStanding(
        await this.container.resellersAdmin.creditStanding(scope, actor, customerId),
      ),
    };
  }

  @Get('resellers/:customerId/purchases')
  async purchases(
    @Req() request: FastifyRequest,
    @Param('customerId') customerId: string,
    @Query() raw: Record<string, unknown>,
  ): Promise<ResellerPurchasePage> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const query = singleValued(raw);
    const page = resellerPurchaseQuerySchema.parse({
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    const result = await this.container.resellersAdmin.purchases(scope, actor, customerId, {
      ...(page.limit === undefined ? {} : { limit: page.limit }),
      ...(page.cursor === undefined
        ? {}
        : {
            cursor: (({ createdAt, id }) => ({ createdAt, id }))(decodeKeysetCursor(page.cursor)),
          }),
    });
    return {
      purchases: result.items.map(toPurchase),
      nextCursor: result.next === null ? null : encodeKeysetCursor(result.next),
    };
  }

  @Get('resellers/:customerId/history')
  async history(
    @Req() request: FastifyRequest,
    @Param('customerId') customerId: string,
  ): Promise<ResellerHistoryResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const entries = await this.container.resellersAdmin.history(scope, actor, customerId);
    return { entries: entries.map(toHistoryEntry) };
  }

  // -- Round N, package D: plan controls and the monthly minimum ------------------------

  @Post('reseller-tiers/:id/monthly-minimum')
  async setTierMinimum(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ResellerTierResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const command = resellerTierMinimumWriteSchema.parse(body);
    const tier = await this.container.resellersAdmin.setTierMinimum(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      tierId: id,
      minimum: creditLimitFrom(command.minimum),
    });
    return { tier: toTierSummary(tier) };
  }

  @Post('resellers/:customerId/monthly-minimum')
  async setMinimum(
    @Req() request: FastifyRequest,
    @Param('customerId') customerId: string,
    @Body() body: unknown,
  ): Promise<ResellerResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const command = resellerMinimumWriteSchema.parse(body);
    const reseller = await this.container.resellersAdmin.setMinimum(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      customerId,
      minimum: creditLimitFrom(command.minimum),
    });
    return { reseller: toResellerSummary(reseller) };
  }

  @Post('resellers/:customerId/grants')
  async replaceOverrides(
    @Req() request: FastifyRequest,
    @Param('customerId') customerId: string,
    @Body() body: unknown,
  ): Promise<ResellerPolicyResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const command = resellerGrantOverridesWriteSchema.parse(body);
    const policy = await this.container.resellersAdmin.replaceOverrides(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      customerId,
      overrides: command.overrides.map((o) => ({
        dimension: o.dimension,
        grants: o.grants.map((g) => ({ kind: g.kind, subject: g.subject })),
      })),
    });
    return { policy: toPolicy(policy) };
  }

  @Get('resellers/:customerId/policy')
  async policy(
    @Req() request: FastifyRequest,
    @Param('customerId') customerId: string,
  ): Promise<ResellerPolicyResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return {
      policy: toPolicy(await this.container.resellersAdmin.policy(scope, actor, customerId)),
    };
  }

  @Get(RESELLER_MINIMUM_ROUTES.progress)
  async minimums(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<ResellerMinimumReport> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const query = singleValued(raw);
    const parsed = resellerMinimumQuerySchema.parse({
      ...(query.period === undefined ? {} : { period: query.period }),
      ...(query.filter === undefined ? {} : { filter: query.filter }),
    });
    return toMinimumReport(
      await this.container.resellerMinimums.progress(scope, actor, {
        ...(parsed.period === undefined ? {} : { period: parsed.period }),
        ...(parsed.filter === undefined ? {} : { filter: parsed.filter }),
      }),
    );
  }
}

function creditLimitFrom(
  limit: { readonly amount: string; readonly currency: CurrencyCode } | null,
) {
  return limit === null ? null : money(BigInt(limit.amount), limit.currency);
}

function tierWriteFrom(command: {
  readonly name: string;
  readonly pricingMode: ResellerPricingMode;
  readonly discountPercentage: number | null;
  readonly creditLimit: { readonly amount: string; readonly currency: CurrencyCode };
  readonly unpricedListFallback: boolean;
}) {
  return {
    name: command.name,
    pricingMode: command.pricingMode,
    discountPercentage: command.discountPercentage,
    creditLimit: money(BigInt(command.creditLimit.amount), command.creditLimit.currency),
    unpricedListFallback: command.unpricedListFallback,
  };
}

/**
 * The tier price table's cursor (Round 4 PR-G): `(category id or '-', product id)`, unpadded
 * base64url. The house rule of `decodeKeysetCursor`: a cursor this server did not mint is a
 * 400, never a first page.
 */
const PRICE_CURSOR_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function encodePriceCursor(cursor: ResellerTierPriceCursor): string {
  return Buffer.from(`${cursor.categoryId ?? '-'}:${cursor.productId}`, 'utf8').toString(
    'base64url',
  );
}

function decodePriceCursor(raw: string): ResellerTierPriceCursor {
  const bad = () =>
    errors.validation(
      CONTROL_ERROR_CODES.INVALID_VALUE,
      'The `cursor` is not a cursor this server issued.',
      {
        cursor: raw.length > 64 ? `${raw.slice(0, 64)}…` : raw,
      },
    );
  const bytes = Buffer.from(raw, 'base64url');
  if (bytes.toString('base64url') !== raw) throw bad();
  const [category, product, ...rest] = bytes.toString('utf8').split(':');
  if (category === undefined || product === undefined || rest.length > 0) throw bad();
  if (category !== '-' && !PRICE_CURSOR_UUID.test(category)) throw bad();
  if (!PRICE_CURSOR_UUID.test(product)) throw bad();
  return { categoryId: category === '-' ? null : category, productId: product };
}

function wirePrice(value: Money | null) {
  return value === null ? null : { amount: value.amountMinor.toString(), currency: value.currency };
}

function toPriceRow(row: ResellerTierPriceTableRow): ResellerTierProductPriceRow {
  return {
    productId: row.productId,
    title: row.title,
    status: row.status,
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    listPrice: wirePrice(row.listPrice),
    tierPrice: wirePrice(row.tierPrice),
    tierPriceUpdatedAt:
      row.tierPriceUpdatedAt === null ? null : row.tierPriceUpdatedAt.toISOString(),
  };
}

function toTierSummary(tier: ResellerTierListing): ResellerTierSummaryResponse {
  return {
    id: tier.id,
    name: tier.name,
    pricingMode: tier.pricingMode,
    discountPercentage: tier.discountPercentage,
    creditLimit: {
      amount: tier.creditLimit.amountMinor.toString(),
      currency: tier.creditLimit.currency,
    },
    grants: tier.grants.map((g) => ({ kind: g.kind, subject: g.subject })),
    resellerCount: tier.resellerCount,
    monthlyMinimum: wireMoney(tier.monthlyMinimum),
    unpricedListFallback: tier.unpricedListFallback,
    createdAt: tier.createdAt.toISOString(),
    updatedAt: tier.updatedAt.toISOString(),
  };
}

function toResellerSummary(reseller: ResellerListing): ResellerSummaryResponse {
  const effective = effectiveLimitOf({
    status: reseller.status,
    ownLimit: reseller.creditLimit,
    tierLimit: reseller.tier.creditLimit,
  }).limit;
  return {
    customerId: reseller.customerId,
    source: reseller.source,
    telegramUserId: reseller.telegramUserId,
    displayName: reseller.displayName,
    tier: { id: reseller.tier.id, name: reseller.tier.name },
    status: reseller.status,
    pricingMode: reseller.pricingMode,
    discountPercentage: reseller.discountPercentage,
    creditLimit:
      reseller.creditLimit === null
        ? null
        : {
            amount: reseller.creditLimit.amountMinor.toString(),
            currency: reseller.creditLimit.currency,
          },
    effectiveCreditLimit: {
      amount: effective.amountMinor.toString(),
      currency: effective.currency,
    },
    createdAt: reseller.createdAt.toISOString(),
    updatedAt: reseller.updatedAt.toISOString(),
  };
}

function wireMoney(value: Money | null): { amount: string; currency: CurrencyCode } | null {
  return value === null ? null : { amount: value.amountMinor.toString(), currency: value.currency };
}

function toPolicy(policy: ResellerPolicyRecord): ResellerPolicyResponse['policy'] {
  const grants = (list: readonly { kind: ResellerGrantKind; subject: string | null }[]) =>
    list.map((g) => ({ kind: g.kind, subject: g.subject }));
  return {
    customerId: policy.customerId,
    status: policy.status,
    tier: policy.tier,
    dimensions: policy.dimensions.map((d) => ({
      dimension: d.dimension,
      source: d.source,
      tierGrants: grants(d.tierGrants),
      overrideGrants: d.overrideGrants === null ? null : grants(d.overrideGrants),
      effectiveGrants: grants(d.effectiveGrants),
    })),
    pricing: { ...policy.pricing },
    monthlyMinimum: {
      tier: wireMoney(policy.monthlyMinimum.tier),
      own: wireMoney(policy.monthlyMinimum.own),
      effective: wireMoney(policy.monthlyMinimum.effective),
      source: policy.monthlyMinimum.source,
    },
    botBasis: policy.botBasis,
    products:
      policy.products === null
        ? null
        : policy.products.map((p) => ({
            productId: p.productId,
            title: p.title,
            status: p.status,
            categoryId: p.categoryId,
            panelId: p.panelId,
            allowed: p.decision.allowed,
            refusedDimension: p.decision.allowed ? null : p.decision.dimension,
          })),
    productsComplete: policy.productsComplete,
  };
}

function toMinimumReport(report: ResellerMinimumReportRecord): ResellerMinimumReport {
  return {
    period: {
      key: report.period.key,
      start: report.period.start.toISOString(),
      end: report.period.end.toISOString(),
      startLocal: report.period.startLocal,
      endLocalInclusive: report.period.endLocalInclusive,
      timezone: report.period.timezone,
      calendar: report.period.calendar as ResellerMinimumReport['period']['calendar'],
      running: report.period.running,
    },
    rows: report.rows.map((row) => ({
      customerId: row.customerId,
      telegramUserId: row.telegramUserId,
      displayName: row.displayName,
      tier: row.tier,
      status: row.status,
      minimum: wireMoney(row.minimum),
      source: row.source,
      achieved: { amount: row.achieved.amountMinor.toString(), currency: row.achieved.currency },
      remaining: wireMoney(row.remaining),
      progressBasisPoints: row.progressBasisPoints,
      state: row.state,
    })),
    counts: report.counts,
    truncated: report.truncated,
  };
}

function toCreditStanding(standing: ResellerCreditStandingRecord) {
  const inSelling = (amount: bigint) => ({
    amount: amount.toString(),
    currency: standing.sellingCurrency,
  });
  return {
    customerId: standing.customerId,
    status: standing.status,
    effectiveLimit: {
      amount: standing.effectiveLimit.amountMinor.toString(),
      currency: standing.effectiveLimit.currency,
    },
    limitSource: standing.limitSource,
    sellingCurrency: standing.sellingCurrency,
    credit: standing.credit,
    balance: inSelling(standing.balance),
    allowance: inSelling(standing.allowance),
    creditInUse: inSelling(standing.creditInUse),
    availableToSpend: inSelling(standing.availableToSpend),
    overLimitBy: inSelling(standing.overLimitBy),
  };
}

function toPurchase(purchase: ResellerPurchaseRecord) {
  return {
    orderId: purchase.orderId,
    orderState: purchase.orderState,
    purpose: purchase.purpose,
    confirmedAt: purchase.createdAt.toISOString(),
    tierName: purchase.tierName,
    layer: purchase.layer,
    percent: purchase.percent,
    listAmount: purchase.listAmount.toString(),
    costAmount: purchase.costAmount.toString(),
    promotionAmount: purchase.promotionAmount.toString(),
    saleAmount: purchase.saleAmount.toString(),
    currency: purchase.currency,
  };
}

function toHistoryEntry(entry: AuditHistoryRecord): ResellerHistoryEntry {
  return {
    id: entry.id,
    action: entry.action,
    actorType: entry.actorType,
    actorLabel: entry.actorLabel,
    surface: entry.surface,
    result: entry.result,
    occurredAt: entry.occurredAt.toISOString(),
    before: entry.before === null ? null : { ...entry.before },
    after: entry.after === null ? null : { ...entry.after },
  };
}
