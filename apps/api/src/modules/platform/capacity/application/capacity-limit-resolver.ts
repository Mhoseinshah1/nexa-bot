import {
  capacityLimitNumber,
  effectiveCapacityLimit,
  type CapacityLimit,
  type CapacityResource,
  type CapacityTier,
  type Clock,
} from '@nexa/contracts';
import type { CapacityLimitRepository } from './ports.js';

/** How long a tenant's limits are trusted before they are read again. */
export const CAPACITY_LIMIT_CACHE_MS = 30_000;

/**
 * The limit in force for a bot, as the hot paths ask it (every webhook turn, every lane
 * pass): the owner's stored value, else the tier's default.
 *
 * Cached per tenant for `CAPACITY_LIMIT_CACHE_MS`, so an owner's change reaches every
 * process within half a minute and a turn costs no extra query. A read that FAILS answers
 * the defaults — never "unlimited", never an error: a database blip must not lift a hosted
 * bot's limits, and a limit must not be the reason a turn fails.
 *
 * The tier is decided by identity, not by a row: the installation tenant (`PRIMARY`, the one
 * the process resolved at start) is `INSTALLATION`, every other tenant is `HOSTED`.
 */
export class CapacityLimitResolver {
  private readonly cache = new Map<
    string,
    { readonly at: number; readonly limits: ReadonlyMap<CapacityResource, CapacityLimit> }
  >();

  constructor(
    private readonly deps: {
      readonly repository: Pick<CapacityLimitRepository, 'storedFor'>;
      readonly clock: Clock;
      readonly installationTenantId: () => string | null;
      readonly cacheMs?: number;
      readonly onReadFailure?: (tenantId: string, error: unknown) => void;
    },
  ) {}

  tierOf(tenantId: string): CapacityTier {
    return tenantId === this.deps.installationTenantId() ? 'INSTALLATION' : 'HOSTED';
  }

  async limitOf(tenantId: string, resource: CapacityResource): Promise<CapacityLimit> {
    const stored = await this.storedFor(tenantId);
    return effectiveCapacityLimit(resource, this.tierOf(tenantId), stored.get(resource));
  }

  /** The limit as a number; «نامحدود» is `Infinity`. */
  async numberOf(tenantId: string, resource: CapacityResource): Promise<number> {
    return capacityLimitNumber(await this.limitOf(tenantId, resource));
  }

  /** Forgets a tenant's cached limits: the owner just changed one in this process. */
  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  private async storedFor(tenantId: string): Promise<ReadonlyMap<CapacityResource, CapacityLimit>> {
    const now = this.deps.clock.now().getTime();
    const hit = this.cache.get(tenantId);
    if (hit !== undefined && now - hit.at < (this.deps.cacheMs ?? CAPACITY_LIMIT_CACHE_MS)) {
      return hit.limits;
    }
    try {
      const limits = await this.deps.repository.storedFor(tenantId);
      this.cache.set(tenantId, { at: now, limits });
      return limits;
    } catch (error) {
      this.deps.onReadFailure?.(tenantId, error);
      // The defaults, and the last known values when there are any.
      return hit?.limits ?? new Map();
    }
  }
}
