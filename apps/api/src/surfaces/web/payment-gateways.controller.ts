import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  GATEWAY_HEALTH_ROUTES,
  PAYMENT_GATEWAY_DESCRIPTORS,
  gatewayHealthQuerySchema,
  type GatewayHealthResponse,
  checkPaymentGatewayCredentialRequestSchema,
  setPaymentGatewayVerifyKeyRequestSchema,
  setPaymentGatewayWebhookSecretRequestSchema,
  providerUnitRateMinorSchema,
  PAYMENT_GATEWAY_ROUTES,
  paymentGatewayConfigSchema,
  routePattern,
  setPaymentGatewayCredentialRequestSchema,
  setPaymentGatewayStatusRequestSchema,
  updatePaymentGatewayRequestSchema,
  type PaymentGatewayListResponse,
  type PaymentGatewayResponse,
  type PaymentGatewayView,
  type SalesCurrencyCode,
  type TenantContext,
  takesFixedRate,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, requireSessionToken } from './authenticated-request.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type { PaymentGatewayRecord } from '../../modules/commerce/payments/application/gateway-ports.js';
import type { GatewayOperatorFacts } from '../../modules/commerce/payments/application/payment-gateway.service.js';
import type { GatewayHealthEntry } from '../../modules/commerce/payments/application/gateway-health.service.js';
import { singleValued } from './query.js';

/**
 * Payment routes over HTTP, at `/payment-gateways`.
 *
 * One read and two writes, and the two are separate for the reason the accounts
 * controller states: switching a route off and changing its limits are different
 * operator decisions with different audit rows, and a single PATCH taking every field
 * would make "who stopped accepting card-to-card, and when" answerable only by diffing
 * two payloads.
 *
 * There is no CREATE and no DELETE, and neither is an omission. A route is
 * `(tenant, provider)` where the provider comes from a closed catalogue of what this
 * release can operate, so the roster is fixed by construction — which is the shape
 * `WEB-BR-012` reads off the legacy panel, a fixed eleven with no Add Gateway. Creating
 * a tenant's routes is provisioning's, and a route is DISABLED rather than removed
 * because history names it.
 *
 * Nothing here returns a credential, and nothing can. A route that holds one (TonPays,
 * WP11A) follows the panels rule: the projection selects a set-at timestamp and never a
 * ciphertext, and never a masked stand-in either, because `********` can be resubmitted
 * as a password. The key arrives through its own write-only route and is never echoed.
 *
 * Authentication happens here; AUTHORIZATION does not — `PaymentGatewayService` charges
 * `payments.gateways.view` and `payments.gateways.edit` itself.
 */
@Controller(`${API_PREFIX}`)
export class PaymentGatewaysController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(PAYMENT_GATEWAY_ROUTES.list)
  async list(@Req() request: FastifyRequest): Promise<PaymentGatewayListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const { gateways, currency, facts } = await this.container.paymentGateways.list(scope, actor);
    return {
      gateways: gateways.map((gateway) =>
        toView(gateway, currency, facts.get(gateway.provider) ?? NO_FACTS),
      ),
    };
  }

  /**
   * Gateway Health (program §11): every route's recorded health. Read-only, under
   * `payments.gateways.view` (charged by the service); the queue counts and the last
   * reconciliation need `payments.view` and are named withheld otherwise. Never a value of a
   * credential, a secret or a key — only whether one is set.
   */
  @Get(GATEWAY_HEALTH_ROUTES.list)
  async health(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<GatewayHealthResponse> {
    const { scope, actor } = await this.authenticate(request);
    const query = singleValued(raw);
    const input = gatewayHealthQuerySchema.parse({
      ...(query.range === undefined ? {} : { range: query.range }),
      ...(query.from === undefined ? {} : { from: query.from }),
      ...(query.to === undefined ? {} : { to: query.to }),
    });
    const report = await this.container.gatewayHealth.report(scope, actor, input);
    return {
      window:
        report.window === null
          ? null
          : { start: report.window.start.toISOString(), end: report.window.end.toISOString() },
      gateways: report.gateways.map(toHealthView),
      withheld: [...report.withheld],
      generatedAt: this.container.clock.now().toISOString(),
    };
  }

  @Post(routePattern(PAYMENT_GATEWAY_ROUTES.update, 'provider'))
  async update(
    @Req() request: FastifyRequest,
    @Param('provider') provider: string,
    @Body() body: unknown,
  ): Promise<PaymentGatewayResponse> {
    const { scope, actor } = await this.authenticate(request);
    const input = updatePaymentGatewayRequestSchema.parse(body);
    /*
     * TWO parses, and the second is the one that matters.
     *
     * The wire schema checks shapes — a decimal string, an integer in range — and
     * `paymentGatewayConfigSchema` checks the RULES: a maximum below the minimum, and
     * payment-count bounds that cross. Both of those produce a route that is configured,
     * switched on and impossible to pay through, and the config schema is where this
     * product refuses them. Running it here rather than trusting the wire parse is what
     * makes a future surface inherit the rules instead of reimplementing them.
     */
    const config = paymentGatewayConfigSchema.parse({
      displayName: input.displayName,
      instructions: input.instructions,
      minAmountMinor: BigInt(input.minAmountMinor),
      maxAmountMinor: BigInt(input.maxAmountMinor),
      eligibility: input.eligibility,
      sortOrder: input.sortOrder,
      topupCashbackPercent: input.topupCashbackPercent,
      customerFeeBasisPoints: input.customerFeeBasisPoints,
      allowServicePurchase: input.allowServicePurchase,
      allowWalletTopup: input.allowWalletTopup,
    });
    const gateway = await this.container.paymentGateways.configure(scope, actor, {
      idempotencyKey: input.idempotencyKey,
      provider,
      /*
       * The switches as the WIRE carried them, not as the config schema defaulted them:
       * the previous release's client sends neither, and the service keeps the row's
       * own values for a switch the request did not mention. The schema's default is
       * for a config built in code, where an unmentioned switch means ON.
       */
      config: {
        ...config,
        allowServicePurchase: input.allowServicePurchase,
        allowWalletTopup: input.allowWalletTopup,
        /*
         * The conversion rate (Package A) as the WIRE carried it: absent keeps the row's,
         * null clears it, a decimal string sets it. Bounded by the contract's schema.
         */
        ...(input.providerUnitRateMinor === undefined
          ? {}
          : {
              providerUnitRateMinor:
                input.providerUnitRateMinor === null
                  ? null
                  : providerUnitRateMinorSchema.parse(BigInt(input.providerUnitRateMinor)),
            }),
      },
    });
    return this.respond(scope, gateway);
  }

  @Post(routePattern(PAYMENT_GATEWAY_ROUTES.status, 'provider'))
  async setStatus(
    @Req() request: FastifyRequest,
    @Param('provider') provider: string,
    @Body() body: unknown,
  ): Promise<PaymentGatewayResponse> {
    const { scope, actor } = await this.authenticate(request);
    const input = setPaymentGatewayStatusRequestSchema.parse(body);
    const gateway = await this.container.paymentGateways.setStatus(scope, actor, {
      idempotencyKey: input.idempotencyKey,
      provider,
      status: input.status,
    });
    return this.respond(scope, gateway);
  }

  /**
   * Replaces a route's API key (WP11A). Write-only: the answer is the route's view, which
   * carries the key's set-at time and never the key. The body is parsed here and handed
   * on without being logged; the error filter never quotes a request body.
   */
  @Post(routePattern(PAYMENT_GATEWAY_ROUTES.credential, 'provider'))
  async setCredential(
    @Req() request: FastifyRequest,
    @Param('provider') provider: string,
    @Body() body: unknown,
  ): Promise<PaymentGatewayResponse> {
    const { scope, actor } = await this.authenticate(request);
    const input = setPaymentGatewayCredentialRequestSchema.parse(body);
    const gateway = await this.container.paymentGateways.setCredential(scope, actor, {
      idempotencyKey: input.idempotencyKey,
      provider,
      apiKey: input.apiKey,
    });
    return this.respond(scope, gateway);
  }

  /**
   * Replaces a signed route's webhook secret (NOWPayments' IPN secret). Write-only, the key's
   * rules: the answer is the route view with the secret's set-at time, never the secret.
   */
  @Post(routePattern(PAYMENT_GATEWAY_ROUTES.webhookSecret, 'provider'))
  async setWebhookSecret(
    @Req() request: FastifyRequest,
    @Param('provider') provider: string,
    @Body() body: unknown,
  ): Promise<PaymentGatewayResponse> {
    const { scope, actor } = await this.authenticate(request);
    const input = setPaymentGatewayWebhookSecretRequestSchema.parse(body);
    const gateway = await this.container.paymentGateways.setWebhookSecret(scope, actor, {
      idempotencyKey: input.idempotencyKey,
      provider,
      secret: input.secret,
    });
    return this.respond(scope, gateway);
  }

  /**
   * Replaces a route's separate verify key (CentralPay). Write-only, the key's rules: the
   * answer is the route view with the verify key's set-at time, never the key.
   */
  @Post(routePattern(PAYMENT_GATEWAY_ROUTES.verifyKey, 'provider'))
  async setVerifyKey(
    @Req() request: FastifyRequest,
    @Param('provider') provider: string,
    @Body() body: unknown,
  ): Promise<PaymentGatewayResponse> {
    const { scope, actor } = await this.authenticate(request);
    const input = setPaymentGatewayVerifyKeyRequestSchema.parse(body);
    const gateway = await this.container.paymentGateways.setVerifyKey(scope, actor, {
      idempotencyKey: input.idempotencyKey,
      provider,
      verifyKey: input.verifyKey,
    });
    return this.respond(scope, gateway);
  }

  /**
   * The operator's credential check: one read-only provider call with the stored key,
   * recorded as the route's last check. The answer is the route view.
   */
  @Post(routePattern(PAYMENT_GATEWAY_ROUTES.check, 'provider'))
  async checkCredential(
    @Req() request: FastifyRequest,
    @Param('provider') provider: string,
    @Body() body: unknown,
  ): Promise<PaymentGatewayResponse> {
    const { scope, actor } = await this.authenticate(request);
    const input = checkPaymentGatewayCredentialRequestSchema.parse(body);
    const gateway = await this.container.paymentGateways.checkCredential(scope, actor, {
      idempotencyKey: input.idempotencyKey,
      provider,
    });
    return this.respond(scope, gateway);
  }

  private async respond(
    scope: TenantContext,
    gateway: PaymentGatewayRecord,
  ): Promise<PaymentGatewayResponse> {
    const [currency, facts] = await Promise.all([
      this.container.paymentGateways.currency(scope),
      this.container.paymentGateways.factsFor(scope, gateway.provider),
    ]);
    return { gateway: toView(gateway, currency, facts) };
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

/**
 * The wire shape.
 *
 * The amounts go out as decimal strings. JSON has no bigint, and a `number` here is the
 * float the money model refuses — silently, above 2^53. The currency travels with them
 * and it is the ROW'S: the denomination the bounds were saved in, which is the only one
 * in which the two numbers mean anything. The installation's current currency stands in
 * only for a row the previous release wrote without one — `gateway-ports.ts` says why
 * that row exists and why it means exactly that.
 *
 * The descriptor's `settlesVia` and `requiresCredentials` are deliberately absent — the
 * view schema says why.
 */
const NO_FACTS: GatewayOperatorFacts = {
  credentialSetAt: null,
  callbackUrl: null,
  webhookSecretSetAt: null,
  lastCheck: null,
  verifyKeySetAt: null,
};

function toView(
  gateway: PaymentGatewayRecord,
  currency: SalesCurrencyCode,
  facts: GatewayOperatorFacts,
): PaymentGatewayView {
  return {
    provider: gateway.provider,
    status: gateway.status,
    displayName: gateway.displayName,
    instructions: gateway.instructions,
    minAmountMinor: gateway.minAmountMinor.toString(),
    maxAmountMinor: gateway.maxAmountMinor.toString(),
    // The row's own denomination — what the bounds mean, not what the installation
    // currently sells in. When the two differ the route is refusing, and this is how
    // the operator sees why.
    currency: gateway.boundsCurrency ?? currency,
    eligibility: {
      activateAfterPayments: gateway.activateAfterPayments,
      deactivateAfterPayments: gateway.deactivateAfterPayments,
      activateAfterAccountDays: gateway.activateAfterAccountDays,
    },
    sortOrder: gateway.sortOrder,
    topupCashbackPercent: gateway.topupCashbackPercent,
    customerFeeBasisPoints: gateway.customerFeeBasisPoints,
    allowServicePurchase: gateway.allowServicePurchase,
    allowWalletTopup: gateway.allowWalletTopup,
    credential: {
      required: PAYMENT_GATEWAY_DESCRIPTORS[gateway.provider].requiresCredentials,
      setAt: facts.credentialSetAt?.toISOString() ?? null,
      webhookSecretRequired: PAYMENT_GATEWAY_DESCRIPTORS[gateway.provider].webhookSecret,
      webhookSecretSetAt: facts.webhookSecretSetAt?.toISOString() ?? null,
      lastCheckAt: facts.lastCheck?.at.toISOString() ?? null,
      lastCheckResult: facts.lastCheck?.result ?? null,
      verifyKeyRequired: PAYMENT_GATEWAY_DESCRIPTORS[gateway.provider].verifyKey,
      verifyKeySetAt: facts.verifyKeySetAt?.toISOString() ?? null,
    },
    callbackUrl: facts.callbackUrl,
    conversion: {
      rateRequired: takesFixedRate(PAYMENT_GATEWAY_DESCRIPTORS[gateway.provider].conversion),
      rateMinor: gateway.providerUnitRateMinor?.toString() ?? null,
    },
    createdAt: gateway.createdAt.toISOString(),
    updatedAt: gateway.updatedAt.toISOString(),
  };
}

/** One route's health on the wire: times as ISO strings, codes as recorded, never a value. */
export function toHealthView(entry: GatewayHealthEntry): GatewayHealthResponse['gateways'][number] {
  const iso = (value: Date | null) => (value === null ? null : value.toISOString());
  const r = entry.recorded;
  return {
    provider: entry.provider,
    status: entry.status,
    state: entry.state,
    configuration: { complete: entry.gaps.length === 0, gaps: [...entry.gaps] },
    check: {
      supported: entry.check.supported,
      lastAt: iso(entry.check.last?.at ?? null),
      lastResult: entry.check.last?.result ?? null,
    },
    answers: {
      lastInvoiceCreatedAt: iso(r.lastInvoiceCreatedAt),
      lastInquiryAnsweredAt: iso(r.lastInquiryAnsweredAt),
      lastInquiryFailure:
        r.lastInquiryFailure === null
          ? null
          : { at: r.lastInquiryFailure.at.toISOString(), code: r.lastInquiryFailure.code },
      lastCreateFailure:
        r.lastCreateFailure === null
          ? null
          : {
              at: r.lastCreateFailure.at.toISOString(),
              state: r.lastCreateFailure.state,
              code: r.lastCreateFailure.code,
            },
      attemptsInWindow: r.attemptsInWindow,
      attemptsWithProviderError: r.attemptsWithProviderError,
    },
    callBudget:
      r.callBudget === null
        ? null
        : { windowStartedAt: r.callBudget.windowStartedAt.toISOString(), used: r.callBudget.used },
    openConditions: r.openConditions.map((condition) => ({
      code: condition.code,
      severity: condition.severity,
      count: condition.count,
      since: condition.since.toISOString(),
    })),
    queues: entry.queues === null ? null : { ...entry.queues },
    lastReconciliation:
      r.lastReconciliation === null
        ? null
        : { at: r.lastReconciliation.at.toISOString(), action: r.lastReconciliation.action },
    signals: [...entry.signals],
  };
}
