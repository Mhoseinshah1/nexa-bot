import { createHash } from 'node:crypto';
import {
  PANEL_ACTIVATION_SCHEMAS,
  createPanelRequestSchema,
  errors,
  setPanelCredentialsRequestSchema,
  uuidV7Schema,
  setPanelStatusRequestSchema,
  testPanelRequestSchema,
  updatePanelRequestSchema,
  PANEL_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  isSystemContext,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PanelStatus,
  type ProviderConnectionAdapter,
  type ProviderType,
  type ScopeContext,
  type TenantContext,
  type UnitOfWork,
  NexaError,
  shapeAcceptsCredential,
  providerDescriptor,
} from '@nexa/contracts';
import type { PanelActivation } from '@nexa/contracts';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../access/application/authorized-mutation.js';
import { rememberOnce } from '../../idempotency/application/remember-once.js';
import type { SessionRepository } from '../../identity/application/ports.js';
import type { ScopeActivityReader } from '../../system/application/record-ping.service.js';
import type { OperationalConditionReader } from '../../opslog/application/ports.js';
import {
  closesPanelCondition,
  panelConditionKey,
  RESTORED_CODE,
  RETIRED_CODE,
} from './panel-monitor.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  checkUrl,
  refusalMessage,
  type UrlPolicyOptions,
} from '../../../../infrastructure/net/url-policy.js';
import type { SafeHttpClient } from '../../../../infrastructure/net/safe-http.js';
import type {
  PanelCredentialStore,
  PanelCredentialWrite,
  PanelRepository,
  ProbeBudget,
  PanelView,
  PanelCursor,
  PanelArchiveScope,
} from './ports.js';
import { capacityOf } from './panel-capacity.js';
import { connectionIdentityOf, validationAuthorisesEnable } from './panel-eligibility.js';
import { attemptProbe, persistProbeResult, type ProbeCoreDeps } from './probe-core.js';
import type {
  PanelCapacityRepository,
  PanelWithCapacity,
} from './capacity-ports.js';
import {
  effectivePreviousFailures,
  scheduleAfterProbe,
  type MonitorCadence,
} from '../domain/monitor-cadence.js';

/**
 * The tenant-wide probe limiter's condition, and its recovery.
 *
 * A pair, mutually exclusive in BOTH directions. The limit closes the
 * recovery and the recovery closes the limit, so a tenant that runs out of
 * capacity twice produces two limits and two recoveries rather than one of
 * each with a stale row left open beside it.
 */
const PROBE_LIMITED_CODE = 'panel.probe.limited';
const PROBE_LIMITED_OK_CODE = 'panel.probe.ok';

const PANELS_VIEW = 'panels.view' as const;
const PANELS_EDIT = 'panels.edit' as const;
const PANELS_CREDENTIALS_ROTATE = 'panels.credentials.rotate' as const;

export interface CreatePanelCommand {
  readonly name: string;
  /**
   * Already narrowed by the contract schema, which enumerates the types.
   *
   * Typed as `ProviderType` rather than `string` so that the only remaining
   * question at this layer is whether an ADAPTER exists — a different question
   * with a different answer, and one the type system cannot settle.
   */
  readonly providerType: ProviderType;
  readonly baseUrl: string;
  readonly credentials?: PanelCredentialWrite;
  /**
   * The per-panel provider configuration, already parsed against this provider's own
   * schema. Absent means none was given, which is a legal panel that cannot yet be
   * provisioned onto — `decideOperability` answers `ACTIVATION_INCOMPLETE`.
   */
  readonly activation?: PanelActivation;
  /** Absent means uncapped, which is the honest default for a panel nobody has sized. */
  readonly maxServices?: number | null;
  readonly idempotencyKey: string;
}

export interface UpdatePanelCommand {
  /**
   * Absent means "leave it". Explicitly `| undefined` rather than just
   * optional, because `exactOptionalPropertyTypes` distinguishes a key that is
   * missing from one whose value is undefined — and the parsed request has the
   * latter. Two shapes that must agree is one shape too many.
   */
  readonly name?: string | undefined;
  readonly baseUrl?: string | undefined;
  /** Absent leaves it; `null` clears it; an object replaces it after validation. */
  readonly activation?: Record<string, unknown> | null | undefined;
  /** Absent leaves it; `null` removes the cap; a positive integer sets one. */
  readonly maxServices?: number | null | undefined;
  readonly idempotencyKey: string;
}

export interface PanelServiceDeps {
  readonly repository: PanelRepository;
  /**
   * How full each panel is. A SECOND repository, and deliberately so.
   *
   * Capacity counts rows in `services`, which belongs to provisioning. Teaching
   * `PanelRepository` to join it would give every panel read a dependency on the
   * commerce schema and would put the count one forgotten predicate away from
   * every listing. Composed here instead, in the one layer that is allowed to
   * know about both.
   */
  readonly capacity: PanelCapacityRepository;
  readonly credentials: PanelCredentialStore;
  readonly guard: PermissionGuard;
  /**
   * Whether this scope is still accepting work, read INSIDE the transaction.
   *
   * Settings, templates, feature flags and the ping recorder have all checked
   * this since Phase 2; the panels module did not, and that made it the one
   * place where a tenant an operator had STOPPED could still have panels
   * created, edited, re-credentialled and re-statused — writing audit,
   * idempotency and outbox rows for an installation somebody had already
   * switched off, and arming a background monitor to dial the machines of a
   * tenant this installation is no longer serving.
   *
   * A surface checks activity when the request arrives, which is a snapshot: a
   * stop can commit in between, answer the operator, and the write still land.
   * That is why this is read in the transaction and not in the controller.
   */
  readonly scopeActivity: ScopeActivityReader;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  /**
   * Which conditions are OPEN, read from the rows.
   *
   * Used to decide whether a recovery is worth recording at all. Recording one
   * unconditionally would announce "capacity is back" after every successful
   * connection test, including the thousands on installations that were never
   * limited — a recovery from nothing is not information.
   */
  readonly conditions: OperationalConditionReader;
  readonly sessions: SessionRepository;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly idempotency: IdempotencyStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly http: SafeHttpClient;
  readonly urlPolicy: UrlPolicyOptions;
  /**
   * Which adapter operates a provider type.
   *
   * Injected rather than imported so the scheduled prober in 3C composes the
   * same service without reaching around it, and so a test can drive the
   * service against a scripted outcome without patching a module binding. The
   * registry it is wired to refuses an unknown type; nothing here relaxes that.
   */
  readonly adapters: (type: ProviderType) => ProviderConnectionAdapter;
  /**
   * How long one panel's connection test occupies the panel, in milliseconds.
   *
   * A probe is an operator-triggered outbound request that logs into somebody
   * else's panel, so repeating it on a loop is two problems at once: it is a
   * way to sweep a network one panel edit at a time, and it is a way to lock
   * the provider account it authenticates against — several panel software
   * packages lock after a handful of failed logins.
   *
   * Long enough to stop a loop, short enough that an operator fixing a
   * credential does not wait on it. Within the window the stored result of the
   * last probe of the SAME configuration is what the caller gets back.
   */
  readonly probeCooldownMs: number;
  /**
   * The tenant-wide bound on real outbound probes, across every panel the
   * tenant has and every API process. See `PanelRepository.takeProbeBudget`.
   */
  readonly probeBudget: ProbeBudget;
  /**
   * The background monitor's cadence, which an operator's probe also writes.
   *
   * Here rather than only in the monitor because every probe stores when the
   * panel is next due, and a manual test is a real probe. Without it a
   * connection test would leave the schedule untouched and the monitor would
   * re-dial a panel that had just answered — against a rejected credential,
   * that is how a failed login becomes a lockout.
   */
  readonly cadence: MonitorCadence;
}

function hashRequest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Parse a request body against its contract schema.
 *
 * In the APPLICATION layer rather than the controller, which is this
 * codebase's convention and not an accident: a Telegram admin surface added
 * later reaches the same validation, so the two surfaces cannot drift into
 * accepting different things — which is exactly how the legacy system ended up
 * with four admin roles on one side and seven on the other.
 *
 * The issues are reported, so an operator learns which field was wrong. The
 * VALUES are not, because one of these bodies carries a password.
 */
function parseCommand<T>(
  schema: {
    safeParse: (value: unknown) => {
      success: boolean;
      data?: T;
      error?: { issues: readonly { path: readonly PropertyKey[]; message: string }[] };
    };
  },
  body: unknown,
): T {
  const result = schema.safeParse(body);
  if (!result.success || result.data === undefined) {
    throw errors.validation(PANEL_ERROR_CODES.PANEL_REQUEST_INVALID, 'The request is not valid.', {
      issues: (result.error?.issues ?? []).map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

/**
 * The activation an operator submitted, parsed against THIS provider's schema.
 *
 * Per provider, because the field set is: 3X-UI needs a subscription domain and an
 * inbound number, Marzban needs proxy protocols, and a value validated against the
 * union would let either panel be configured with the other's fields. The union exists
 * for reading a stored row; a WRITE knows which provider it is for and must use the
 * exact schema.
 *
 * Refused here rather than at the first provision, deliberately, for the reason create
 * already refuses a provider with no adapter: an operator who has just typed a
 * subscription domain should learn it is malformed now, not when a customer's paid
 * order stalls.
 */
function parseActivation(providerType: ProviderType, value: unknown): PanelActivation {
  return parseCommand<PanelActivation>(PANEL_ACTIVATION_SCHEMAS[providerType], value);
}

/** Which activation fields a stored row carries, for an audit entry. Never values. */
function activationKeys(activation: unknown): readonly string[] | null {
  if (typeof activation !== 'object' || activation === null || Array.isArray(activation)) {
    return null;
  }
  return Object.keys(activation as Record<string, unknown>).sort();
}

/**
 * Panels, providers and credentials.
 *
 * Authorization happens HERE, not in the controller. That is the codebase's
 * rule and it is what makes a Telegram admin surface added later unable to
 * reach a different answer — no endpoint is protected merely by the web app
 * not drawing a button for it.
 *
 * Three permissions, already in the frozen catalogue since Phase 0 and each
 * with a different blast radius: `panels.view` (LOW), `panels.edit` (HIGH) and
 * `panels.credentials.rotate` (CRITICAL). Replacing a credential is therefore a
 * different route from editing a name, and deliberately so — one endpoint
 * accepting both would have to hold the higher permission, and every rename
 * would need the right to rotate credentials.
 */
export class PanelService {
  constructor(private readonly deps: PanelServiceDeps) {}

  /**
   * The tenant, or a refusal.
   *
   * Every method starts here. A `SystemContext` reaching a panel operation is a
   * bug rather than a permission question — background work in 3C will carry a
   * tenant per panel — so it is refused with the same code a missing tenant
   * gets rather than being allowed to read across tenants.
   */
  private tenant(scope: ScopeContext): TenantContext {
    if (isSystemContext(scope)) {
      throw errors.validation(
        PLATFORM_ERROR_CODES.TENANT_CONTEXT_MISSING,
        'Panel operations are tenant-scoped.',
      );
    }
    return scope;
  }

  /**
   * Checks a permission BEFORE the transaction, and records the refusal.
   *
   * A plain `guard.check` here would refuse correctly and leave no audit row:
   * the DENIED row is written by `runAuthorizedMutation`'s catch, and an early
   * refusal never reaches it. A denied credential rotation would then leave
   * nothing behind at all, which is the opposite of what a CRITICAL permission
   * is for.
   *
   * The early check is not redundant with the one inside the transaction. It
   * governs two things that one cannot: the REPLAY path, which returns a live
   * panel view without ever opening a transaction, and the connection test,
   * which contacts the operator's panel before the transaction begins — a
   * permission checked after the side effect is not a permission check.
   */
  private async authorize(
    scope: ScopeContext,
    actor: ActorContext,
    permission: typeof PANELS_EDIT | typeof PANELS_CREDENTIALS_ROTATE,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, permission);
    } catch (error) {
      await recordMutationDenial(this.mutationDeps(), scope, actor, permission, denial, error);
      throw error;
    }
  }

  async list(
    scope: ScopeContext,
    actor: ActorContext,
    page: {
      limit?: number;
      cursor?: PanelCursor | null;
      /**
       * Which side of the archive. `LIVE` unless the caller asks otherwise, so
       * every existing reader keeps the working fleet it already had, and the
       * archive browser is the one place that opts in.
       */
      archived?: PanelArchiveScope;
    } = {},
  ): Promise<{ panels: PanelWithCapacity[]; nextCursor: PanelCursor | null }> {
    const tenant = this.tenant(scope);
    await this.deps.guard.check(scope, actor, PANELS_VIEW);
    const listed = await this.deps.repository.list(tenant, {
      archived: page.archived ?? 'LIVE',
      ...(page.limit === undefined ? {} : { limit: page.limit }),
      ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
    });
    return { panels: await this.withCapacity(tenant, listed.panels), nextCursor: listed.nextCursor };
  }

  async get(scope: ScopeContext, actor: ActorContext, panelId: string): Promise<PanelWithCapacity> {
    const tenant = this.tenant(scope);
    await this.deps.guard.check(scope, actor, PANELS_VIEW);
    return this.oneWithCapacity(tenant, await this.require(tenant, panelId));
  }

  /**
   * Attaches occupancy to a page of panels in ONE query, never one per row.
   *
   * The list is the place an N+1 would actually hurt: a fifty-panel page would
   * be a hundred and one round trips, and the count is two subqueries. A panel
   * whose capacity the batch did not return gets a zeroed one carrying its own
   * cap — which cannot happen, because the ids came from the same tenant's own
   * listing, and is written as an explicit floor rather than a `!` so that if it
   * ever does the page renders instead of throwing.
   */
  private async withCapacity(
    tenant: TenantContext,
    views: readonly PanelView[],
  ): Promise<PanelWithCapacity[]> {
    if (views.length === 0) return [];
    const now = this.deps.clock.now();
    const found = await this.deps.capacity.readMany(
      tenant,
      views.map((view) => view.panel.id),
      now,
    );
    return views.map((view) => ({
      ...view,
      capacity: found.get(view.panel.id) ?? capacityOf(view.panel.maxServices, 0, 0),
    }));
  }

  /** The same, for one panel. */
  private async oneWithCapacity(
    tenant: TenantContext,
    view: PanelView,
  ): Promise<PanelWithCapacity> {
    const [only] = await this.withCapacity(tenant, [view]);
    // Unreachable: `withCapacity` returns one entry per input and was given one.
    if (only === undefined) throw new Error('withCapacity dropped its only panel');
    return only;
  }

  /**
   * A panel id, or a refusal that is not a 500.
   *
   * `panels.id` is a `uuid` column, so a path segment that is not one reaches
   * PostgreSQL as `invalid input syntax for type uuid` — an unhandled error,
   * logged as an internal failure, answered as 500. `GET /panels/not-a-uuid`
   * did exactly that. A malformed identifier is a malformed request and says
   * nothing about what exists, so it is refused as one.
   *
   * Validated HERE rather than in the controller so a Telegram admin surface
   * added later inherits the rule instead of rediscovering it, which is the
   * same reason bodies are parsed in this layer.
   */
  private panelId(candidate: string): string {
    const parsed = uuidV7Schema.safeParse(candidate);
    if (!parsed.success) {
      throw errors.validation(
        PANEL_ERROR_CODES.PANEL_REQUEST_INVALID,
        'That is not a valid panel identifier.',
      );
    }
    return parsed.data;
  }

  /**
   * The panel, or NOT_FOUND.
   *
   * Another tenant's panel id produces exactly what a nonexistent one does. A
   * distinguishable "forbidden" would turn any id into an oracle for whether it
   * exists somewhere on the installation, and panel ids appear in URLs.
   */
  private async require(
    tenant: TenantContext,
    panelId: string,
    tx?: TransactionScope,
  ): Promise<PanelView> {
    const view = await this.deps.repository.find(tenant, this.panelId(panelId), tx);
    if (view === null) {
      throw errors.notFound(PANEL_ERROR_CODES.PANEL_NOT_FOUND, 'No such panel.');
    }
    return view;
  }

  /**
   * The base URL, checked against the policy before anything is stored.
   *
   * Refused at WRITE time rather than at probe time. The legacy bot accepted a
   * panel pointing at a provably unreachable host with a bogus token and said
   * `تبریک پنل شما با موفقیت اضافه گردید` (SOURCE_BUG-XUI-001); the operator
   * found out later, if at all. What is checked here is everything knowable
   * from the URL as written — scheme, embedded credentials, a literal address
   * this installation refuses. What is NOT checked is reachability, because a
   * panel that happens to be down must still be creatable.
   */
  private validateUrl(raw: string): string {
    const verdict = checkUrl(raw, this.deps.urlPolicy);
    if (!verdict.allowed) {
      // Both address refusals are PANEL_TARGET_BLOCKED: "this installation will
      // not call there" is the same answer to the operator whether the reason
      // is a metadata endpoint or Nexa's own data network, and a distinct code
      // would let a caller tell those apart by probing.
      const code =
        verdict.refusal === 'ADDRESS_NOT_ALLOWED' || verdict.refusal === 'INFRASTRUCTURE_TARGET'
          ? PANEL_ERROR_CODES.PANEL_TARGET_BLOCKED
          : PANEL_ERROR_CODES.PANEL_URL_INVALID;
      throw errors.validation(code, refusalMessage(verdict.refusal));
    }
    return verdict.url.toString();
  }

  /**
   * Refuse a credential the provider's declared shape cannot use.
   *
   * The descriptor was fetched and displayed and nothing acted on it, so a
   * Marzban panel accepted an API token: stored, encrypted, audited — and
   * ignored by `toProviderCredentials`, which reads only the fields the shape
   * names. Every subsequent connection test then answered "credentials
   * missing" about a credential the operator had just successfully saved.
   *
   * Enforced HERE rather than only in the form, because the form is not the
   * authority and an API client bypasses it entirely.
   */
  private assertCredentialsFitShape(
    providerType: string,
    credentials: {
      username?: string | null | undefined;
      password?: string | null | undefined;
      apiToken?: string | null | undefined;
    },
  ): void {
    const descriptor = providerDescriptor(providerType as ProviderType);
    if (descriptor === null) return;
    const shape = descriptor.credentialShape;
    for (const field of ['username', 'password', 'apiToken'] as const) {
      const value = credentials[field];
      // ABSENT leaves alone and NULL removes; neither asserts the credential
      // is usable, so only a real value is refused.
      if (value === undefined || value === null) continue;
      if (!shapeAcceptsCredential(shape, field)) {
        throw errors.validation(
          PANEL_ERROR_CODES.PANEL_CREDENTIAL_UNSUPPORTED,
          `This provider authenticates with ${shape}; ${field} would be stored and never used.`,
        );
      }
    }
  }

  async create(
    scope: ScopeContext,
    actor: ActorContext,
    input: unknown,
  ): Promise<{ view: PanelWithCapacity; replayed: boolean }> {
    const tenant = this.tenant(scope);
    /*
     * AUTHORIZE, then parse. The order is the audit trail.
     *
     * Every write on this service used to parse the body first, and a
     * `ZodError` is a 400 that never reaches the guard — so an authenticated
     * caller WITHOUT `panels.edit` who posted `{nonsense:true}` was answered
     * 400 and left no `access.permission_denied` row, while the same caller
     * posting a well-formed body was answered 403 and did. Measured: the
     * event count moved 18 to 18 for the malformed body and 18 to 20 for the
     * well-formed one. `access.permission_denied` is in
     * `MANAGEMENT_ONE_SHOT_CODES` because it is a security fact about people,
     * and it was suppressible by sending nonsense.
     *
     * The sibling control services already did it this way — settings,
     * features, templates and the notification test all authorize on the raw
     * value — so this is not a new rule, it is the one the panel service was
     * the last to follow. Its blast radius is why it is worth the five moves:
     * `panel.credentials.replace` is the CRITICAL permission in this module.
     */
    await this.authorize(scope, actor, PANELS_EDIT, {
      action: 'panel.create',
      entityType: 'Panel',
      entityId: null,
    });
    /*
     * And the CREDENTIALS permission too, on the raw body, when the request
     * carries credentials at all.
     *
     * The full check below needs `parsed.credentials`, so it necessarily runs
     * after the parse — which left the CRITICAL denial suppressible on this
     * route alone: an actor holding `panels.edit` but not
     * `panels.credentials.rotate` who posted credentials WITH a malformed
     * idempotency key was answered 400 and left no record, where the same body
     * with a valid key was answered 403 and left two. Measured, on the round
     * that claimed to have fixed all five sites.
     *
     * A structural look at the raw input is enough to close it and is all that
     * is available before parsing: the request either mentions credentials or
     * it does not. The check below stays, because "mentions" is not "carries"
     * — `{credentials: null}` mentions them and parses to `undefined` — and
     * refusing a caller who may not rotate is right either way.
     */
    if (typeof input === 'object' && input !== null && 'credentials' in input) {
      await this.authorize(scope, actor, PANELS_CREDENTIALS_ROTATE, {
        action: 'panel.create',
        entityType: 'Panel',
        entityId: null,
      });
    }
    const parsed = parseCommand(createPanelRequestSchema, input);
    const command: CreatePanelCommand = {
      name: parsed.name,
      providerType: parsed.providerType,
      baseUrl: parsed.baseUrl,
      ...(parsed.credentials === undefined
        ? {}
        : {
            credentials: {
              username: parsed.credentials.username,
              password: parsed.credentials.password,
              apiToken: parsed.credentials.apiToken,
            },
          }),
      ...(parsed.activation === undefined || parsed.activation === null
        ? {}
        : { activation: parseActivation(parsed.providerType, parsed.activation) }),
      ...(parsed.maxServices === undefined ? {} : { maxServices: parsed.maxServices }),
      idempotencyKey: parsed.idempotencyKey,
    };
    // Two different refusals, and the difference is the operator's next move.
    //
    // A string that is not a provider type at all never gets here: the contract
    // schema enumerates them, so `parseCommand` above has already refused it and
    // named `providerType` as the offending field. What DOES get here is a type
    // the contracts declare and this release has no adapter for — `sanaei`
    // today — and refusing it at CREATE time rather than at the first probe is
    // the point. The legacy bot let an operator configure a panel it could
    // never talk to and told them it had succeeded (SOURCE_BUG-XUI-001); a
    // panel that cannot be operated should not become a row.
    //
    // This also closes the loop the registry opens: no persisted provider
    // string can name an adapter that does not exist, because the adapter is
    // resolved before the row is written and again before it is used.
    const providerType: ProviderType = command.providerType;
    this.deps.adapters(providerType);
    const baseUrl = this.validateUrl(command.baseUrl);

    /**
     * Initial credentials need the CREDENTIAL permission, not just the edit one.
     *
     * `setCredentials` is guarded by `panels.credentials.rotate`, which is
     * CRITICAL and deliberately separate from `panels.edit`. Create wrote
     * `command.credentials` under `panels.edit` alone, so an actor who is
     * refused when replacing a panel's password could set one by creating a
     * panel — the same secret, in the same column, through the door beside the
     * locked one. A permission boundary that one endpoint enforces and another
     * does not is not a boundary.
     *
     * Only when the request actually carries credentials: creating a panel and
     * leaving its credentials for somebody who holds the permission stays a
     * `panels.edit` operation.
     *
     * The check itself is now ABOVE, on the raw body, and there is no second
     * copy of it here. There was one for a round, kept on the stated ground
     * that "'mentions' is not 'carries' — `{credentials: null}` mentions them
     * and parses to `undefined`". That is false:
     * `panelCredentialsInputSchema.optional()` admits `undefined` and not
     * `null`, so `{credentials: null}` is a `ZodError` and never reaches this
     * line. And `parsed.credentials !== undefined` can only be true when
     * `'credentials' in input` was true, so the second guard was unreachable
     * as a gate — measured: deleting it left the whole integration suite
     * green. It cost one extra permission resolution per credentials-bearing
     * create by a permitted caller, and a false sentence defending it.
     */

    // AFTER the authorization, deliberately.
    //
    // A caller without `panels.edit` must get the denial — with its audit row
    // and its operational event — rather than a validation error that tells
    // them which credentials this provider accepts. The adapter and URL checks
    // above predate this rule and are about whether the REQUEST is coherent at
    // all; this one is about the content of a write the caller may not make.
    if (parsed.credentials !== undefined) {
      this.assertCredentialsFitShape(parsed.providerType, parsed.credentials);
    }

    // The credentials are NOT in the hash. Two creates with the same key and
    // different passwords must not be treated as different requests — that
    // would defeat the replay — and hashing a secret puts a value derived from
    // it in a table nothing else protects.
    /*
     * `activation` is in the hash because create now ACCEPTS it.
     *
     * The update path has carried it since activation became writable there; create
     * gained the field in this phase and its hash was not widened with it. That left
     * the replay check unable to tell two different requests apart: the same
     * idempotency key with a different `subscriptionDomain` or `inboundId` matched the
     * first request's hash, so the second was answered with the first panel and
     * reported as a success having written nothing of what it asked for — and the
     * panel then provisioned against an activation its operator had tried to replace.
     * That is the legacy system's "re-adding an admin returns success and writes
     * nothing", which the comment on the update path already names.
     */
    const requestHash = hashRequest({
      name: command.name,
      providerType,
      baseUrl,
      activation: command.activation,
    });
    const existing = await this.deps.idempotency.find<{ panelId: string }>(
      scope,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (existing) {
      return { view: await this.oneWithCapacity(tenant, await this.require(tenant, existing.result.panelId)), replayed: true };
    }

    const panelId = this.deps.ids.uuid();
    const now = this.deps.clock.now();
    const denial = { action: 'panel.create', entityType: 'Panel', entityId: null };

    try {
      await runAuthorizedMutation(
        this.mutationDeps(),
        scope,
        actor,
        PANELS_EDIT,
        denial,
        async (tx) => {
          await this.requireActiveScope(scope, tx);
          /*
           * The CRITICAL permission, re-checked INSIDE the transaction like the
           * edit permission above it. `runAuthorizedMutation` re-runs only the
           * one permission it is handed, so until the final Phase 3D review a
           * create that carried credentials re-checked `panels.edit` here and
           * `panels.credentials.rotate` only on the pool, before the
           * transaction: an administrator whose rotate permission was revoked
           * between that early check and this commit still stored a credential,
           * where `setCredentials` under the same interleaving was refused.
           * Checked before anything is written, so a refusal rolls back a
           * transaction that has done nothing.
           */
          if (command.credentials !== undefined) {
            await this.deps.guard.check(scope, actor, PANELS_CREDENTIALS_ROTATE, tx);
          }
          if (await this.deps.repository.nameTaken(tenant, command.name, null, tx)) {
            throw errors.conflict(
              PANEL_ERROR_CODES.PANEL_NAME_TAKEN,
              'Another panel of this tenant already uses that name.',
            );
          }
          await this.deps.repository.create(
            tenant,
            {
              id: panelId,
              name: command.name,
              providerType,
              baseUrl,
              ...(command.activation === undefined ? {} : { activation: command.activation }),
              ...(command.maxServices === undefined ? {} : { maxServices: command.maxServices }),
              at: now,
            },
            tx,
          );
          // The schedule row is born with the panel and in the same transaction.
          // A panel with no schedule row is a panel the monitor cannot see, and
          // "create the row lazily when the monitor first meets it" is how a
          // panel goes unmonitored until somebody notices.
          await this.deps.repository.setScheduleEligibility(
            tenant,
            panelId,
            'ELIGIBLE_NOW',
            now,
            tx,
          );
          if (command.credentials !== undefined) {
            await this.deps.credentials.write(tenant, panelId, command.credentials, now, tx);
          }
          await this.deps.audit.record(
            scope,
            actor,
            {
              action: 'panel.create',
              entityType: 'Panel',
              entityId: panelId,
              before: null,
              // Safe fields only. `configured` names WHICH credential kinds were
              // supplied and never what they were — an audit entry that recorded
              // the value would be the legacy web admin's cleartext readback
              // with a timestamp on it.
              //
              // The field is `configured` and not `credentialsSet` for a reason
              // worth keeping: the audit writer redacts any key containing
              // `credential`, so the more obvious name made this entry read
              // `[redacted]` and the audit lost the one fact it was recording.
              // The fix is the name, never the redactor — a key that looks like
              // it holds a credential SHOULD be redacted, because the next author
              // to add one will not be as careful as this one. `configured` is
              // also the word the API's own credential state uses, so the two
              // surfaces say the same thing.
              after: {
                name: command.name,
                providerType,
                baseUrl,
                // The FIELD NAMES only, never their values. A subscription domain is
                // not a secret, but an audit entry is a projection an operator reads
                // at a glance and the question it answers here is "was this panel
                // given its provider configuration", not "what is in it" — the panel
                // read already answers that, under the same permission.
                activation:
                  command.activation === undefined ? null : Object.keys(command.activation).sort(),
                configured: credentialKindsIn(command.credentials),
              },
              result: 'SUCCESS',
            },
            tx,
          );
          await rememberOnce(
            this.deps.idempotency,
            scope,
            actor.surface,
            command.idempotencyKey,
            requestHash,
            { panelId },
            tx,
          );
        },
      );
    } catch (error) {
      // `runAuthorizedMutation` recorded an EDIT denial; this records a ROTATE
      // one. Each recorder writes only for the permission it is handed, so a
      // refusal is recorded exactly once whichever permission refused it.
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        PANELS_CREDENTIALS_ROTATE,
        denial,
        error,
      );
      throw error;
    }

    return { view: await this.oneWithCapacity(tenant, await this.require(tenant, panelId)), replayed: false };
  }

  async update(
    scope: ScopeContext,
    actor: ActorContext,
    panelId: string,
    input: unknown,
  ): Promise<PanelWithCapacity> {
    const tenant = this.tenant(scope);
    // Authorize, then parse — see `create`.
    await this.authorize(scope, actor, PANELS_EDIT, {
      action: 'panel.update',
      entityType: 'Panel',
      entityId: panelId,
    });
    const command: UpdatePanelCommand = parseCommand(updatePanelRequestSchema, input);
    const baseUrl = command.baseUrl === undefined ? undefined : this.validateUrl(command.baseUrl);
    /*
     * In the hash, because it is part of what the request asks for.
     *
     * Two edits with one key and different activations must not be treated as the same
     * request — the second would replay the first and report success having written
     * nothing, which is the legacy system's "re-adding an admin returns success and
     * writes nothing" in another column.
     */
    const requestHash = hashRequest({
      panelId,
      name: command.name,
      baseUrl,
      activation: command.activation,
    });
    const existing = await this.deps.idempotency.find<{ panelId: string }>(
      scope,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (existing) return this.oneWithCapacity(tenant, await this.require(tenant, panelId));

    const now = this.deps.clock.now();
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PANELS_EDIT,
      { action: 'panel.update', entityType: 'Panel', entityId: panelId },
      async (tx) => {
        await this.requireActiveScope(scope, tx);
        // Validated BEFORE the lock, which is now the first statement to touch
        // the database: a malformed identifier would otherwise reach a `uuid`
        // column and come back as 22P02 — a 500 where this has always answered
        // a validation error. `require` below validated it incidentally when it
        // was the first read; the rule is explicit now that it is not.
        await this.deps.repository.lockPanel(tenant, this.panelId(panelId), tx);
        const before = await this.require(tenant, panelId, tx);
        if (before.panel.status === 'ARCHIVED') {
          throw errors.preconditionFailed(
            PANEL_ERROR_CODES.PANEL_ARCHIVED,
            'This panel is archived. Restore it before editing.',
          );
        }
        if (
          command.name !== undefined &&
          (await this.deps.repository.nameTaken(tenant, command.name, panelId, tx))
        ) {
          throw errors.conflict(
            PANEL_ERROR_CODES.PANEL_NAME_TAKEN,
            'Another panel of this tenant already uses that name.',
          );
        }
        const changes: {
          name?: string;
          baseUrl?: string;
          activation?: PanelActivation | null;
          maxServices?: number | null;
        } = {};
        if (command.name !== undefined) changes.name = command.name;
        if (baseUrl !== undefined) changes.baseUrl = baseUrl;
        /*
         * Accepted WHATEVER the panel's current usage is, deliberately.
         *
         * Lowering a cap below the services already on the panel refuses new
         * sales and terminates nothing — `panels.max_services` says why, and
         * `decideEligibility` is where the refusal happens. Validating "the cap
         * must be at least the current usage" here would be the tempting rule
         * and the wrong one: it would leave an operator whose panel is over its
         * intended size unable to express the intention at all, and the only
         * remaining way to stop that panel selling would be `DISABLED`, which
         * also stops the monitor watching a machine that is carrying customers.
         */
        if (command.maxServices !== undefined) changes.maxServices = command.maxServices;
        if (command.activation !== undefined) {
          /*
           * Parsed against the STORED provider type, which is why this is here and not
           * beside the name check above.
           *
           * `updatePanelRequestSchema` carries no `providerType` — changing one is
           * forbidden because it would reinterpret the stored credentials against a
           * different protocol — so the only truthful source is the row itself, read
           * under the lock this transaction already holds.
           */
          changes.activation =
            command.activation === null
              ? null
              : parseActivation(before.panel.providerType, command.activation);
        }

        // An edit that changes nothing is a no-op, not a cheap way to force a
        // probe. The frozen request schema permits a body carrying only an
        // idempotency key, and this used to advance `updated_at`, make the
        // panel immediately probe-eligible and record a successful update — so
        // repeated empty edits with fresh keys drove background probes at the
        // caller's chosen rate and filled the audit trail with changes that
        // never happened. The request still succeeds and is still remembered;
        // it simply does nothing, which is what it asked for.
        if (Object.keys(changes).length === 0) {
          await rememberOnce(
            this.deps.idempotency,
            scope,
            actor.surface,
            command.idempotencyKey,
            requestHash,
            { panelId },
            tx,
          );
          return;
        }

        const updated = await this.deps.repository.update(tenant, panelId, changes, now, tx);
        if (updated === null) {
          throw errors.notFound(PANEL_ERROR_CODES.PANEL_NOT_FOUND, 'No such panel.');
        }
        // An edit makes the panel due immediately. Whatever the monitor had
        // decided was about a configuration that no longer exists — and an
        // operator who has just corrected an address should not wait out a
        // backoff the correction invalidated.
        await this.deps.repository.setScheduleEligibility(tenant, panelId, 'ELIGIBLE_NOW', now, tx);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'panel.update',
            entityType: 'Panel',
            entityId: panelId,
            // Field names only, for the reason `panel.create` states.
            before: {
              name: before.panel.name,
              baseUrl: before.panel.baseUrl,
              activation: activationKeys(before.panel.activation),
              /*
               * The VALUE, unlike `activation` beside it.
               *
               * A cap is one integer that decides whether a tenant can sell, and
               * "maxServices changed" tells an operator investigating a silent
               * catalogue nothing they can act on. The argument for field names
               * only is that the value is a credential or is readable from the
               * panel read; neither holds here, and the number is precisely what
               * somebody reconstructing "why did this stop selling at 14:02"
               * needs.
               */
              maxServices: before.panel.maxServices,
            },
            after: {
              name: updated.name,
              baseUrl: updated.baseUrl,
              activation: activationKeys(updated.activation),
              maxServices: updated.maxServices,
            },
            result: 'SUCCESS',
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          command.idempotencyKey,
          requestHash,
          { panelId },
          tx,
        );
      },
    );
    return this.oneWithCapacity(tenant, await this.require(tenant, panelId));
  }

  /**
   * Replace or remove credentials. The CRITICAL permission.
   *
   * The write shape distinguishes three things and the difference between the
   * first two is the whole reason this endpoint exists separately: a field that
   * is ABSENT is left alone, a field that is NULL is removed, and a field with
   * a value is replaced. An operator editing a panel's name must not erase its
   * password by not mentioning it.
   */
  async setCredentials(
    scope: ScopeContext,
    actor: ActorContext,
    panelId: string,
    input: unknown,
  ): Promise<PanelWithCapacity> {
    const tenant = this.tenant(scope);
    // Authorize, then parse — see `create`. This is the CRITICAL permission in
    // this module, and it was the one a malformed body could probe silently.
    await this.authorize(scope, actor, PANELS_CREDENTIALS_ROTATE, {
      action: 'panel.credentials.replace',
      entityType: 'Panel',
      entityId: panelId,
    });
    const parsed = parseCommand(setPanelCredentialsRequestSchema, input);
    const write: PanelCredentialWrite = {
      username: parsed.credentials.username,
      password: parsed.credentials.password,
      apiToken: parsed.credentials.apiToken,
    };
    const idempotencyKey = parsed.idempotencyKey;
    // The KINDS being written, never the values. A request hash computed over
    // a password would put a value derived from it in the idempotency table,
    // and would make an operator who retyped the same password look like a
    // replay of a different request.
    const requestHash = hashRequest({ panelId, kinds: credentialKindsIn(write) });
    const existing = await this.deps.idempotency.find<{ panelId: string }>(
      scope,
      actor.surface,
      idempotencyKey,
      requestHash,
    );
    if (existing) return this.oneWithCapacity(tenant, await this.require(tenant, panelId));

    const now = this.deps.clock.now();
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PANELS_CREDENTIALS_ROTATE,
      { action: 'panel.credentials.replace', entityType: 'Panel', entityId: panelId },
      async (tx) => {
        await this.requireActiveScope(scope, tx);
        // Validated BEFORE the lock, which is now the first statement to touch
        // the database: a malformed identifier would otherwise reach a `uuid`
        // column and come back as 22P02 — a 500 where this has always answered
        // a validation error. `require` below validated it incidentally when it
        // was the first read; the rule is explicit now that it is not.
        await this.deps.repository.lockPanel(tenant, this.panelId(panelId), tx);
        const before = await this.require(tenant, panelId, tx);
        if (before.panel.status === 'ARCHIVED') {
          throw errors.preconditionFailed(
            PANEL_ERROR_CODES.PANEL_ARCHIVED,
            'This panel is archived. Restore it before changing its credentials.',
          );
        }
        // The panel's OWN provider decides which credentials it can use, so
        // this is checked here rather than on the request: the request names a
        // panel, not a provider. Inside the lock, against the row just read.
        this.assertCredentialsFitShape(before.panel.providerType, write);
        await this.deps.credentials.write(tenant, panelId, write, now, tx);
        // Same rule as an edit, and this is the case that matters most: an
        // operator replacing a rejected password wants to know whether it
        // worked, not to wait out the long non-retryable backoff the rejection
        // earned. It also clears a `CREDENTIALS_MISSING` deferral.
        await this.deps.repository.setScheduleEligibility(tenant, panelId, 'ELIGIBLE_NOW', now, tx);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'panel.credentials.replace',
            entityType: 'Panel',
            entityId: panelId,
            // WHICH credentials changed, never what they changed from or to.
            // "Replaced" and "removed" are distinguished because they are
            // different operational facts; the values are not recorded at all.
            before: null,
            after: {
              replaced: credentialKindsIn(write, (value) => typeof value === 'string'),
              removed: credentialKindsIn(write, (value) => value === null),
            },
            result: 'SUCCESS',
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          idempotencyKey,
          requestHash,
          { panelId },
          tx,
        );
      },
    );
    return this.oneWithCapacity(tenant, await this.require(tenant, panelId));
  }

  /**
   * Says the probe limit has ended — but only if it had begun.
   *
   * Read from the ROWS rather than recorded unconditionally. A recovery after
   * every successful connection test would be a "capacity is back" on
   * installations that were never short of it, and the row's occurrence count
   * would climb for ever on the strength of nothing happening.
   */
  private async resolveProbeLimit(
    scope: ScopeContext,
    tenant: TenantContext,
    tx: TransactionScope,
  ): Promise<void> {
    const limited = await this.deps.conditions.tenantConditionIsOpen(
      tenant.tenantId,
      PROBE_LIMITED_CODE,
      tx,
    );
    if (!limited) return;
    await this.deps.opsLog.record(
      scope,
      {
        code: PROBE_LIMITED_OK_CODE,
        severity: 'INFO',
        message:
          'Panel connection tests are being served again: this tenant has outbound-probe capacity.',
        dedupeKey: PROBE_LIMITED_OK_CODE,
        recoversCode: PROBE_LIMITED_CODE,
        recoversDedupeKey: PROBE_LIMITED_CODE,
      },
      tx,
    );
  }

  async setStatus(
    scope: ScopeContext,
    actor: ActorContext,
    panelId: string,
    input: unknown,
  ): Promise<PanelWithCapacity> {
    const tenant = this.tenant(scope);
    // Authorize, then parse — see `create`.
    await this.authorize(scope, actor, PANELS_EDIT, {
      action: 'panel.status',
      entityType: 'Panel',
      entityId: panelId,
    });
    const parsed = parseCommand(setPanelStatusRequestSchema, input);
    const status: PanelStatus = parsed.status;
    const idempotencyKey = parsed.idempotencyKey;
    // The name is in the hash ONLY when it is present. Adding `name: null` to
    // every command would have changed the hash of an ordinary status change
    // across the release boundary, so a key minted before the update and
    // replayed after it — which is exactly what `settleOn` holds a key for
    // across a rolling restart's 5xx — would come back as a payload mismatch
    // rather than as the replay it is.
    const requestHash = hashRequest({
      panelId,
      status,
      ...(parsed.name === undefined ? {} : { name: parsed.name }),
    });
    const existing = await this.deps.idempotency.find<{ panelId: string }>(
      scope,
      actor.surface,
      idempotencyKey,
      requestHash,
    );
    if (existing) return this.oneWithCapacity(tenant, await this.require(tenant, panelId));

    const now = this.deps.clock.now();
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PANELS_EDIT,
      { action: 'panel.status', entityType: 'Panel', entityId: panelId },
      async (tx) => {
        await this.requireActiveScope(scope, tx);
        // Validated BEFORE the lock, which is now the first statement to touch
        // the database: a malformed identifier would otherwise reach a `uuid`
        // column and come back as 22P02 — a 500 where this has always answered
        // a validation error. `require` below validated it incidentally when it
        // was the first read; the rule is explicit now that it is not.
        await this.deps.repository.lockPanel(tenant, this.panelId(panelId), tx);
        const before = await this.require(tenant, panelId, tx);
        const leavingArchive = before.panel.status === 'ARCHIVED' && status !== 'ARCHIVED';

        /**
         * A name may travel with a restore, and ONLY with a restore.
         *
         * `panels_tenant_name_live_key` is UNIQUE `(tenant_id, name) WHERE
         * status <> 'ARCHIVED'`. Archiving therefore RELEASES the name, another
         * panel may take it, and restoring puts the old row back under that
         * partial index — a 23505 nobody modelled, on a request that had no
         * name check at all. `update` refuses every edit to an archived panel,
         * so the operator could not rename it out of the way either: the panel
         * was unrestorable by any sequence of requests.
         *
         * Refused outside that transition rather than ignored, because a
         * silently dropped rename is a write the operator believes happened.
         */
        if (parsed.name !== undefined && !leavingArchive) {
          throw errors.validation(
            PANEL_ERROR_CODES.PANEL_REQUEST_INVALID,
            'A replacement name is accepted only when restoring an archived panel.',
            { status, from: before.panel.status },
          );
        }

        const restoredName = parsed.name ?? before.panel.name;
        /**
         * Checked HERE, inside the lock, for the transition that re-enters the
         * index — including the plain restore that carries no new name, which
         * is exactly the case that used to reach PostgreSQL as a raw conflict.
         */
        if (
          leavingArchive &&
          (await this.deps.repository.nameTaken(tenant, restoredName, panelId, tx))
        ) {
          throw errors.conflict(
            PANEL_ERROR_CODES.PANEL_NAME_TAKEN,
            parsed.name === undefined
              ? 'Another panel took this name while it was archived. Restore it under a different name.'
              : // Still actionable. The first refusal tells the operator to pick
                // another name; answering the second with the generic edit
                // message dropped the remedy at exactly the point they were
                // acting on it, and left the screen saying nothing about what
                // to do next.
                'Another panel is using that name. Choose a different one to restore this panel under.',
          );
        }

        /*
         * ENABLING is the act that puts a panel in front of customers, and it
         * needs a connection test that vouches for what the panel is NOW.
         *
         * Only on the transition INTO `ACTIVE` from something else. Re-saving
         * `ACTIVE` on an already-active panel is not an enable and must not
         * demand a fresh test — a panel that has been serving for a month would
         * otherwise be un-re-confirmable, and an operator would have to probe it
         * to leave it exactly as it was.
         *
         * `validationAuthorisesEnable` is three conditions, and the identity one
         * is the point: a green test taken before a password was replaced proves
         * the OLD password worked. Without it, the ordinary sequence "test, find
         * the password wrong, fix it, enable" would enable on the strength of the
         * test that preceded the fix.
         *
         * The check reads `before`, which was read under the lock this
         * transaction holds — so a probe cannot land between the decision and the
         * write, in either direction.
         */
        if (status === 'ACTIVE' && before.panel.status !== 'ACTIVE') {
          const identity = connectionIdentityOf({
            providerType: before.panel.providerType,
            baseUrl: before.panel.baseUrl,
            activation: before.panel.activation,
            usernameSetAt: before.credentials.usernameSetAt,
            passwordSetAt: before.credentials.passwordSetAt,
            apiTokenSetAt: before.credentials.apiTokenSetAt,
          });
          if (!validationAuthorisesEnable(before.health, identity, now)) {
            throw errors.preconditionFailed(
              PANEL_ERROR_CODES.PANEL_NOT_VALIDATED,
              'Run a connection test on this panel and let it succeed before enabling it.',
            );
          }
        }

        // Name and status in ONE statement. Renaming afterwards would first
        // make the row live under the name somebody else took, and the partial
        // unique index refuses that before the rename can run — so the two-step
        // version could not restore the very panels it was written for.
        const updated = await this.deps.repository.setStatus(
          tenant,
          panelId,
          status,
          now,
          tx,
          parsed.name,
        );
        if (updated === null) {
          throw errors.notFound(PANEL_ERROR_CODES.PANEL_NOT_FOUND, 'No such panel.');
        }
        // This is the monitor's status filter, and it is why the discovery scan
        // needs no status predicate to be correct: a panel that is not ACTIVE
        // becomes eligible at `'infinity'`, in the same transaction as the
        // status change, so it is not skipped by the scan — it is outside the
        // range the scan reads. Re-enabling makes it due at once.
        await this.deps.repository.setScheduleEligibility(
          tenant,
          panelId,
          status === 'ACTIVE' ? 'ELIGIBLE_NOW' : 'SUSPENDED',
          now,
          tx,
        );
        if (before.panel.status === 'ARCHIVED' && status !== 'ARCHIVED') {
          // Any transition OUT of ARCHIVED, not only the one to ACTIVE.
          //
          // Retirement is not permanent, so its row must not be, and nothing in
          // the health transitions names `panel.health.retired` — so if this
          // does not fire the row stays open for the life of the installation,
          // unresolvable, with no path that can ever close it.
          //
          // It was `status === 'ACTIVE'` and that was wrong the moment the Web
          // Admin gained a restore control, because restoring returns a panel
          // to DISABLED rather than resuming probes: the retirement went
          // unclosed, and the later DISABLED -> ACTIVE step saw a `before` that
          // was no longer ARCHIVED and did not close it either. The
          // installation then monitored a panel whose operations log said it
          // was archived and unmonitored, which is the exact state
          // `RESTORED_CODE` exists to prevent.
          await this.deps.opsLog.record(
            scope,
            {
              code: RESTORED_CODE,
              severity: 'INFO',
              // What the status now IS, because a restore may land on DISABLED
              // and "monitored again" would then be false.
              // `updated.name`, not `before.panel.name`. A restore may carry a
              // replacement name BECAUSE the old one now belongs to a
              // different, live panel — so the previous spelling wrote a log
              // line naming somebody else's machine, which an operator reading
              // it later would resolve to the wrong one.
              message:
                status === 'ACTIVE'
                  ? `Panel "${updated.name}" was restored and is monitored again.`
                  : `Panel "${updated.name}" was restored from the archive and is ${status.toLowerCase()}.`,
              // No dedupe key: see `RESTORED_CODE`. This closes the
              // retirement and keeps no row of its own to be closed later.
              recoversCode: RETIRED_CODE,
              recoversDedupeKey: panelConditionKey(RETIRED_CODE, panelId),
              // The name it has AFTER the transition, not before it. A restore
              // may carry a replacement name precisely because the old one now
              // belongs to a different, live panel — so logging `before` here
              // wrote a row naming somebody else's machine.
              context: { panelId, panelName: updated.name },
            },
            tx,
          );
        }
        if (status === 'ARCHIVED') {
          // Archiving is retirement, and a retired panel can never produce a
          // recovery: nothing probes it again. Whatever condition the monitor
          // had open — unreachable, a rejected credential — would stay open for
          // ever, an ERROR in the operations view about a machine nobody
          // operates and which no action can clear.
          //
          // DISABLED deliberately gets none of this. That is temporary, the
          // panel is coming back, and the condition it left open is still true.
          await this.deps.opsLog.record(
            scope,
            {
              code: RETIRED_CODE,
              severity: 'INFO',
              message: `Panel "${before.panel.name}" was archived and is no longer monitored.`,
              dedupeKey: panelConditionKey(RETIRED_CODE, panelId),
              // Closes whichever health row this panel has open: its condition,
              // or — when it was healthy — its own recovery row, which is a row
              // about a panel that no longer exists either. A previous
              // restoration is closed by the archive that follows it, below.
              ...closesPanelCondition(panelId, before.health),
              context: {
                panelId,
                panelName: before.panel.name,
                providerType: before.panel.providerType,
              },
            },
            tx,
          );
        }
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'panel.status',
            entityType: 'Panel',
            entityId: panelId,
            // The NAME is in here because a restore may change it, and an
            // audit row that records only the status leaves the one write an
            // operator would later need to explain — who renamed this panel,
            // and from what — recorded nowhere at all. `panel.update` has
            // always carried both sides; this path could not change a name
            // until now, and now it can.
            before: { status: before.panel.status, name: before.panel.name },
            after: { status: updated.status, name: updated.name },
            result: 'SUCCESS',
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          idempotencyKey,
          requestHash,
          { panelId },
          tx,
        );
      },
    );
    return this.oneWithCapacity(tenant, await this.require(tenant, panelId));
  }

  /**
   * Probe a panel on an operator's explicit request.
   *
   * Deliberately runs against a DISABLED panel. An operator disables a panel
   * precisely because something is wrong with it, and "you may not test this
   * until you re-enable it" would make them re-enable a panel to find out
   * whether they should. An ARCHIVED panel is refused: archiving means finished.
   *
   * The probe is OUTSIDE the transaction and the result is written inside a
   * second one. A network call inside a transaction holds a database
   * connection for the length of somebody else's timeout, which at pool
   * exhaustion is an outage caused by a panel being slow.
   */
  async testConnection(
    scope: ScopeContext,
    actor: ActorContext,
    panelId: string,
    input: unknown,
  ): Promise<{ view: PanelWithCapacity; probed: boolean }> {
    const tenant = this.tenant(scope);
    // Authorize, then parse — see `create`.
    await this.authorize(scope, actor, PANELS_EDIT, {
      action: 'panel.test',
      entityType: 'Panel',
      entityId: panelId,
    });
    const idempotencyKey = parseCommand(testPanelRequestSchema, input).idempotencyKey;

    // A stopped tenant's panels are not dialled, on either lane. The monitor
    // refuses them in `claimTenants`; this is the operator's lane, and a probe
    // it runs reaches somebody else's machine just as surely.
    //
    // Read WITHOUT a transaction here because there is none yet: this check is
    // BEFORE the socket, which is the point of it. It is a snapshot, and the
    // write this path performs is checked again inside its own transaction
    // below — the first draft of this said "this path has none to join", which
    // was simply false, and would have let a probe that started before a stop
    // commit a health row, a schedule, an audit row and an idempotency row
    // afterwards.
    if (!(await this.deps.scopeActivity.scopeIsActive(scope))) {
      throw errors.notFound(
        PLATFORM_ERROR_CODES.TENANT_NOT_FOUND,
        'This scope is not accepting work.',
      );
    }

    const requestHash = hashRequest({ panelId, operation: 'test' });
    const existing = await this.deps.idempotency.find<{ panelId: string }>(
      scope,
      actor.surface,
      idempotencyKey,
      requestHash,
    );
    if (existing) return { view: await this.oneWithCapacity(tenant, await this.require(tenant, panelId)), probed: false };

    const before = await this.require(tenant, panelId);

    // The one implementation, shared with the background monitor. Everything
    // that makes a probe safe — credential resolution, adapter selection, the
    // address policy, the per-panel claim, the tenant budget, the
    // normalization of the answer — happens in `probe-core`, so there is
    // exactly one of each rule and both callers get every fix.
    //
    // What is left here is what an operator's probe genuinely adds: an
    // idempotency key, an audit row, and a refusal turned into an HTTP-shaped
    // error the Web Admin can render.
    const attempt = await attemptProbe(this.probeDeps(), tenant, before, {
      // A DISABLED panel is testable on request. An operator disables a panel
      // precisely because something is wrong with it, and "you may not test
      // this until you re-enable it" would make them re-enable a panel to find
      // out whether they should. The monitor passes ACTIVE only.
      probeableStatuses: ['ACTIVE', 'DISABLED'],
      // No reserve: an operator may spend their tenant's capacity down to
      // nothing. The reserve exists to keep the monitor from doing that TO
      // them.
      budgetReserve: 0,
    });

    if (!attempt.probed) {
      const refusal = attempt.refusal;
      if (refusal.kind === 'STATUS_NOT_PROBEABLE') {
        // ARCHIVED is the only status this caller excluded.
        throw errors.preconditionFailed(
          PANEL_ERROR_CODES.PANEL_ARCHIVED,
          'This panel is archived. Restore it before testing it.',
        );
      }
      if (refusal.kind === 'CREDENTIALS_MISSING') {
        throw errors.preconditionFailed(
          PANEL_ERROR_CODES.PANEL_CREDENTIALS_MISSING,
          'This panel has no credentials configured. Set them before testing the connection.',
        );
      }
      if (refusal.kind === 'CAPABILITY_UNSUPPORTED') {
        // Named, rather than silently folded into the cooldown case below.
        // Vacuous today — both registered providers declare `HEALTH_CHECK` — but
        // before this branch existed the refusal reached the `return` at the end
        // of this block, so the operator pressed Test connection and got a 200
        // with `probed: false` and no explanation at all.
        //
        // The CAPABILITY is named and nothing else is: it is a property of this
        // release's adapter, not of the operator's panel, so there is nothing
        // here for them to fix and the message says so.
        throw errors.preconditionFailed(
          PANEL_ERROR_CODES.PANEL_CAPABILITY_UNSUPPORTED,
          'This release cannot check the health of this provider. Nothing was contacted and the panel is unchanged.',
        );
      }
      if (refusal.kind === 'TARGET_BLOCKED') {
        throw errors.validation(
          PANEL_ERROR_CODES.PANEL_TARGET_BLOCKED,
          refusalMessage(refusal.refusal),
        );
      }
      if (refusal.kind === 'BUDGET_EXHAUSTED') {
        const retryAfterSeconds = Math.max(1, Math.ceil(refusal.retryAfterMs / 1000));
        // One deduplicated operational event per tenant, not one row per
        // refused request: a limiter that is being leaned on would otherwise
        // fill the operations view with the thing it is preventing.
        await this.deps.opsLog.record(scope, {
          code: PROBE_LIMITED_CODE,
          severity: 'WARN',
          message:
            'Panel connection tests are being refused: this tenant has used its outbound-probe capacity.',
          dedupeKey: PROBE_LIMITED_CODE,
          // Closes the recovery this contradicts, so the next one is a
          // recovery in its own right rather than a count on a stale row.
          recoversCode: PROBE_LIMITED_OK_CODE,
          recoversDedupeKey: PROBE_LIMITED_OK_CODE,
          context: { retryAfterSeconds },
        });
        // A RATE_LIMITED error carrying when to retry and nothing about any
        // target, counter or network.
        throw new NexaError({
          kind: 'RATE_LIMITED',
          code: PANEL_ERROR_CODES.PANEL_PROBE_LIMITED,
          message: 'Too many connection tests for this tenant. Try again later.',
          details: { retryAfterSeconds },
        });
      }
      if (refusal.kind !== 'COOLDOWN') {
        /*
         * Every refusal kind is handled above, and this is what keeps that true.
         *
         * The branches were a chain of `if`s ending in a bare `return`, so the
         * cooldown case was whatever was left over — and a refusal kind added to
         * `ProbeRefusal` silently became "cooldown": a 200, `probed: false`, no
         * message, nothing written. `CAPABILITY_UNSUPPORTED` did exactly that
         * when it was added, which is how this was found. Now the narrowing makes
         * `refusal.kind` `never` here, so the next kind added does not compile
         * until somebody decides what the operator is told.
         */
        const unhandled: never = refusal;
        // No payload in the message: the branch is unreachable by construction,
        // so the only reader is a developer who has just broken the narrowing,
        // and the compiler has already told them where.
        void unhandled;
        throw new Error('unhandled probe refusal kind');
      }

      // Cooldown. No probe, no health write, no audit entry: nothing happened,
      // and `probed: false` is how the caller is told so. The view carries
      // whatever health is stored, which is what every other read of this panel
      // returns — a result from the last probe that completed, with its own
      // `checkedAt`, and never a stale result presented as a fresh one.
      //
      // Not an error, deliberately. A cooldown that threw would make the
      // ordinary "I clicked twice" case look like a failure, and an operator
      // would learn to retry through it.
      return { view: await this.oneWithCapacity(tenant, before), probed: false };
    }

    const health = attempt.health;
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PANELS_EDIT,
      { action: 'panel.test', entityType: 'Panel', entityId: panelId },
      async (tx) => {
        // Checked again, in the transaction that writes. A probe takes up to
        // `PANEL_HTTP_TIMEOUT_MS`, and a stop committed during it would
        // otherwise land a health row, a schedule row, an audit row and an
        // idempotency row for an installation somebody had already switched
        // off — which is the whole of what the four write paths above refuse.
        // The probe itself has already happened; what this stops is the
        // record of it, which is what the operator and the monitor read.
        await this.requireActiveScope(scope, tx);
        // Budget was GRANTED, which is the only thing that can end a probe
        // limit: nothing else in this codebase looks at that bucket on an
        // operator's behalf. Without it a single burst that earned one refusal
        // left the operations view reporting connection tests as limited for
        // ever, while the bucket refilled and every later test succeeded.
        //
        // INSIDE this transaction, and that is not tidiness. Outside it, this
        // sat between a probe that had already gone out and the write that
        // records it: a pool timeout here threw away the whole record of a
        // real probe and charged the operator's budget again on their retry;
        // it wrote into a scope the very next statement refuses; and the
        // recorder's own resolve runs after its dedupe, on the pool, so a
        // failure between the two left BOTH rows of a mutually exclusive pair
        // open — the state this pair exists to make impossible.
        await this.resolveProbeLimit(scope, tenant, tx);
        const { outcome, previous } = await persistProbeResult(
          this.deps,
          tenant,
          panelId,
          attempt.configuration,
          health,
          tx,
        );

        // What the row holds now that the write has been decided, read in the
        // same transaction. Only needed on the discarded path, where `before`
        // is by definition stale — see the audit's `after` below.
        const current =
          outcome === 'APPLIED' ? null : await this.deps.repository.find(tenant, panelId, tx);

        // A manual test is a real probe with a real answer, so it moves the
        // background schedule too. Without this the monitor would re-dial a
        // panel the operator just tested — and against a rejected credential it
        // would be spending the operator's lockout budget to ask a question
        // that was answered a second ago.
        //
        // Skipped when the write was refused as stale: a result the database
        // discarded must not decide when the next probe happens either.
        if (outcome === 'APPLIED') {
          const stored = await this.deps.repository.readSchedule(tenant, panelId, tx);
          const schedule = scheduleAfterProbe(this.deps.cadence, panelId, {
            checkedAt: health.checkedAt,
            failure: health.failure,
            // The row the write actually replaced, read under the panel's
            // lock — not the view captured before the probe went on the wire.
            previousConsecutiveFailures: effectivePreviousFailures(
              previous?.state ?? null,
              stored?.consecutiveFailures ?? 0,
            ),
          });
          await this.deps.repository.scheduleNext(
            tenant,
            panelId,
            {
              nextEligibleAt: schedule.nextEligibleAt,
              consecutiveFailures: schedule.consecutiveFailures,
              deferredReason: null,
              at: health.checkedAt,
            },
            tx,
          );
        }
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'panel.test',
            entityType: 'Panel',
            entityId: panelId,
            before: { state: previous?.state ?? null },
            // The normalized outcome and nothing else. No provider message, no
            // header, no body — the probe result type has no field one could
            // be put in, which is what makes this hard to get wrong later.
            //
            // And what is recorded is what the DATABASE now holds, not what
            // this probe measured. A slow manual test finishing after a newer
            // probe of the same configuration has its health write discarded;
            // recording the discarded state as the after-state left an
            // authoritative audit row asserting a transition that never
            // happened. A discarded result is audited as exactly that.
            after:
              outcome === 'APPLIED'
                ? { state: health.state, failure: health.failure, latencyMs: health.latencyMs }
                : {
                    // The state the row ACTUALLY holds, re-read inside this
                    // transaction, and the measurement that lost, named as
                    // having lost.
                    //
                    // Not `before.health`: the race is precisely that `before`
                    // is out of date. A manual probe captures AUTH_FAILED, a
                    // newer probe stores HEALTHY, the manual one returns
                    // UNREACHABLE and is discarded — reporting `before` would
                    // put AUTH_FAILED in the audit trail as the current state
                    // when the database says HEALTHY, which is a different
                    // wrong answer from the one this branch was added to fix.
                    //
                    // `result` stays SUCCESS because the operator's command did
                    // succeed: the probe ran and answered. It is the STORED
                    // state this row must not misreport.
                    state: current?.health?.state ?? null,
                    discarded: {
                      state: health.state,
                      failure: health.failure,
                      latencyMs: health.latencyMs,
                    },
                  },
            result: 'SUCCESS',
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          idempotencyKey,
          requestHash,
          { panelId },
          tx,
        );
      },
    );

    return { view: await this.oneWithCapacity(tenant, await this.require(tenant, panelId)), probed: true };
  }

  /** The shared probe core's dependencies, all of which the service already holds. */
  private probeDeps(): ProbeCoreDeps {
    return {
      repository: this.deps.repository,
      credentials: this.deps.credentials,
      uow: this.deps.uow,
      clock: this.deps.clock,
      http: this.deps.http,
      urlPolicy: this.deps.urlPolicy,
      adapters: this.deps.adapters,
      probeCooldownMs: this.deps.probeCooldownMs,
      probeBudget: this.deps.probeBudget,
      cadence: this.deps.cadence,
    };
  }

  /**
   * Refuse the write when this scope has stopped accepting work.
   *
   * Called INSIDE the mutation's transaction, before the first read that the
   * write depends on, and it throws the same NOT_FOUND the control-plane
   * services throw — a tenant an operator has stopped should look absent to a
   * writer, not present-but-refusing, and the message says which it is without
   * confirming the tenant to somebody who should not know it exists.
   */
  /**
   * Why every mutation below takes `lockPanel` before its first read.
   *
   * A probe reads the panel and its credentials, spends up to the HTTP timeout
   * on the wire, and then writes health and a schedule. An operator editing the
   * panel or rotating a credential in between made that a check-then-write
   * race: the probe's configuration comparison passed against a snapshot the
   * rotation had already superseded, so it stored the OLD credential's verdict
   * and — worse — its schedule write replaced the `ELIGIBLE_NOW` the rotation
   * had just granted, leaving the panel the operator had fixed sitting out the
   * long interval displaying the broken answer.
   *
   * The panel row is the serialization point for both sides. There is exactly
   * one lock and it is always taken first, so there is no order in which to
   * deadlock.
   */
  private async requireActiveScope(scope: ScopeContext, tx: TransactionScope): Promise<void> {
    if (await this.deps.scopeActivity.scopeIsActive(scope, tx)) return;
    throw errors.notFound(
      PLATFORM_ERROR_CODES.TENANT_NOT_FOUND,
      'This scope is not accepting work.',
    );
  }

  private mutationDeps() {
    return {
      uow: this.deps.uow,
      guard: this.deps.guard,
      audit: this.deps.audit,
      opsLog: this.deps.opsLog,
      sessions: this.deps.sessions,
      clock: this.deps.clock,
    };
  }
}

/** Which credential kinds a write mentions, optionally filtered. Never values. */
function credentialKindsIn(
  write: PanelCredentialWrite | undefined,
  predicate: (value: string | null | undefined) => boolean = (value) => value !== undefined,
): string[] {
  if (write === undefined) return [];
  const kinds: string[] = [];
  if (predicate(write.username)) kinds.push('USERNAME');
  if (predicate(write.password)) kinds.push('PASSWORD');
  if (predicate(write.apiToken)) kinds.push('API_TOKEN');
  return kinds;
}
