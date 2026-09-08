import { Body, Controller, Get, Query, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { PanelCursor } from '../../modules/platform/panels/application/ports.js';
import {
  panelListQuerySchema,
  API_PREFIX,
  CONTROL_ERROR_CODES,
  errors,
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
 * The cursor, opaque across the wire.
 *
 * Base64url of `(id, created_at)`. Opaque on purpose: a caller that parsed it
 * would be depending on an ordering this API has not promised, and would break
 * the day the list is ordered differently. A cursor that does not decode is
 * treated as no cursor rather than an error — the worst it can do is restart
 * the traversal, and refusing would turn a stale bookmark into a failed
 * request.
 *
 * EVERY component is validated, and that is the point rather than tidiness.
 * The decoded id goes into a query that casts it to `uuid`, so `not-a-uuid`
 * reached PostgreSQL as 22P02 and came back as a 500 — a caller could turn any
 * text into an internal error by base64ing it. Restarting the traversal is the
 * documented behaviour for a cursor this code cannot read, and a cursor whose
 * id is not a uuid is one of those.
 */
const CURSOR_MAX_LENGTH = 512;
const CURSOR_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * The exact rendering `pageKeysQuery` produces, and nothing else.
 *
 * The four-digit year is load-bearing: it is what keeps the value inside
 * `timestamptz`'s range. A JavaScript `Date` spans ±271821 years, so
 * `-005000-01-01T00:00:00.000Z` is a perfectly good Date, serialises as
 * `5001-01-01 BC`, and raises `22008` at the `::timestamptz` cast — reaching
 * the caller as the same 500 the uuid check was added to close.
 */
const CURSOR_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{6}Z$/;

function encodeCursor(cursor: PanelCursor): string {
  return Buffer.from(`${cursor.id}:${cursor.createdAt}`, 'utf8').toString('base64url');
}

/** The timestamp half, or null if PostgreSQL would refuse it. */
function decodeInstant(text: string): string | null {
  const parts = CURSOR_INSTANT.exec(text);
  if (parts === null) return null;
  const at = new Date(
    `${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:${parts[6]}.000Z`,
  );
  if (Number.isNaN(at.getTime())) return null;
  // A date JavaScript silently ROLLS OVER — `2026-02-30` becomes 2 March —
  // and PostgreSQL refuses outright. The regex cannot see that, so the value
  // is compared with what it parsed to.
  if (at.toISOString().slice(0, 19) !== text.slice(0, 19)) return null;
  return text;
}

/**
 * A cursor this server did not mint is a 400. It never restarts the traversal.
 *
 * This function used to return `null` for every unreadable cursor, and a null
 * cursor drops the keyset predicate — so `GET /panels?cursor=<anything>`
 * answered **200 with page one**. A client that truncated or invented a cursor
 * looped on the first page for ever and was never told, and the Web Admin's own
 * docblock promised the opposite: "the server rejects a cursor it did not mint,
 * so a clever client-side cursor is a 400 rather than a subtle bug". It was the
 * only one of the three cursors in this codebase that behaved that way;
 * `/ops-log` and `/notifications` have always refused, and their comment gives
 * this exact looping as the reason.
 *
 * The owner resolved it: ONE house rule, and it is refusal. Absent means the
 * first page, valid means the next page, and anything else is
 * `control.invalid_value` with a 400 — never a successful-looking answer to a
 * question the caller did not ask.
 *
 * The old argument for restarting was that refusing a legal-but-unknown id
 * "would restart the traversal for ever rather than fail it, which is the worse
 * outcome". That reasoning is now inverted deliberately: failing loudly once is
 * strictly better than looping silently, because the loop is invisible to
 * everyone including the operator watching it.
 */
function decodeCursor(raw: string): PanelCursor {
  // Built rather than thrown, so every `throw` below is visible to the reader
  // AND to the compiler: a helper that throws is not a narrowing point unless
  // it is typed `never`, and `throw bad(...)` needs neither the annotation nor
  // the casts that came with it.
  const bad = (why: string): Error =>
    errors.validation(CONTROL_ERROR_CODES.INVALID_VALUE, `The \`cursor\` ${why}.`, {
      // A TRUNCATED echo. A 400 body is not a place to reflect an unbounded
      // string a caller controls.
      cursor: raw.length > 64 ? `${raw.slice(0, 64)}…` : raw,
    });
  // Bounded before it is decoded: a megabyte of base64 is a megabyte this
  // process would otherwise allocate and scan to reject.
  if (raw.length === 0 || raw.length > CURSOR_MAX_LENGTH) {
    throw bad('is not a cursor this server issued');
  }
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    throw bad('is not a cursor this server issued');
  }
  const separator = decoded.indexOf(':');
  if (separator === -1) throw bad('is not a cursor this server issued');
  const id = decoded.slice(0, separator);
  // Any UUID version, not v7 specifically: the only thing this value has to be
  // is a legal `uuid` literal, because it reaches a `uuid` column and a
  // malformed one was a driver error and a 500.
  if (!CURSOR_UUID.test(id)) throw bad('does not name a row this server issued');
  const createdAt = decodeInstant(decoded.slice(separator + 1));
  if (createdAt === null) throw bad('does not carry a position this server issued');
  return { id: id.toLowerCase(), createdAt };
}

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
      ...(page.cursor === undefined ? {} : { cursor: decodeCursor(page.cursor) }),
      // `only` is the archive browser; anything else is the working fleet. The
      // wire deliberately cannot ask for both at once — see the contract.
      archived: page.archived === 'only' ? 'ARCHIVED' : 'LIVE',
    });
    return {
      panels: panels.map((view) => this.toSummary(view)),
      nextCursor: nextCursor === null ? null : encodeCursor(nextCursor),
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
