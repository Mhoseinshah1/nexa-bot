import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  RESELLER_ROUTES,
  RESELLER_TIER_ROUTES,
  money,
  resellerListQuerySchema,
  resellerRegisterSchema,
  resellerTierGrantsWriteSchema,
  resellerTierWriteSchema,
  resellerUpdateSchema,
  type CurrencyCode,
  type ResellerListResponse,
  type ResellerResponse,
  type ResellerSummaryResponse,
  type ResellerTierListResponse,
  type ResellerTierResponse,
  type ResellerTierSummaryResponse,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, requireSessionToken } from './authenticated-request.js';
import { singleValued } from './query.js';
import { decodeKeysetCursor, encodeKeysetCursor } from './keyset-cursor.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type {
  ResellerListing,
  ResellerTierListing,
} from '../../modules/commerce/resellers/application/ports.js';

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
    const { scope, actor } = await this.authenticate(request);
    const tiers = await this.container.resellersAdmin.listTiers(scope, actor);
    return { tiers: tiers.map(toTierSummary) };
  }

  @Post(RESELLER_TIER_ROUTES.create)
  async createTier(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<ResellerTierResponse> {
    const { scope, actor } = await this.authenticate(request);
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
    const { scope, actor } = await this.authenticate(request);
    return { tier: toTierSummary(await this.container.resellersAdmin.getTier(scope, actor, id)) };
  }

  @Post('reseller-tiers/:id')
  async updateTier(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ResellerTierResponse> {
    const { scope, actor } = await this.authenticate(request);
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
    const { scope, actor } = await this.authenticate(request);
    const command = resellerTierGrantsWriteSchema.parse(body);
    const tier = await this.container.resellersAdmin.replaceGrants(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      tierId: id,
      grants: command.grants.map((g) => ({ kind: g.kind, subject: g.subject })),
    });
    return { tier: toTierSummary(tier) };
  }

  @Get(RESELLER_ROUTES.list)
  async list(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<ResellerListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const query = singleValued(raw);
    const page = resellerListQuerySchema.parse({
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.tierId === undefined ? {} : { tierId: query.tierId }),
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
      ...(page.search === undefined ? {} : { search: page.search }),
    });
    return {
      resellers: result.items.map(toResellerSummary),
      nextCursor: result.next === null ? null : encodeKeysetCursor(result.next),
    };
  }

  @Post(RESELLER_ROUTES.register)
  async register(@Req() request: FastifyRequest, @Body() body: unknown): Promise<ResellerResponse> {
    const { scope, actor } = await this.authenticate(request);
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
    const { scope, actor } = await this.authenticate(request);
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
    const { scope, actor } = await this.authenticate(request);
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

  private async authenticate(
    request: FastifyRequest,
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request, this.isProduction);
    const { admin, session } = await this.container.auth.authenticate(token);
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    // A reseller belongs to the TENANT, whichever bot they buy through.
    return {
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }

  private get isProduction(): boolean {
    return this.container.config.NODE_ENV === 'production';
  }
}

function creditLimitFrom(
  limit: { readonly amount: string; readonly currency: CurrencyCode } | null,
) {
  return limit === null ? null : money(BigInt(limit.amount), limit.currency);
}

function tierWriteFrom(command: {
  readonly name: string;
  readonly pricingMode: 'LIST_PRICE' | 'PERCENTAGE_DISCOUNT';
  readonly discountPercentage: number | null;
  readonly creditLimit: { readonly amount: string; readonly currency: CurrencyCode };
}) {
  return {
    name: command.name,
    pricingMode: command.pricingMode,
    discountPercentage: command.discountPercentage,
    creditLimit: money(BigInt(command.creditLimit.amount), command.creditLimit.currency),
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
    createdAt: tier.createdAt.toISOString(),
    updatedAt: tier.updatedAt.toISOString(),
  };
}

function toResellerSummary(reseller: ResellerListing): ResellerSummaryResponse {
  const effective = reseller.creditLimit ?? reseller.tier.creditLimit;
  return {
    customerId: reseller.customerId,
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
