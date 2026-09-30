import { Controller, Get, Inject, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  FX_ROUTES,
  FX_QUOTE_SIDE,
  fractionToDecimalText,
  rateToDecimalText,
  type FxRefreshResponse,
  type FxStatusResponse,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, requireSessionToken } from './authenticated-request.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type { FxStatus } from '../../modules/commerce/fx/application/fx.service.js';

/** The one asset this release quotes; the section is about it. */
const BASE_ASSET = 'USDT' as const;

/**
 * The central exchange rate over HTTP, at `/fx` (package FX): the FX section of the
 * payment settings reads `status`, and its button posts `refresh`.
 *
 * Nothing here decides anything: the service reads the settings and the stored quote,
 * dials the sources on a refresh, and charges `payments.gateways.view` and
 * `payments.gateways.edit` itself. Every figure goes out as a decimal STRING — JSON has
 * no bigint, and a rate is money arithmetic's input.
 */
@Controller(`${API_PREFIX}`)
export class FxController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(FX_ROUTES.status)
  async status(@Req() request: FastifyRequest): Promise<FxStatusResponse> {
    const { scope, actor } = await this.authenticate(request);
    return toView(await this.container.fx.status(scope, actor, BASE_ASSET));
  }

  @Post(FX_ROUTES.refresh)
  async refresh(@Req() request: FastifyRequest): Promise<FxRefreshResponse> {
    const { scope, actor } = await this.authenticate(request);
    const { outcome, reason, status } = await this.container.fx.refresh(scope, actor, BASE_ASSET);
    return {
      outcome: outcome === 'NOT_DUE' ? 'REFRESHED' : outcome,
      reason,
      status: toView(status),
    };
  }

  private async authenticate(
    request: FastifyRequest,
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request, this.isProduction);
    const { admin, session } = await this.container.auth.authenticate(token);
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    return {
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }

  private get isProduction(): boolean {
    return this.container.config.NODE_ENV === 'production';
  }
}

function toView(status: FxStatus): FxStatusResponse {
  const iso = (value: Date | null) => (value === null ? null : value.toISOString());
  const stars = status.routes.find((route) => route.provider === 'TELEGRAM_STARS');
  return {
    enabled: status.settings.enabled,
    baseAsset: status.pair.baseAsset,
    quoteCurrency: status.pair.quoteCurrency,
    side: FX_QUOTE_SIDE,
    primarySource: status.settings.primary,
    fallbackSource: status.settings.fallback,
    freshTtlSeconds: status.settings.freshTtlSeconds,
    maxStaleSeconds: status.settings.maxStaleSeconds,
    state: status.state,
    quote:
      status.quote === null
        ? null
        : {
            quoteId: status.quote.quoteId,
            source: status.quote.source,
            rate: rateToDecimalText(status.quote.rate),
            rateMantissa: status.quote.rate.mantissa.toString(),
            rateScale: status.quote.rate.scale,
            sourceAt: iso(status.quote.sourceAt),
            fetchedAt: status.quote.fetchedAt.toISOString(),
            ageSeconds: status.quote.ageSeconds,
            policyVersion: status.quote.policyVersion,
          },
    lastAttemptAt: iso(status.row?.lastAttemptAt ?? null),
    lastErrorCode: status.row?.lastErrorCode ?? null,
    sources: status.sources.map((source) => ({
      source: source.source,
      lastSuccessAt: iso(source.lastSuccessAt),
      lastFailureAt: iso(source.lastFailureAt),
      lastFailureCode: source.lastFailureCode,
      retryAfter: iso(source.retryAfter),
      consecutiveFailures: source.consecutiveFailures,
    })),
    stars: {
      pricingMode: stars?.mode === 'CENTRAL_FX' ? 'CENTRAL_FX_RATIO' : 'FIXED_RATE',
      starsPerUsdt: stars?.unitRatioText ?? '',
      fixedRateMinor: stars?.fixedRateMinor?.toString() ?? null,
      centralRatePerStar:
        stars?.centralRatePerUnit === null || stars?.centralRatePerUnit === undefined
          ? null
          : fractionToDecimalText(
              stars.centralRatePerUnit.numerator,
              stars.centralRatePerUnit.denominator,
            ),
    },
    policyVersion: status.quote?.policyVersion ?? status.policyVersion,
  };
}
