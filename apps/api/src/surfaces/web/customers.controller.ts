import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  blockCustomerRequestSchema,
  customerListQuerySchema,
  CUSTOMER_ROUTES,
  type CustomerListResponse,
  type CustomerResponse,
  type CustomerSummaryResponse,
  type TenantContext,
} from '@nexa/contracts';
import type { UserId } from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { singleValued } from './query.js';
import { decodeKeysetCursor, encodeKeysetCursor } from './keyset-cursor.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type {
  CustomerCursor,
  CustomerRecord,
} from '../../modules/commerce/customers/application/ports.js';

/**
 * Customers over HTTP, at `/users`.
 *
 * `/users` rather than `/customers` because that is the vocabulary the permission
 * catalogue froze — `users.view`, `users.search`, `users.block` — and a route that
 * disagreed with its own permissions would be one rename away from a surface whose
 * guard checks a key nobody associates with it.
 *
 * Authentication happens here; AUTHORIZATION does not. Every method calls
 * `CustomerService`, which checks the permission itself — so the Telegram admin surface
 * this phase does not build cannot reach a different answer, and no endpoint is
 * protected merely by the Web Admin not drawing a button for it. The RBAC tests prove
 * it from the HTTP side: `users.view` without `users.search` is refused a search, and
 * `users.view` without `users.block` is refused a block, with the session that holds
 * them presenting a real cookie.
 *
 * `toSummary` below is the only thing that turns a `CustomerRecord` into JSON, and what
 * it does NOT carry is the point: no wallet balance, no order count, no service list, no
 * payment history. That is no longer because those entities are unbuilt — wallets came
 * in 4C, orders in 4B, services in 4D — but because this response is a CUSTOMER row and
 * nothing else. Each of those is read from the endpoint that owns it (`/users/:id/wallet`,
 * `/orders?customerId=…`, `/services?customerId=…`), which charges its own permission:
 * `users.view` is not `orders.view`, and a customer response that carried an order count
 * would hand one to a reader the guard would have refused. A summed figure here would
 * also be a number computed by a surface that does not own it, which is the legacy
 * system's "total revenue" disagreeing with itself by 38%.
 */
@Controller(`${API_PREFIX}`)
export class CustomersController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(CUSTOMER_ROUTES.list)
  async list(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<CustomerListResponse> {
    const { scope, actor } = await this.authenticate(request);
    // A repeated parameter is an ARRAY, not a string. Through the same guard every
    // other list on this surface uses, rather than relying on the schema to refuse it.
    const query = singleValued(raw);
    const page = customerListQuerySchema.parse({
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.telegramUserId === undefined ? {} : { telegramUserId: query.telegramUserId }),
      ...(query.username === undefined ? {} : { username: query.username }),
      ...(query.status === undefined ? {} : { status: query.status }),
    });
    const result = await this.container.customers.list(scope, actor, {
      ...(page.limit === undefined ? {} : { limit: page.limit }),
      // The shared cursor, the same one Panels uses. A cursor this server did not mint
      // is a 400 and never a silent restart of the traversal.
      ...(page.cursor === undefined ? {} : { cursor: customerCursorFrom(page.cursor) }),
      search: {
        ...(page.telegramUserId === undefined ? {} : { telegramUserId: page.telegramUserId }),
        ...(page.username === undefined ? {} : { usernamePrefix: page.username }),
        ...(page.status === undefined ? {} : { status: page.status }),
      },
    });
    return {
      customers: result.items.map(toSummary),
      nextCursor: result.nextCursor === null ? null : encodeKeysetCursor(result.nextCursor),
    };
  }

  @Get('users/:id')
  async detail(@Req() request: FastifyRequest, @Param('id') id: string): Promise<CustomerResponse> {
    const { scope, actor } = await this.authenticate(request);
    // The id is NOT cast here. `CustomerService.get` validates it, so a Telegram admin
    // surface added later cannot reach the repository with `not-a-uuid` and turn a
    // malformed request into a 500 at the `uuid` cast.
    return { customer: toSummary(await this.container.customers.get(scope, actor, id)) };
  }

  @Post('users/:id/block')
  async block(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CustomerResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = blockCustomerRequestSchema.parse(body);
    const customer = await this.container.customers.block(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      customerId: id,
      reason: command.reason ?? null,
    });
    return { customer: toSummary(customer) };
  }

  @Post('users/:id/unblock')
  async unblock(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CustomerResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = blockCustomerRequestSchema.parse(body);
    const customer = await this.container.customers.unblock(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      customerId: id,
      // An unblock CLEARS the stored reason rather than replacing it, so whatever an
      // operator typed into an unblock dialogue is not kept: a reason on an active
      // customer would read as current. The service does the clearing; this passes the
      // note through so the AUDIT row records why, which is where a justification for
      // an unblock belongs.
      reason: command.reason ?? null,
    });
    return { customer: toSummary(customer) };
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
    return {
      // `botInstanceId: null` deliberately. A customer belongs to the TENANT, not to the
      // bot they first wrote to — `first_bot_instance_id` records where they arrived and
      // is not a scope. A tenant with two bots has one customer list, which is what an
      // operator answering a support message needs.
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }

  private get isProduction(): boolean {
    return this.container.config.NODE_ENV === 'production';
  }
}

/**
 * The only `CustomerRecord` → JSON conversion on this surface.
 *
 * Every timestamp is an ISO string from a `Date` the driver produced, so the wire never
 * carries a local rendering. `telegramUserId` stays a STRING: it is identity, and a JSON
 * number above 2^53 is a different id than the one stored.
 */
function toSummary(record: CustomerRecord): CustomerSummaryResponse {
  return {
    id: record.id,
    telegramUserId: record.telegramUserId,
    username: record.username,
    firstName: record.firstName,
    lastName: record.lastName,
    languageCode: record.languageCode,
    status: record.status,
    firstSeenAt: record.firstSeenAt.toISOString(),
    lastSeenAt: record.lastSeenAt.toISOString(),
    blockedAt: record.blockedAt === null ? null : record.blockedAt.toISOString(),
    blockedReason: record.blockedReason,
  };
}

/**
 * The shared cursor, in the customer module's own type.
 *
 * `decodeKeysetCursor` validates the uuid and the instant and knows nothing about
 * branded ids; the brand is a compile-time tag this boundary applies, the same way the
 * `:id` path parameter is handed to a service that parses it. Nothing is re-validated
 * here, because a second copy of the validation is the thing the extraction removed.
 */
function customerCursorFrom(raw: string): CustomerCursor {
  const position = decodeKeysetCursor(raw);
  return { createdAt: position.createdAt, id: position.id as UserId };
}
