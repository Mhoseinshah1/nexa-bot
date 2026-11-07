import type { TenantContext, TenantId } from '@nexa/contracts';

/**
 * Phase 6A PR-6 — one background loop, every ACTIVE tenant.
 *
 * Until PR-6 every per-tenant loop of the worker was built with ONE fixed scope, the
 * installation's own tenant (`{ tenantId: installationTenantId }`), so a hosted bot's
 * reminders were never raised, its notifications never sent, its gateway payments never
 * inquired and its services never provisioned. It failed closed — nothing crossed tenants —
 * but the hosted bot was simply not served (`tests/integration/isolation-proof/worker-jobs`).
 *
 * The fix changes ONLY the loop's input. A loop's `scope` option is either the old closure
 * (`() => TenantContext | null`, kept for the installation-wide loops and the unit tests) or
 * a `TenantPass`; `forEachLoopTenant` runs the loop's SAME pass body once per tenant either
 * way. Nothing in a loop's body is copied per tenant.
 *
 * A pass, fairly and within PR-2's capacity guards:
 *
 * - the tenants are those ACTIVE when the pass starts, read on the system path. A stopped,
 *   suspended or expired bot is not served; its work waits, unclaimed, until it is active
 *   again (the outbox relay's rule). There is NO fallback to the installation's tenant: an
 *   empty list serves nobody. Each service's write path still reads `ScopeActivityReader`
 *   inside its own transaction, so a stop that commits mid-pass is refused there.
 * - the owner's own bot (the installation tenant) is served first on every pass — the
 *   "double turn / front of the queue" PR-2 gives it — and every other bot in a rotation
 *   that starts where the previous pass stopped.
 * - a pass stops starting new tenants once it has run `budgetMs` (at least one tenant is
 *   always served). The tenants it did not reach are the first ones served next pass, so a
 *   bot with a long backlog makes the pass longer for one tenant at a time, never starves
 *   another, and the loop's own stall tolerance still holds (budget + one tenant's bound).
 * - every tenant's body is the loop's own bounded batch (its per-pass limit), in that
 *   tenant's scope, so one bot's queue is never another bot's batch.
 * - one tenant's failure is logged and the pass goes on to the next tenant. The pass as a
 *   whole THROWS — so the loop records no progress and the worker's readiness goes stale —
 *   only when the owner's own bot failed or every tenant served failed: a systemic fault
 *   (the database down) is still visible, and one hosted bot's broken gateway cannot make
 *   the owner's worker unhealthy.
 */

export interface TenantPassReport {
  /** Tenants whose body ran (whether it succeeded or not). */
  readonly served: number;
  readonly failed: number;
  /** Active tenants this pass did not reach before its budget ran out. */
  readonly deferred: number;
}

export interface TenantPass {
  readonly kind: 'tenant-pass';
  each(body: (scope: TenantContext) => Promise<void>): Promise<TenantPassReport>;
}

/** What a per-tenant loop's `scope` option accepts. */
export type LoopTenantScope = (() => TenantContext | null) | TenantPass;

function isTenantPass(source: LoopTenantScope): source is TenantPass {
  return typeof source === 'object' && source !== null && source.kind === 'tenant-pass';
}

/**
 * Runs `body` once per tenant of `source`. The one call a loop's tick makes in place of
 * `const scope = this.options.scope(); if (scope === null) return; …body…`.
 */
export async function forEachLoopTenant(
  source: LoopTenantScope,
  body: (scope: TenantContext) => Promise<void>,
): Promise<TenantPassReport> {
  if (isTenantPass(source)) return source.each(body);
  const scope = source();
  if (scope === null) return { served: 0, failed: 0, deferred: 0 };
  await body(scope);
  return { served: 1, failed: 0, deferred: 0 };
}

export interface TenantFanOutDeps {
  /** The ACTIVE tenants, read on the system path. */
  readonly activeTenants: () => Promise<readonly TenantId[]>;
  /** The installation's own tenant; null before provisioning (then nobody is served). */
  readonly installationTenantId: () => TenantId | null;
  readonly now: () => number;
  readonly logger: { error(context: Record<string, unknown>, message: string): void };
  /** How long one read of the active tenants is reused across loops. */
  readonly cacheMs?: number;
}

/** One read of `tenants` serves every loop that ticks within this window. */
export const ACTIVE_TENANTS_CACHE_MS = 1_000;

export class TenantFanOut {
  private cached: { readonly at: number; readonly ids: Promise<readonly TenantId[]> } | null = null;

  constructor(private readonly deps: TenantFanOutDeps) {}

  /** A pass for the loop `name`, which stops starting tenants after `budgetMs`. */
  pass(name: string, options: { readonly budgetMs: number }): TenantPass {
    let cursor = 0;
    return {
      kind: 'tenant-pass',
      each: async (body) => {
        const primary = this.deps.installationTenantId();
        if (primary === null) return { served: 0, failed: 0, deferred: 0 };
        const active = await this.active();
        const others = [...new Set(active)].filter((id) => id !== primary).sort();
        const start = others.length === 0 ? 0 : cursor % others.length;
        const order = [
          ...(active.includes(primary) ? [primary] : []),
          ...others.slice(start),
          ...others.slice(0, start),
        ];
        const startedAt = this.deps.now();
        let served = 0;
        let failed = 0;
        let primaryFailed = false;
        let firstError: unknown = undefined;
        let servedOthers = 0;
        for (const tenantId of order) {
          if (served > 0 && this.deps.now() - startedAt >= options.budgetMs) break;
          served += 1;
          if (tenantId !== primary) servedOthers += 1;
          try {
            await body({ tenantId, botInstanceId: null });
          } catch (error: unknown) {
            failed += 1;
            if (tenantId === primary) primaryFailed = true;
            firstError ??= error;
            this.deps.logger.error(
              { loop: name, tenantId, err: String(error) },
              'background pass failed for one tenant; the others are still served',
            );
          }
        }
        // The next pass starts with the first bot this one did not reach.
        if (others.length > 0) cursor = (start + servedOthers) % others.length;
        if (served > 0 && (primaryFailed || failed === served)) throw firstError;
        return { served, failed, deferred: order.length - served };
      },
    };
  }

  private active(): Promise<readonly TenantId[]> {
    const now = this.deps.now();
    const window = this.deps.cacheMs ?? ACTIVE_TENANTS_CACHE_MS;
    if (this.cached === null || now - this.cached.at >= window || now < this.cached.at) {
      const ids = this.deps.activeTenants();
      // A failed read is not reused.
      ids.catch(() => {
        if (this.cached?.ids === ids) this.cached = null;
      });
      this.cached = { at: now, ids };
    }
    return this.cached.ids;
  }
}
