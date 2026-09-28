import { createHash } from 'node:crypto';
import {
  DEFAULT_PANEL_POLICY,
  PANEL_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  CAPABILITY_REGISTRY_ROWS,
  customerActionVerdict,
  deriveCapabilityRegistry,
  errors,
  isPanelCustomerAction,
  isSystemContext,
  providerDescriptor,
  registryRowDeclarations,
  resolvePanelPolicy,
  unsupportedPolicyActions,
  updatePanelPolicyRequestSchema,
  uuidV7Schema,
  type ActorContext,
  type AuditWriter,
  type CapabilityRegistryEntry,
  type Clock,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PanelAdvancedResponse,
  type PanelCapabilityRow,
  type PanelTechnicalResponse,
  type PermissionKey,
  type ProviderConnectionAdapter,
  type ProviderRules,
  type ProviderType,
  type ResolvedPanelPolicy,
  type ScopeContext,
  type TenantContext,
  type UnitOfWork,
  type UpdatePanelPolicyResponse,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../access/application/authorized-mutation.js';
import { rememberOnce } from '../../idempotency/application/remember-once.js';
import type { SessionRepository } from '../../identity/application/ports.js';
import type { ScopeActivityReader } from '../../system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { PanelWithCapacity } from './capacity-ports.js';
import { diagnosePanel } from './panel-diagnostics.js';
import { readHealth } from './panel-health-view.js';
import type { PanelPolicyRepository, StoredPanelPolicy } from './panel-policy.js';
import type { PanelRepository } from './ports.js';

const PANELS_EDIT: PermissionKey = 'panels.edit';
const PANELS_TECHNICAL_VIEW: PermissionKey = 'panels.technical.view';

export interface PanelAdvancedServiceDeps {
  /**
   * The panel read with its capacity and sellability — the SAME composition the panel
   * read returns, so the diagnostics here and the sellability card beside them cannot
   * disagree. `get` charges `panels.view`; `readAuthorized` is for a caller that has
   * already charged its own permission.
   */
  readonly panels: {
    get(scope: ScopeContext, actor: ActorContext, panelId: string): Promise<PanelWithCapacity>;
    readAuthorized(scope: TenantContext, panelId: string): Promise<PanelWithCapacity>;
  };
  readonly repository: Pick<PanelRepository, 'lockPanel' | 'find'>;
  readonly policies: PanelPolicyRepository;
  /** The adapter for a provider type, or null when this release has none. */
  readonly adapters: (providerType: string) => ProviderConnectionAdapter | null;
  readonly providerRules: (providerType: ProviderType) => ProviderRules;
  /** The tenant switch a customer's link rotation also needs (`customer_link_rotation`). */
  readonly features: {
    isEnabled(scope: ScopeContext, key: 'customer_link_rotation'): Promise<boolean>;
  };
  readonly guard: PermissionGuard;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
}

/**
 * Advanced provider settings for one panel (WP-A8): the capability registry, the
 * operator's policy, the provider's fixed rules and the diagnostics.
 *
 * ## What an operator can change here, and what they cannot
 *
 * The registry is derived from the adapter on every read and has no write path at all.
 * The policy is the one thing written, and its write refuses any action the registry
 * says the panel cannot perform — so there is no sequence of requests that makes an
 * unsupported behaviour look configured. Reading a policy can only ever RESTRICT: every
 * customer path asks `decideOperability` first and the policy second.
 *
 * ## Why the write carries a revision as well as an idempotency key
 *
 * The key makes a retry of THIS request safe. The revision makes a DIFFERENT request
 * from a colleague who read an older policy refuse rather than silently replace what
 * they never saw — the same distinction the settings registry draws with
 * `expectedVersion`.
 */
export class PanelAdvancedService {
  constructor(private readonly deps: PanelAdvancedServiceDeps) {}

  async advanced(
    scope: ScopeContext,
    actor: ActorContext,
    panelId: string,
  ): Promise<PanelAdvancedResponse> {
    const tenant = this.tenant(scope);
    // `get` charges `panels.view` and answers NOT_FOUND for another tenant's id.
    const view = await this.deps.panels.get(scope, actor, panelId);
    return this.build(tenant, view, await this.deps.policies.find(tenant, view.panel.id));
  }

  async updatePolicy(
    scope: ScopeContext,
    actor: ActorContext,
    panelId: string,
    input: unknown,
  ): Promise<UpdatePanelPolicyResponse> {
    const tenant = this.tenant(scope);
    const denial = { action: 'panel.policy_update', entityType: 'Panel', entityId: panelId };
    // Authorize, then parse — the order `PanelService` keeps, so a caller without the
    // permission learns nothing about what a valid body looks like.
    try {
      await this.deps.guard.check(scope, actor, PANELS_EDIT);
    } catch (error) {
      await recordMutationDenial(this.mutationDeps(), scope, actor, PANELS_EDIT, denial, error);
      throw error;
    }
    const id = this.panelId(panelId);
    const parsed = updatePanelPolicyRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw errors.validation(
        PANEL_ERROR_CODES.PANEL_REQUEST_INVALID,
        'The request is not valid.',
        {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.map(String).join('.'),
            message: issue.message,
          })),
        },
      );
    }
    const command = parsed.data;
    const requestHash = createHash('sha256')
      .update(
        canonical({
          panelId: id,
          expectedRevision: command.expectedRevision,
          policy: command.policy,
        }),
      )
      .digest('hex');
    const replay = await this.deps.idempotency.find<{ panelId: string; changed: boolean }>(
      scope,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      const view = await this.deps.panels.readAuthorized(tenant, id);
      return {
        advanced: await this.build(tenant, view, await this.deps.policies.find(tenant, id)),
        // What the FIRST request did, not a second opinion from this one.
        changed: replay.result.changed,
      };
    }

    const now = this.deps.clock.now();
    const changed = await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PANELS_EDIT,
      denial,
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.notFound(
            PLATFORM_ERROR_CODES.TENANT_NOT_FOUND,
            'This scope is not accepting work.',
          );
        }
        // The panel row first, the one lock every panel mutation takes first, so a
        // policy write serialises with an edit, a rotation and a probe of this panel.
        if (!(await this.deps.repository.lockPanel(tenant, id, tx))) {
          throw errors.notFound(PANEL_ERROR_CODES.PANEL_NOT_FOUND, 'No such panel.');
        }
        const view = await this.deps.repository.find(tenant, id, tx);
        if (view === null) {
          throw errors.notFound(PANEL_ERROR_CODES.PANEL_NOT_FOUND, 'No such panel.');
        }
        if (view.panel.status === 'ARCHIVED') {
          throw errors.preconditionFailed(
            PANEL_ERROR_CODES.PANEL_ARCHIVED,
            'This panel is archived. Restore it before editing.',
          );
        }
        const unsupported = unsupportedPolicyActions(
          command.policy,
          this.registryFor(view.panel.providerType),
        );
        if (unsupported.length > 0) {
          throw errors.validation(
            PANEL_ERROR_CODES.PANEL_POLICY_CAPABILITY_UNSUPPORTED,
            'This panel cannot perform some of the actions the policy names.',
            { actions: [...unsupported] },
          );
        }
        const stored = await this.deps.policies.find(tenant, id, tx);
        const revision = stored?.revision ?? 0;
        if (command.expectedRevision !== revision) {
          throw errors.conflict(
            PANEL_ERROR_CODES.PANEL_POLICY_STALE,
            'The policy changed since it was read. Reload it and try again.',
            { revision },
          );
        }
        const before = stored === null ? DEFAULT_PANEL_POLICY : stored.policy;
        // A save of what is already in force is a no-op, and says so: no revision,
        // no audit row claiming a change, and `changed: false` on the response.
        if (canonical(before) === canonical(command.policy)) {
          await rememberOnce(
            this.deps.idempotency,
            scope,
            actor.surface,
            command.idempotencyKey,
            requestHash,
            { panelId: id, changed: false },
            tx,
          );
          return false;
        }
        const saved = await this.deps.policies.save(
          tenant,
          id,
          command.policy,
          command.expectedRevision,
          now,
          tx,
        );
        if (saved === null) {
          throw errors.conflict(
            PANEL_ERROR_CODES.PANEL_POLICY_STALE,
            'The policy changed since it was read. Reload it and try again.',
            { revision },
          );
        }
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'panel.policy_update',
            entityType: 'Panel',
            entityId: id,
            // The VALUES. Nothing in a policy is a secret, and "the policy changed" is
            // no use to somebody working out why renewals stopped on this panel at 14:02.
            before: { revision, policy: stored === null ? null : stored.policy },
            after: { revision: saved.revision, policy: command.policy },
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
          { panelId: id, changed: true },
          tx,
        );
        return true;
      },
    );
    const view = await this.deps.panels.readAuthorized(tenant, id);
    return {
      advanced: await this.build(tenant, view, await this.deps.policies.find(tenant, id)),
      changed,
    };
  }

  /**
   * The Super Admin's raw view. Read-only; its own permission, charged here.
   *
   * No credential can appear: the view type carries the three set-at timestamps and
   * nothing else, because the repository never selects a ciphertext.
   */
  async technical(
    scope: ScopeContext,
    actor: ActorContext,
    panelId: string,
  ): Promise<PanelTechnicalResponse> {
    const tenant = this.tenant(scope);
    await this.deps.guard.check(scope, actor, PANELS_TECHNICAL_VIEW);
    const view = await this.deps.panels.readAuthorized(tenant, this.panelId(panelId));
    const stored = await this.deps.policies.find(tenant, view.panel.id);
    const descriptor = providerDescriptor(view.panel.providerType);
    const health = view.health;
    return {
      panelId: view.panel.id,
      providerType: view.panel.providerType,
      descriptor: {
        canonicalName: descriptor?.canonicalName ?? view.panel.providerType,
        credentialShape: descriptor?.credentialShape ?? 'NONE',
        capabilities: [...(descriptor?.capabilities ?? [])],
        requiredActivationFields: [...(descriptor?.requiredActivationFields ?? [])],
        maxRequestsPerProbe: descriptor?.maxRequestsPerProbe ?? 1,
      },
      registry: this.registryFor(view.panel.providerType).map((entry) => ({
        ...entry,
        declarations: [...registryRowDeclarations(entry.row)],
      })),
      storedActivation: view.panel.activation ?? null,
      storedPolicy: stored?.policy ?? null,
      policyRevision: stored?.revision ?? 0,
      health: {
        storedState: health?.state ?? null,
        failure: health?.failure ?? null,
        statusCode: health?.statusCode ?? null,
        providerVersion: health?.providerVersion ?? null,
        checkedAt: health?.checkedAt.toISOString() ?? null,
        lastHealthyAt: health?.lastHealthyAt?.toISOString() ?? null,
        unusableStreak: health?.unusableStreak ?? 0,
      },
      credentialsSetAt: {
        username: view.credentials.usernameSetAt?.toISOString() ?? null,
        password: view.credentials.passwordSetAt?.toISOString() ?? null,
        apiToken: view.credentials.apiTokenSetAt?.toISOString() ?? null,
      },
    };
  }

  /** One provider type's registry, or every row unsupported when there is no adapter. */
  registryFor(providerType: string): readonly CapabilityRegistryEntry[] {
    const adapter = this.deps.adapters(providerType);
    if (adapter === null) {
      return CAPABILITY_REGISTRY_ROWS.map((row) => ({
        row,
        supported: false,
        gap: 'NOT_SUPPORTED' as const,
      }));
    }
    return deriveCapabilityRegistry(adapter);
  }

  private async build(
    tenant: TenantContext,
    view: PanelWithCapacity,
    stored: StoredPanelPolicy | null,
  ): Promise<PanelAdvancedResponse> {
    const resolved = resolvePanelPolicy(stored?.policy ?? null);
    const rotationOn = await this.deps.features.isEnabled(tenant, 'customer_link_rotation');
    const registry = this.registryFor(view.panel.providerType).map((entry) =>
      withCustomerAvailability(entry, resolved, rotationOn),
    );
    const now = this.deps.clock.now();
    const providerType = view.panel.providerType;
    return {
      panelId: view.panel.id,
      providerType,
      providerName: providerDescriptor(providerType)?.canonicalName ?? providerType,
      status: view.panel.status,
      health: readHealth(view.panel, view.health, now).state,
      registry,
      policy: {
        policy: resolved.readable ? resolved.policy : DEFAULT_PANEL_POLICY,
        readable: resolved.readable,
        revision: stored?.revision ?? 0,
        updatedAt: stored?.updatedAt.toISOString() ?? null,
      },
      providerRules: this.deps.providerRules(providerType),
      diagnostics: diagnosePanel({
        view,
        sellability: view.sellability,
        adapter: this.deps.adapters(providerType),
        now,
      }),
    };
  }

  private tenant(scope: ScopeContext): TenantContext {
    if (isSystemContext(scope)) {
      throw errors.validation(
        PLATFORM_ERROR_CODES.TENANT_CONTEXT_MISSING,
        'Panel operations are tenant-scoped.',
      );
    }
    return scope;
  }

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

/**
 * Whether a customer on this panel is offered the row's action, and the first reason
 * they are not — capability, then the panel's policy, then a tenant switch.
 */
function withCustomerAvailability(
  entry: CapabilityRegistryEntry,
  resolved: ResolvedPanelPolicy,
  rotationOn: boolean,
): PanelCapabilityRow {
  if (!isPanelCustomerAction(entry.row)) return { ...entry, customer: null };
  if (!entry.supported) {
    return { ...entry, customer: { available: false, blocker: 'UNSUPPORTED' } };
  }
  const verdict = customerActionVerdict(resolved, entry.row);
  if (!verdict.allowed)
    return { ...entry, customer: { available: false, blocker: verdict.reason } };
  if (entry.row === 'ROTATE_SUBSCRIPTION' && !rotationOn) {
    return { ...entry, customer: { available: false, blocker: 'TENANT_FEATURE_OFF' } };
  }
  return { ...entry, customer: { available: true, blocker: null } };
}

/**
 * A stable serialisation, keys sorted at every depth: the no-op test and the request
 * hash must not depend on the order a client happened to write its keys in.
 */
function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, inner]) => [key, sortKeys(inner)]),
    );
  }
  return value;
}
