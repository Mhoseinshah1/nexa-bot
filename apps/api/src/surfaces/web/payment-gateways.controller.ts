import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  PAYMENT_GATEWAY_ROUTES,
  paymentGatewayConfigSchema,
  routePattern,
  setPaymentGatewayStatusRequestSchema,
  updatePaymentGatewayRequestSchema,
  type PaymentGatewayListResponse,
  type PaymentGatewayResponse,
  type PaymentGatewayView,
  type SalesCurrencyCode,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, requireSessionToken } from './authenticated-request.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type { PaymentGatewayRecord } from '../../modules/commerce/payments/application/gateway-ports.js';

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
 * Nothing here returns a credential, and nothing can: no route in this release holds
 * one, so there is no field to omit. When one does, it follows the panels rule — the
 * projection selects a set-at timestamp and never a ciphertext, and never a masked
 * stand-in either, because `********` can be resubmitted as a password.
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
    const { gateways, currency } = await this.container.paymentGateways.list(scope, actor);
    return { gateways: gateways.map((gateway) => toView(gateway, currency)) };
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
    });
    const gateway = await this.container.paymentGateways.configure(scope, actor, {
      idempotencyKey: input.idempotencyKey,
      provider,
      config,
    });
    return { gateway: toView(gateway, await this.container.paymentGateways.currency(scope)) };
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
    return { gateway: toView(gateway, await this.container.paymentGateways.currency(scope)) };
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
function toView(gateway: PaymentGatewayRecord, currency: SalesCurrencyCode): PaymentGatewayView {
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
    createdAt: gateway.createdAt.toISOString(),
    updatedAt: gateway.updatedAt.toISOString(),
  };
}
