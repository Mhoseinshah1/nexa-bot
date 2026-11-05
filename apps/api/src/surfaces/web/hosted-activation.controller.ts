import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { API_PREFIX, type HostedActivationRedeemResponse } from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import { matchesTrustedEntry } from '../../infrastructure/trusted-proxy.js';
import { anonymousActor, assertOriginOrHostedDomain } from './authenticated-request.js';

/** Headers a request that was PROXIED carries and the edge's own `ask` call never does. */
const FORWARDING_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'forwarded',
  'via',
] as const;

/** Certificate questions per minute, across every caller. Far above any real issuance rate. */
export const DOMAIN_CHECK_BUDGET_PER_MINUTE = 120;

/**
 * A fixed one-minute budget for the whole endpoint (the edge is its only caller, so a
 * per-address limit would be a global one anyway). In memory: one API process serves an
 * installation (ADR-0001), and a counter that resets on restart only forgives a minute.
 */
export class DomainCheckBudget {
  private windowStart = 0;
  private count = 0;

  constructor(
    private readonly now: () => number,
    private readonly limit = DOMAIN_CHECK_BUDGET_PER_MINUTE,
  ) {}

  admit(): boolean {
    const at = this.now();
    if (at - this.windowStart >= 60_000) {
      this.windowStart = at;
      this.count = 0;
    }
    this.count += 1;
    return this.count <= this.limit;
  }
}

function isLoopback(address: string): boolean {
  const lower = address.toLowerCase();
  return lower === '::1' || lower.startsWith('127.') || lower.startsWith('::ffff:127.');
}

/**
 * Phase 6A PR-4 (D2): the two surfaces a hosted domain needs that are not the signed-in
 * admin — the hosted owner redeeming their link, and the edge asking whether to issue a
 * certificate.
 */
@Controller(`${API_PREFIX}/hosted-activation`)
export class HostedActivationController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  /**
   * The hosted owner's redemption. Anonymous by design: the link's token is the credential,
   * valid only on the domain it was made for. Origin-checked like every write (the static list,
   * or the hosted domain's own origin), rate-limited per address with the sign-in route, and
   * never cached.
   */
  @Post('redeem')
  @HttpCode(200)
  async redeem(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
  ): Promise<HostedActivationRedeemResponse> {
    await assertOriginOrHostedDomain(this.container, request);
    void reply.header('cache-control', 'no-store');
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    await this.container.hostedOwnerActivation.redeem(
      request.hostname,
      anonymousActor(correlationId, request),
      body,
    );
    return { ok: true };
  }
}

/**
 * The edge's certificate question, in its own controller under `internal/hosting` — NOT a root
 * (empty-prefix) one, and deliberately given no handle block in `routes.caddy`: the deployment
 * test that demands a proxy block for every root route does not apply, because this one must NOT
 * be reachable from the internet (`hosted-activation.test.ts` pins that it is not routed).
 */
@Controller('internal/hosting')
export class HostedDomainCheckController {
  private readonly budget: DomainCheckBudget;

  constructor(@Inject(CONTAINER) private readonly container: Container) {
    this.budget = new DomainCheckBudget(() => this.container.clock.now().getTime());
  }

  /**
   * The edge's on-demand TLS question: `GET /internal/hosting/domain-check?domain=<name>`.
   * 200 for a DNS-verified domain of an ACTIVE hosted bot; 404 for everything else, including
   * every refusal below (so the route does not advertise itself).
   *
   * Not abusable by design, in four layers: it is NOT proxied by the edge (`routes.caddy` has no
   * handler for it), so the internet cannot reach it; it answers only a peer in
   * `TRUSTED_PROXY_IPS` (or loopback), judged on the SOCKET address, never a header; it refuses
   * any request carrying forwarding headers (the edge's own `ask` call has none, a proxied
   * public request always does); and it has its own global budget. What it reveals is one bit
   * about a name the caller already named.
   */
  @Get('domain-check')
  async domainCheck(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Query('domain') domain: unknown,
  ): Promise<string> {
    void reply.header('cache-control', 'no-store');
    const peer = request.raw.socket.remoteAddress ?? '';
    const fromEdge =
      peer !== '' &&
      (isLoopback(peer) ||
        this.container.config.TRUSTED_PROXY_IPS.some((entry) => matchesTrustedEntry(peer, entry)));
    const proxied = FORWARDING_HEADERS.some((name) => request.headers[name] !== undefined);
    if (!fromEdge || proxied || !this.budget.admit() || typeof domain !== 'string') {
      void reply.code(404);
      return '';
    }
    const allowed = await this.container.hostedOwnerActivation.certificateAllowed(domain);
    void reply.code(allowed ? 200 : 404);
    return '';
  }
}
