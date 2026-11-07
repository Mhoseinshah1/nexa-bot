import {
  CAPACITY_ERROR_CODES,
  CAPACITY_RESOURCES,
  CAPACITY_RESOURCE_RULES,
  PLATFORM_ERROR_CODES,
  capacityLimitProblem,
  capacitySetLimitRequestSchema,
  effectiveCapacityLimit,
  errors,
  type ActorContext,
  type CapacityLimit,
  type CapacityLimitsResponse,
  type CapacityResource,
  type CapacitySetLimitResponse,
  type CapacityTenantView,
  type IdempotencyStore,
  type PermissionKey,
  type ScopeContext,
} from '@nexa/contracts';
import {
  recordMutationDenial,
  runAuthorizedMutation,
  type AuthorizedMutationDeps,
} from '../../access/application/authorized-mutation.js';
import type { ScopeActivityReader } from '../../system/application/record-ping.service.js';
import { hashRequest } from '../../idempotency/infrastructure/drizzle-idempotency-store.js';
import { rememberOnce } from '../../idempotency/application/remember-once.js';
import type { CapacityLimitResolver } from './capacity-limit-resolver.js';
import type { CapacityLimitRepository, CapacityTenantDirectory } from './ports.js';

/**
 * The permission the owner's capacity limits take: `settings.destructive` (CRITICAL, seeded to
 * the owner role) — AND the scope must be the installation's own tenant. A hosted bot's owner
 * holds `settings.destructive` in THEIR tenant, and that is exactly who must never raise their
 * own limits, so the scope check is not optional and comes first.
 */
export const CAPACITY_LIMITS_PERMISSION: PermissionKey = 'settings.destructive';

/**
 * Phase 6A PR-2: reads and changes the owner's per-bot capacity limits. The application
 * service behind `GET/POST /capacity/limits` (the creator panel's page is PR-3).
 *
 * The write path in order: installation scope → permission (denial audited) → validation →
 * idempotency key → one transaction holding the scope-activity check, the row, and the audit
 * row with `before`/`after` → the cache of this process forgotten. No domain event: a limit
 * is configuration read by the guards on their next cache refresh (30 s), and nothing
 * downstream reacts to it.
 */
export class CapacityLimitsService {
  constructor(
    private readonly deps: AuthorizedMutationDeps & {
      readonly repository: CapacityLimitRepository;
      readonly tenants: CapacityTenantDirectory;
      readonly idempotency: IdempotencyStore;
      readonly scopeActivity: ScopeActivityReader;
      readonly resolver: Pick<CapacityLimitResolver, 'tierOf' | 'invalidate'>;
      readonly installationTenantId: () => string | null;
    },
  ) {}

  async list(scope: ScopeContext, actor: ActorContext): Promise<CapacityLimitsResponse> {
    await this.authorize(scope, actor, 'capacity.limits.view');
    const [tenants, stored] = await Promise.all([
      this.deps.tenants.all(),
      this.deps.repository.storedForAll(),
    ]);
    return {
      tenants: tenants.map((tenant) =>
        this.view(tenant.id, tenant.displayName, stored.get(tenant.id) ?? new Map()),
      ),
    };
  }

  /**
   * The saved answer of an earlier `set` under the same idempotency key, or null when there
   * is none — WITHOUT changing anything. For a caller that spends something before `set`
   * (the creator panel's fresh code): a retried request must get its first result back,
   * never a second charge. A reused key with a different payload is refused, as in `set`.
   */
  async replayOf(
    scope: ScopeContext,
    actor: ActorContext,
    input: unknown,
  ): Promise<CapacitySetLimitResponse | null> {
    await this.authorize(scope, actor, 'capacity.limit.set');
    const command = capacitySetLimitRequestSchema.parse(input);
    const replay = await this.deps.idempotency.find<{ tenantId: string }>(
      scope,
      actor.surface,
      command.idempotencyKey,
      setLimitRequestHash(command),
    );
    return replay === null
      ? null
      : { tenant: await this.tenantView(command.tenantId), replayed: true };
  }

  async set(
    scope: ScopeContext,
    actor: ActorContext,
    input: unknown,
  ): Promise<CapacitySetLimitResponse> {
    await this.authorize(scope, actor, 'capacity.limit.set');
    const command = capacitySetLimitRequestSchema.parse(input);
    const tier = this.deps.resolver.tierOf(command.tenantId);
    if (command.limit !== null) {
      const problem = capacityLimitProblem(command.resource, command.limit, tier);
      if (problem !== null) {
        throw errors.validation(
          CAPACITY_ERROR_CODES.LIMIT_INVALID,
          `This limit cannot be stored for ${command.resource} (${problem}).`,
          { resource: command.resource, problem },
        );
      }
    } else if (
      CAPACITY_RESOURCE_RULES[command.resource].installationOnly &&
      tier !== 'INSTALLATION'
    ) {
      throw errors.validation(
        CAPACITY_ERROR_CODES.LIMIT_INVALID,
        `${command.resource} belongs to the installation only.`,
        { resource: command.resource, problem: 'INSTALLATION_ONLY' },
      );
    }
    const requestHash = setLimitRequestHash(command);
    const replay = await this.deps.idempotency.find<{ tenantId: string }>(
      scope,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (replay !== null) return { tenant: await this.tenantView(command.tenantId), replayed: true };

    await runAuthorizedMutation(
      this.deps,
      scope,
      actor,
      CAPACITY_LIMITS_PERMISSION,
      { action: 'capacity.limit.set', entityType: 'Tenant', entityId: command.tenantId },
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.notFound(
            PLATFORM_ERROR_CODES.TENANT_NOT_FOUND,
            'This scope is not accepting work.',
          );
        }
        const target = await this.deps.tenants.find(command.tenantId, tx);
        if (target === null) {
          throw errors.notFound(PLATFORM_ERROR_CODES.TENANT_NOT_FOUND, 'Unknown bot.');
        }
        const before = await this.deps.repository.put(
          {
            tenantId: command.tenantId,
            resource: command.resource,
            limit: command.limit,
            now: this.deps.clock.now(),
            adminId: actor.id,
          },
          tx,
        );
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'capacity.limit.set',
            entityType: 'Tenant',
            entityId: command.tenantId,
            before: { resource: command.resource, limit: before },
            after: { resource: command.resource, limit: command.limit },
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
          { tenantId: command.tenantId },
          tx,
        );
      },
    );
    this.deps.resolver.invalidate(command.tenantId);
    return { tenant: await this.tenantView(command.tenantId), replayed: false };
  }

  /**
   * Installation scope first, then the permission. A refusal of either is audited as a
   * denial, like every other refused mutation.
   */
  private async authorize(scope: ScopeContext, actor: ActorContext, action: string): Promise<void> {
    const installation = this.deps.installationTenantId();
    try {
      if (installation === null || !('tenantId' in scope) || scope.tenantId !== installation) {
        throw errors.permissionDenied(
          CAPACITY_ERROR_CODES.OWNER_ONLY,
          'Capacity limits are the installation owner’s.',
          { permission: CAPACITY_LIMITS_PERMISSION },
        );
      }
      await this.deps.guard.check(scope, actor, CAPACITY_LIMITS_PERMISSION);
    } catch (denial) {
      await recordMutationDenial(
        this.deps,
        scope,
        actor,
        CAPACITY_LIMITS_PERMISSION,
        { action, entityType: 'Tenant', entityId: null },
        denial,
      );
      throw denial;
    }
  }

  private async tenantView(tenantId: string): Promise<CapacityTenantView> {
    const tenant = await this.deps.tenants.find(tenantId);
    const stored = await this.deps.repository.storedFor(tenantId);
    return this.view(tenantId, tenant?.displayName ?? tenantId, stored);
  }

  private view(
    tenantId: string,
    displayName: string,
    stored: ReadonlyMap<CapacityResource, CapacityLimit>,
  ): CapacityTenantView {
    const tier = this.deps.resolver.tierOf(tenantId);
    return {
      tenantId,
      displayName,
      tier,
      limits: CAPACITY_RESOURCES.filter(
        (resource) =>
          tier === 'INSTALLATION' || !CAPACITY_RESOURCE_RULES[resource].installationOnly,
      ).map((resource) => {
        const rule = CAPACITY_RESOURCE_RULES[resource];
        const own = stored.get(resource);
        return {
          resource,
          limit: effectiveCapacityLimit(resource, tier, own),
          source: own === undefined ? 'DEFAULT' : 'STORED',
          defaultLimit: rule.defaults[tier],
          min: rule.min,
          max: rule.max,
          allowsUnlimited: rule.allowsUnlimited,
          consumer: rule.consumer,
        };
      }),
    };
  }
}

/** The request a `set` idempotency key is bound to (one definition: `set` and `replayOf`). */
function setLimitRequestHash(command: {
  readonly tenantId: string;
  readonly resource: string;
  readonly limit: unknown;
}): string {
  return hashRequest({
    tenantId: command.tenantId,
    resource: command.resource,
    limit: command.limit,
  });
}
