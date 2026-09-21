import { Body, Controller, Get, Query, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  panelListQuerySchema,
  API_PREFIX,
  PANEL_ROUTES,
  providerDescriptor,
  type PanelHealthResponse,
  type PanelListResponse,
  type PanelResponse,
  type PanelSummaryResponse,
  type ProviderListResponse,
  type TenantContext,
  type TestPanelResponse,
} from '@nexa/contracts';
import {
  IMPLEMENTED_PROVIDER_TYPES,
  providerAdapter,
} from '../../modules/platform/providers/infrastructure/adapter-registry.js';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { singleValued } from './query.js';
import { decodeKeysetCursor, encodeKeysetCursor } from './keyset-cursor.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type { PanelView } from '../../modules/platform/panels/application/ports.js';
import type { PanelWithCapacity } from '../../modules/platform/panels/application/capacity-ports.js';
import { readHealth } from '../../modules/platform/panels/application/panel-health-view.js';

/**
 * Panels over HTTP.
 *
 * Authentication happens here; AUTHORIZATION does not. Every method calls the
 * panel service, which checks the permission itself — so a Telegram admin
 * surface added later cannot reach a different answer, and no endpoint is
 * protected merely by the web app not drawing a button for it.
 *
 * The response builder is the security boundary of this file. `toSummary`
 * below is the ONLY thing that turns a `PanelView` into JSON, and there is no
 * path from a stored credential to its output: the view type it receives has no
 * credential value on it, because the repository never selects one.
 */
/**
 * The cursor machinery lives in `keyset-cursor.ts`, not here.
 *
 * It was written and corrected four times in this file, and `/users` needed the
 * same thing. It was MOVED rather than copied, for the reason `CLAUDE.md` gives
 * about `probe-core.ts`: the copy that silently keeps the old behaviour is the
 * one nobody is watching. `panels-cursor.test.ts` pins this surface's behaviour
 * to the values and refusals it produced before the move.
 */

@Controller(`${API_PREFIX}`)
export class PanelsController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(PANEL_ROUTES.providers)
  async providers(@Req() request: FastifyRequest): Promise<ProviderListResponse> {
    // Authenticated, because it describes what this installation can operate —
    // and it now does, which it did not before.
    // No permission beyond a session: it is a catalogue of code, identical for
    // every tenant, and a permission nobody can be denied is a permission that
    // exists to be looked at rather than enforced.
    await this.authenticate(request);
    // Only the types this release has an ADAPTER for. The descriptor catalogue
    // is the frozen contract and lists `sanaei`, whose adapter is Phase 3B; a
    // client shown it would offer a configuration that every create rejects
    // with PROVIDER_TYPE_UNSUPPORTED, which is the legacy bot's "your panel was
    // added successfully" failure wearing better manners.
    return {
      providers: implementedDescriptors().map((descriptor) => ({
        key: descriptor.key,
        canonicalName: descriptor.canonicalName,
        credentialShape: descriptor.credentialShape,
        capabilities: [...descriptor.capabilities],
        requiredActivationFields: [...descriptor.requiredActivationFields],
      })),
    };
  }

  @Get(PANEL_ROUTES.list)
  async list(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<PanelListResponse> {
    const { scope, actor } = await this.authenticate(request);
    // A repeated parameter is an ARRAY, not a string. Nothing here calls a
    // string method on one — `panelListQuerySchema` refuses it — so this is
    // not the 500 the ops-log reader had. It is the same lie in the same
    // shape, and the sibling that was left on it is how the previous round's
    // defect happened, so it goes through the same guard.
    const query = singleValued(raw);
    const page = panelListQuerySchema.parse({
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.archived === undefined ? {} : { archived: query.archived }),
    });
    const { panels, nextCursor } = await this.container.panels.list(scope, actor, {
      ...(page.limit === undefined ? {} : { limit: page.limit }),
      ...(page.cursor === undefined ? {} : { cursor: decodeKeysetCursor(page.cursor) }),
      // `only` is the archive browser; anything else is the working fleet. The
      // wire deliberately cannot ask for both at once — see the contract.
      archived: page.archived === 'only' ? 'ARCHIVED' : 'LIVE',
    });
    return {
      panels: panels.map((view) => this.toSummary(view)),
      nextCursor: nextCursor === null ? null : encodeKeysetCursor(nextCursor),
    };
  }

  @Get('panels/:id')
  async detail(@Req() request: FastifyRequest, @Param('id') id: string): Promise<PanelResponse> {
    const { scope, actor } = await this.authenticate(request);
    return { panel: this.toSummary(await this.container.panels.get(scope, actor, id)) };
  }

  @Post(PANEL_ROUTES.create)
  async create(@Req() request: FastifyRequest, @Body() body: unknown): Promise<PanelResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const result = await this.container.panels.create(scope, actor, body);
    return { panel: this.toSummary(result.view) };
  }

  @Post('panels/:id')
  async update(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<PanelResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const view = await this.container.panels.update(scope, actor, id, body);
    return { panel: this.toSummary(view) };
  }

  @Post('panels/:id/credentials')
  async credentials(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<PanelResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const view = await this.container.panels.setCredentials(scope, actor, id, body);
    return { panel: this.toSummary(view) };
  }

  @Post('panels/:id/status')
  async status(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<PanelResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const view = await this.container.panels.setStatus(scope, actor, id, body);
    return { panel: this.toSummary(view) };
  }

  @Post('panels/:id/test')
  async test(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<TestPanelResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const result = await this.container.panels.testConnection(scope, actor, id, body);
    return { panel: this.toSummary(result.view), probed: result.probed };
  }

  /**
   * A panel, as JSON.
   *
   * The one place a `PanelView` becomes a response, so the credential rule has
   * one place to hold: what goes out is whether each credential is CONFIGURED
   * and when it was last replaced. No value, no masked value, no ciphertext, no
   * key id. The legacy web admin rendered a panel's stored password as readable
   * text on its detail page (WEB-BR-007); this shape has nowhere to put one.
   */
  private toSummary(view: PanelWithCapacity): PanelSummaryResponse {
    const descriptor = providerDescriptor(view.panel.providerType);
    return {
      id: view.panel.id,
      name: view.panel.name,
      providerType: view.panel.providerType,
      providerName: descriptor?.canonicalName ?? view.panel.providerType,
      baseUrl: view.panel.baseUrl,
      status: view.panel.status,
      capabilities: descriptor === null ? [] : [...descriptor.capabilities],
      credentials: {
        username: state(view.credentials.usernameSetAt),
        password: state(view.credentials.passwordSetAt),
        apiToken: state(view.credentials.apiTokenSetAt),
      },
      /*
       * The stored activation, as stored. Not a credential, and readable by design.
       *
       * The audit entries for a create or an edit record only which FIELDS were given,
       * on the ground that "the panel read already answers that, under the same
       * permission". This is the read that makes the ground true; without it the write
       * was unauditable and the value unreadable, which is the write-only settings
       * defect `docs/conventions.md` names.
       */
      activation: toActivation(view.panel.activation),
      health: this.toHealth(view),
      /*
       * Computed by the service, never by this file.
       *
       * `available` in particular: the floor at zero is a rule about what a cap
       * lowered below usage means, and a surface that did the subtraction itself
       * would be the second place that rule lives — and the one that forgot it,
       * because the arithmetic looks obvious.
       */
      capacity: view.capacity,
      /*
       * Returned in full, for the reason `activation` above states.
       *
       * A write-only policy is the legacy settings screen: an operator could turn a
       * mode off and have no way to see it was off except by turning it on again. The
       * template in particular is a value somebody typed and will later need to read
       * back to work out why a customer's username looks the way it does.
       */
      usernamePolicy: view.panel.usernamePolicy,
      /*
       * Computed by the service, never by this file — the same rule `capacity`
       * above states, and here it matters more. This verdict is the one a
       * surface may gate a sale on, and a second implementation of it is a
       * second answer to "may we take money for this".
       */
      sellability: view.sellability,
      createdAt: view.panel.createdAt.toISOString(),
      updatedAt: view.panel.updatedAt.toISOString(),
    };
  }

  /**
   * Health, as an operator needs to read it.
   *
   * `DISABLED`, `UNCHECKED` and `stale` are PROJECTED rather than stored, and why
   * each of them is, is written once — in `readHealth`, which this calls and the
   * Telegram panels section calls too.
   */
  private toHealth(view: PanelView): PanelHealthResponse {
    /*
     * The three PROJECTED answers come from `readHealth`, which the Telegram
     * panels section also calls. It used to be this method's own arithmetic,
     * and the Telegram section needed the same three answers — "two surfaces
     * recompute the same concept differently" is a failure this repository has
     * a measured example of, so the concept moved to the application layer and
     * both surfaces read it from there.
     *
     * What stays here is this response's own shape: the four fields no other
     * surface renders. A Telegram message has no room for a latency figure, a
     * provider version or an HTTP status code, and would not be improved by one.
     */
    const reading = readHealth(view.panel, view.health, this.container.clock.now());
    return {
      state: reading.state,
      checkedAt: reading.checkedAt?.toISOString() ?? null,
      latencyMs: view.health?.latencyMs ?? null,
      failure: reading.failure,
      status: view.health?.statusCode ?? null,
      providerVersion: view.health?.providerVersion ?? null,
      lastHealthyAt: view.health?.lastHealthyAt?.toISOString() ?? null,
      stale: reading.stale,
    };
  }

  private get isProduction(): boolean {
    return this.container.config.NODE_ENV === 'production';
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
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }
}

/**
 * The stored activation as an object, or null.
 *
 * `PanelRecord.activation` is `unknown` because its shape is per provider and a
 * repository cannot narrow it. Narrowing here is a projection decision rather than a
 * second opinion about the schema: anything that is not a plain object — a legacy
 * scalar, an array, a value a future release writes differently — is reported as
 * "unset" rather than passed through, because a surface that renders whatever it finds
 * is a surface a bad row can break.
 */
function toActivation(activation: unknown): Record<string, unknown> | null {
  if (typeof activation !== 'object' || activation === null || Array.isArray(activation)) {
    return null;
  }
  return activation as Record<string, unknown>;
}

function state(setAt: Date | null): { configured: boolean; lastReplacedAt: string | null } {
  return { configured: setAt !== null, lastReplacedAt: setAt?.toISOString() ?? null };
}

/**
 * The descriptors of provider types this release can actually operate.
 *
 * Resolved through the registry rather than filtered by name, so the list
 * cannot drift from the adapters that exist: a type here has been constructed.
 */
function implementedDescriptors() {
  return IMPLEMENTED_PROVIDER_TYPES.map((type) => providerAdapter(type).descriptor);
}
