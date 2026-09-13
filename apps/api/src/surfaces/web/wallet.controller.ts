import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  walletAdjustRequestSchema,
  walletEntryListQuerySchema,
  type TenantContext,
  type WalletEntryListResponse,
  type WalletEntrySummaryResponse,
  type WalletResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, requireSessionToken } from './authenticated-request.js';
import { singleValued } from './query.js';
import { decodeKeysetCursor, encodeKeysetCursor } from './keyset-cursor.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type {
  WalletCursor,
  WalletEntryRecord,
} from '../../modules/commerce/wallet/application/ports.js';

/**
 * A customer's wallet over HTTP. THREE ROUTES: the balance, the history, one adjustment.
 *
 * What is deliberately absent, and would be the easiest thing to add by accident:
 *
 * - **No `PUT /wallet`, and no "set balance".** The legacy `صفر کردن موجودی` ("zero the
 *   balance") button is a set-balance in disguise and has no ledger reason that could
 *   honestly describe it. A balance here is derived; there is nothing to set.
 * - **No edit and no delete of an entry.** `wallet_entries_no_update` and
 *   `wallet_entries_no_delete` would refuse them, the repository has no method for
 *   either, and a route that always 500s reads as a capability.
 * - **No reason parameter.** `adjust` derives it from the direction, so a request
 *   cannot file a debit as a `PURCHASE`.
 *
 * Authentication happens here; AUTHORIZATION does not — `WalletService` charges
 * `users.view`, `users.wallet.credit` and `users.wallet.debit` itself, so no route is
 * protected merely by the Web Admin not drawing a button.
 */
@Controller(`${API_PREFIX}`)
export class WalletController {
  /*
   * The paths are LITERALS here, not `WALLET_ROUTES.balance(':customerId')`.
   *
   * Those builders run `encodeURIComponent` on their argument, which turns `:customerId`
   * into `%3AcustomerId` — a route that can never match. The builders are for CALLERS
   * assembling a URL with a real id; a route declaration is the other side of that
   * contract. Every other controller here writes the literal for the same reason.
   */
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get('users/:customerId/wallet')
  async balance(
    @Req() request: FastifyRequest,
    @Param('customerId') customerId: string,
  ): Promise<WalletResponse> {
    const { scope, actor } = await this.authenticate(request);
    // The id is NOT cast: `WalletService` validates it, so a malformed path segment is
    // a 400 rather than a 500 at the `uuid` cast.
    const balance = await this.container.wallet.balance(scope, actor, customerId);
    return {
      wallet: {
        customerId,
        balanceAmount: balance.amountMinor.toString(),
        currency: balance.currency,
        entryCount: balance.entryCount,
      },
    };
  }

  @Get('users/:customerId/wallet/entries')
  async entries(
    @Req() request: FastifyRequest,
    @Param('customerId') customerId: string,
    @Query() raw: Record<string, unknown>,
  ): Promise<WalletEntryListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const query = singleValued(raw);
    const page = walletEntryListQuerySchema.parse({
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    const result = await this.container.wallet.history(scope, actor, customerId, {
      ...(page.limit === undefined ? {} : { limit: page.limit }),
      ...(page.cursor === undefined ? {} : { cursor: walletCursorFrom(page.cursor) }),
    });
    return {
      entries: result.items.map(toSummary),
      nextCursor: result.nextCursor === null ? null : encodeKeysetCursor(result.nextCursor),
    };
  }

  /**
   * An operator moving a customer's money by hand, and the ONLY way a wallet is funded
   * in this release.
   *
   * The amount arrives as a decimal STRING and is parsed to a `bigint` here. It is never
   * a `number`: JSON has one numeric type and it loses precision past 2^53, which for
   * IRR minor units is a balance an ordinary tenant can reach. The schema bounds it
   * before this line ever runs, and `WalletService` bounds it again — the service is the
   * one that matters, because a caller reaching it another way passes no schema.
   */
  @Post('users/:customerId/wallet/adjust')
  async adjust(
    @Req() request: FastifyRequest,
    @Param('customerId') customerId: string,
    @Body() body: unknown,
  ): Promise<{ readonly entry: WalletEntrySummaryResponse }> {
    const { scope, actor } = await this.authenticate(request);
    const input = walletAdjustRequestSchema.parse(body);
    const entry = await this.container.wallet.adjust(scope, actor, customerId, {
      idempotencyKey: input.idempotencyKey,
      direction: input.direction,
      amountMinor: BigInt(input.amount),
      currency: input.currency,
      note: input.note,
    });
    return { entry: toSummary(entry) };
  }

  private async authenticate(
    request: FastifyRequest,
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request, this.isProduction);
    const { admin, session } = await this.container.auth.authenticate(token);
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    // `botInstanceId: null`: a wallet belongs to the TENANT. A customer who arrived
    // through one bot and a tenant running two share one balance.
    return {
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }

  private get isProduction(): boolean {
    return this.container.config.NODE_ENV === 'production';
  }
}

/** The shared cursor, branded for this list. A cursor this server did not mint is a 400. */
function walletCursorFrom(raw: string): WalletCursor {
  const position = decodeKeysetCursor(raw);
  return { createdAt: position.createdAt, id: position.id };
}

/**
 * The only `WalletEntryRecord` → JSON conversion on this surface.
 *
 * `amount` is TEXT and positive, with `direction` carrying the sign — the ledger's own
 * shape, preserved to the wire so no client has to reconstruct it and none can
 * disagree about which way the money went.
 */
function toSummary(record: WalletEntryRecord): WalletEntrySummaryResponse {
  return {
    id: record.id,
    customerId: record.customerId,
    direction: record.direction,
    reason: record.reason,
    amount: record.amount.amountMinor.toString(),
    currency: record.amount.currency,
    orderId: record.orderId,
    paymentId: record.paymentId,
    actorAdminId: record.actorAdminId,
    note: record.note,
    createdAt: record.createdAt.toISOString(),
  };
}
