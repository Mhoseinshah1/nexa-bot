import { createHash } from 'node:crypto';
import {
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
} from '@nexa/contracts';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../access/application/authorized-mutation.js';
import { rememberOnce } from '../../idempotency/application/remember-once.js';
import type { SessionRepository } from '../../identity/application/ports.js';
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
} from './ports.js';
import { attemptProbe, persistProbeResult, type ProbeCoreDeps } from './probe-core.js';
import type { MonitorCadence } from '../domain/monitor-cadence.js';

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
  readonly idempotencyKey: string;
}

export interface PanelServiceDeps {
  readonly repository: PanelRepository;
  readonly credentials: PanelCredentialStore;
  readonly guard: PermissionGuard;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
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

  async list(scope: ScopeContext, actor: ActorContext): Promise<PanelView[]> {
    const tenant = this.tenant(scope);
    await this.deps.guard.check(scope, actor, PANELS_VIEW);
    return this.deps.repository.list(tenant, { includeArchived: false });
  }

  async get(scope: ScopeContext, actor: ActorContext, panelId: string): Promise<PanelView> {
    const tenant = this.tenant(scope);
    await this.deps.guard.check(scope, actor, PANELS_VIEW);
    return this.require(tenant, panelId);
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

  async create(
    scope: ScopeContext,
    actor: ActorContext,
    input: unknown,
  ): Promise<{ view: PanelView; replayed: boolean }> {
    const tenant = this.tenant(scope);
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

    await this.authorize(scope, actor, PANELS_EDIT, {
      action: 'panel.create',
      entityType: 'Panel',
      entityId: null,
    });

    // The credentials are NOT in the hash. Two creates with the same key and
    // different passwords must not be treated as different requests — that
    // would defeat the replay — and hashing a secret puts a value derived from
    // it in a table nothing else protects.
    const requestHash = hashRequest({ name: command.name, providerType, baseUrl });
    const existing = await this.deps.idempotency.find<{ panelId: string }>(
      scope,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (existing) {
      return { view: await this.require(tenant, existing.result.panelId), replayed: true };
    }

    const panelId = this.deps.ids.uuid();
    const now = this.deps.clock.now();

    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PANELS_EDIT,
      { action: 'panel.create', entityType: 'Panel', entityId: null },
      async (tx) => {
        if (await this.deps.repository.nameTaken(tenant, command.name, null, tx)) {
          throw errors.conflict(
            PANEL_ERROR_CODES.PANEL_NAME_TAKEN,
            'Another panel of this tenant already uses that name.',
          );
        }
        await this.deps.repository.create(
          tenant,
          { id: panelId, name: command.name, providerType, baseUrl, at: now },
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

    return { view: await this.require(tenant, panelId), replayed: false };
  }

  async update(
    scope: ScopeContext,
    actor: ActorContext,
    panelId: string,
    input: unknown,
  ): Promise<PanelView> {
    const tenant = this.tenant(scope);
    const command: UpdatePanelCommand = parseCommand(updatePanelRequestSchema, input);
    const baseUrl = command.baseUrl === undefined ? undefined : this.validateUrl(command.baseUrl);
    await this.authorize(scope, actor, PANELS_EDIT, {
      action: 'panel.update',
      entityType: 'Panel',
      entityId: panelId,
    });
    const requestHash = hashRequest({ panelId, name: command.name, baseUrl });
    const existing = await this.deps.idempotency.find<{ panelId: string }>(
      scope,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (existing) return this.require(tenant, panelId);

    const now = this.deps.clock.now();
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PANELS_EDIT,
      { action: 'panel.update', entityType: 'Panel', entityId: panelId },
      async (tx) => {
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
        const changes: { name?: string; baseUrl?: string } = {};
        if (command.name !== undefined) changes.name = command.name;
        if (baseUrl !== undefined) changes.baseUrl = baseUrl;

        const updated = await this.deps.repository.update(tenant, panelId, changes, now, tx);
        if (updated === null) {
          throw errors.notFound(PANEL_ERROR_CODES.PANEL_NOT_FOUND, 'No such panel.');
        }
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'panel.update',
            entityType: 'Panel',
            entityId: panelId,
            before: { name: before.panel.name, baseUrl: before.panel.baseUrl },
            after: { name: updated.name, baseUrl: updated.baseUrl },
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
    return this.require(tenant, panelId);
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
  ): Promise<PanelView> {
    const tenant = this.tenant(scope);
    const parsed = parseCommand(setPanelCredentialsRequestSchema, input);
    const write: PanelCredentialWrite = {
      username: parsed.credentials.username,
      password: parsed.credentials.password,
      apiToken: parsed.credentials.apiToken,
    };
    const idempotencyKey = parsed.idempotencyKey;
    await this.authorize(scope, actor, PANELS_CREDENTIALS_ROTATE, {
      action: 'panel.credentials.replace',
      entityType: 'Panel',
      entityId: panelId,
    });
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
    if (existing) return this.require(tenant, panelId);

    const now = this.deps.clock.now();
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PANELS_CREDENTIALS_ROTATE,
      { action: 'panel.credentials.replace', entityType: 'Panel', entityId: panelId },
      async (tx) => {
        const before = await this.require(tenant, panelId, tx);
        if (before.panel.status === 'ARCHIVED') {
          throw errors.preconditionFailed(
            PANEL_ERROR_CODES.PANEL_ARCHIVED,
            'This panel is archived. Restore it before changing its credentials.',
          );
        }
        await this.deps.credentials.write(tenant, panelId, write, now, tx);
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
    return this.require(tenant, panelId);
  }

  async setStatus(
    scope: ScopeContext,
    actor: ActorContext,
    panelId: string,
    input: unknown,
  ): Promise<PanelView> {
    const tenant = this.tenant(scope);
    const parsed = parseCommand(setPanelStatusRequestSchema, input);
    const status: PanelStatus = parsed.status;
    const idempotencyKey = parsed.idempotencyKey;
    await this.authorize(scope, actor, PANELS_EDIT, {
      action: 'panel.status',
      entityType: 'Panel',
      entityId: panelId,
    });
    const requestHash = hashRequest({ panelId, status });
    const existing = await this.deps.idempotency.find<{ panelId: string }>(
      scope,
      actor.surface,
      idempotencyKey,
      requestHash,
    );
    if (existing) return this.require(tenant, panelId);

    const now = this.deps.clock.now();
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PANELS_EDIT,
      { action: 'panel.status', entityType: 'Panel', entityId: panelId },
      async (tx) => {
        const before = await this.require(tenant, panelId, tx);
        const updated = await this.deps.repository.setStatus(tenant, panelId, status, now, tx);
        if (updated === null) {
          throw errors.notFound(PANEL_ERROR_CODES.PANEL_NOT_FOUND, 'No such panel.');
        }
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'panel.status',
            entityType: 'Panel',
            entityId: panelId,
            before: { status: before.panel.status },
            after: { status: updated.status },
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
    return this.require(tenant, panelId);
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
  ): Promise<{ view: PanelView; probed: boolean }> {
    const tenant = this.tenant(scope);
    const idempotencyKey = parseCommand(testPanelRequestSchema, input).idempotencyKey;
    await this.authorize(scope, actor, PANELS_EDIT, {
      action: 'panel.test',
      entityType: 'Panel',
      entityId: panelId,
    });

    const requestHash = hashRequest({ panelId, operation: 'test' });
    const existing = await this.deps.idempotency.find<{ panelId: string }>(
      scope,
      actor.surface,
      idempotencyKey,
      requestHash,
    );
    if (existing) return { view: await this.require(tenant, panelId), probed: false };

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
          code: 'panel.probe.limited',
          severity: 'WARN',
          message:
            'Panel connection tests are being refused: this tenant has used its outbound-probe capacity.',
          dedupeKey: 'panel.probe.limited',
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
      // Cooldown. No probe, no health write, no audit entry: nothing happened,
      // and `probed: false` is how the caller is told so. The view carries
      // whatever health is stored, which is what every other read of this panel
      // returns — a result from the last probe that completed, with its own
      // `checkedAt`, and never a stale result presented as a fresh one.
      //
      // Not an error, deliberately. A cooldown that threw would make the
      // ordinary "I clicked twice" case look like a failure, and an operator
      // would learn to retry through it.
      return { view: before, probed: false };
    }

    const health = attempt.health;
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PANELS_EDIT,
      { action: 'panel.test', entityType: 'Panel', entityId: panelId },
      async (tx) => {
        await persistProbeResult(this.deps, tenant, panelId, attempt.configuration, health, tx);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'panel.test',
            entityType: 'Panel',
            entityId: panelId,
            before: { state: before.health?.state ?? null },
            // The normalized outcome and nothing else. No provider message, no
            // header, no body — the probe result type has no field one could
            // be put in, which is what makes this hard to get wrong later.
            after: { state: health.state, failure: health.failure, latencyMs: health.latencyMs },
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

    return { view: await this.require(tenant, panelId), probed: true };
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
