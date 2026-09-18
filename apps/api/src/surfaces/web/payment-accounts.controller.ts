import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  PAYMENT_ACCOUNT_ROUTES,
  createPaymentAccountRequestSchema,
  routePattern,
  setDefaultPaymentAccountRequestSchema,
  setPaymentAccountEnabledRequestSchema,
  updatePaymentAccountRequestSchema,
  type PaymentAccountListResponse,
  type PaymentAccountResponse,
  type PaymentAccountView,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, requireSessionToken } from './authenticated-request.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type { PaymentAccountRecord } from '../../modules/commerce/payments/application/account-ports.js';

/**
 * Manual-transfer accounts over HTTP, at `/payment-accounts`.
 *
 * One read and four writes, and the four are separate because each is a different
 * operator decision with a different audit row: add an account, correct its fields,
 * stop or resume using it, and move the destination. A single PATCH taking every field
 * would make "who moved the money, and when" answerable only by diffing two payloads.
 *
 * What is deliberately absent is a DELETE. An account is disabled, never removed:
 * `payment_destinations` names the row each payment was issued against, and a deleted
 * account is a payment whose provenance is a dangling id. `customers` states the same
 * rule for a block — it is not a deletion.
 *
 * The list takes no cursor, and that is the one place this API is not a keyset page.
 * `PAYMENT_ACCOUNT_MAX_PER_TENANT` makes the list complete by construction, which a
 * configuration screen needs and a paginated one cannot promise.
 *
 * Authentication happens here; AUTHORIZATION does not — `PaymentAccountService` charges
 * `payments.accounts.view` and `payments.accounts.edit` itself.
 */
@Controller(`${API_PREFIX}`)
export class PaymentAccountsController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(PAYMENT_ACCOUNT_ROUTES.list)
  async list(@Req() request: FastifyRequest): Promise<PaymentAccountListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const accounts = await this.container.paymentAccounts.list(scope, actor);
    return { accounts: accounts.map(toView) };
  }

  @Post(PAYMENT_ACCOUNT_ROUTES.create)
  async create(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<PaymentAccountResponse> {
    const { scope, actor } = await this.authenticate(request);
    /*
     * Parsed HERE, which is where the card number and the Sheba are normalised and
     * structurally checked. Everything downstream — the service, the repository, the
     * snapshot — receives the one representation this parse produced.
     */
    const input = createPaymentAccountRequestSchema.parse(body);
    const account = await this.container.paymentAccounts.create(scope, actor, {
      idempotencyKey: input.idempotencyKey,
      fields: fieldsOf(input),
      enabled: input.enabled,
      makeDefault: input.makeDefault,
    });
    return { account: toView(account) };
  }

  @Post(routePattern(PAYMENT_ACCOUNT_ROUTES.update, 'id'))
  async update(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<PaymentAccountResponse> {
    const { scope, actor } = await this.authenticate(request);
    const input = updatePaymentAccountRequestSchema.parse(body);
    const account = await this.container.paymentAccounts.update(scope, actor, {
      idempotencyKey: input.idempotencyKey,
      accountId: id,
      fields: fieldsOf(input),
    });
    return { account: toView(account) };
  }

  @Post(routePattern(PAYMENT_ACCOUNT_ROUTES.enabled, 'id'))
  async setEnabled(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<PaymentAccountResponse> {
    const { scope, actor } = await this.authenticate(request);
    const input = setPaymentAccountEnabledRequestSchema.parse(body);
    const account = await this.container.paymentAccounts.setEnabled(scope, actor, {
      idempotencyKey: input.idempotencyKey,
      accountId: id,
      enabled: input.enabled,
    });
    return { account: toView(account) };
  }

  @Post(routePattern(PAYMENT_ACCOUNT_ROUTES.makeDefault, 'id'))
  async setDefault(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<PaymentAccountResponse> {
    const { scope, actor } = await this.authenticate(request);
    const input = setDefaultPaymentAccountRequestSchema.parse(body);
    const account = await this.container.paymentAccounts.setDefault(scope, actor, {
      idempotencyKey: input.idempotencyKey,
      accountId: id,
    });
    return { account: toView(account) };
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

/** The five fields an operator supplies, separated from the two dispositions beside them. */
function fieldsOf(input: {
  readonly label: string;
  readonly bankName: string;
  readonly holderName: string;
  readonly cardNumber: string;
  readonly iban: string | null;
  readonly sortOrder: number;
}) {
  return {
    label: input.label,
    bankName: input.bankName,
    holderName: input.holderName,
    cardNumber: input.cardNumber,
    iban: input.iban,
    sortOrder: input.sortOrder,
  };
}

/**
 * The card number and the Sheba go out IN FULL.
 *
 * Deliberate, in a controller family that refuses to return a panel credential: these
 * are not secrets — the installation publishes them to every customer who chooses to pay
 * out of band — and `docs/conventions.md` requires a setting surface to return its
 * current value. The Web Admin masks them in its LIST, which is presentation.
 */
function toView(account: PaymentAccountRecord): PaymentAccountView {
  return {
    id: account.id,
    label: account.label,
    bankName: account.bankName,
    holderName: account.holderName,
    cardNumber: account.cardNumber,
    iban: account.iban,
    enabled: account.enabled,
    isDefault: account.isDefault,
    sortOrder: account.sortOrder,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  };
}
