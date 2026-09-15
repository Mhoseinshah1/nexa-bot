import { Body, Controller, Get, Query, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  panelListQuerySchema,
  API_PREFIX,
  PANEL_HEALTH_FRESH_FOR_MS,
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
  private toSummary(view: PanelView): PanelSummaryResponse {
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
      createdAt: view.panel.createdAt.toISOString(),
      updatedAt: view.panel.updatedAt.toISOString(),
    };
  }

  /**
   * Health, as an operator needs to read it.
   *
   * Three things a stored state cannot say on its own, and each is projected
   * here rather than persisted:
   *
   *   `DISABLED`  — from the panel's status. Storing it would mean re-enabling
   *                 a panel required a health write, and the health of a panel
   *                 nobody is probing is not a fact about the panel.
   *   `UNCHECKED` — the absence of a row. Inventing a row to record that
   *                 nothing has happened makes a never-checked panel look
   *                 checked, which is the legacy statistics screen's mistake:
   *                 it counted CONFIGURED panels and called them connected.
   *   `stale`     — computed against one constant, server-side, so two
   *                 surfaces cannot disagree about what "recent" means.
   */
  private toHealth(view: PanelView): PanelHealthResponse {
    const now = this.container.clock.now().getTime();
    if (view.health === null) {
      return {
        state: view.panel.status === 'ACTIVE' ? 'UNCHECKED' : 'DISABLED',
        checkedAt: null,
        latencyMs: null,
        failure: null,
        status: null,
        providerVersion: null,
        lastHealthyAt: null,
        stale: false,
      };
    }
    return {
      state: view.panel.status === 'ACTIVE' ? view.health.state : 'DISABLED',
      checkedAt: view.health.checkedAt.toISOString(),
      latencyMs: view.health.latencyMs,
      failure: view.health.failure,
      status: view.health.statusCode,
      providerVersion: view.health.providerVersion,
      lastHealthyAt: view.health.lastHealthyAt?.toISOString() ?? null,
      stale: now - view.health.checkedAt.getTime() > PANEL_HEALTH_FRESH_FOR_MS,
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
