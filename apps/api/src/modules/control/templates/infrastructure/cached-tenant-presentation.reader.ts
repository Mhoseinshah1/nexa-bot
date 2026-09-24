import { isSystemContext, type Clock, type ScopeContext, type TenantId } from '@nexa/contracts';
import { DEFAULT_TEMPLATE_PRESENTATION } from '@nexa/i18n';
import type { TenantRepository } from '../../../platform/tenancy/application/ports.js';
import type { TemplatePresentation, TenantPresentationReader } from '../application/ports.js';

/** How long one tenant's answer is reused before the row is read again. */
export const PRESENTATION_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  readonly presentation: TemplatePresentation;
  /** The instant this entry stops being an answer, from the injected clock. */
  readonly staleAt: number;
}

/**
 * The tenant row's `display_timezone` and `calendar`, remembered for a minute.
 *
 * Every rendered message would otherwise cost a tenant read, and the dispatcher and the
 * customer messenger render in batches. Sixty seconds is the stated bound on how long a
 * tenant's calendar change can take to reach its messages; the clock is the injected
 * port, so a test can move time rather than wait for it.
 *
 * The read goes through the repository's own connection rather than the caller's
 * transaction: the row is presentation, not business state, and holding a render's
 * lookup inside a money transaction would only widen what that transaction waits on.
 * A `SystemContext` has no tenant to ask and receives the product default.
 */
export class CachedTenantPresentationReader implements TenantPresentationReader {
  private readonly cache = new Map<TenantId, CacheEntry>();

  constructor(
    private readonly tenants: Pick<TenantRepository, 'findById'>,
    private readonly clock: Clock,
  ) {}

  async presentationFor(scope: ScopeContext, _tx?: unknown): Promise<TemplatePresentation> {
    if (isSystemContext(scope)) return DEFAULT_TEMPLATE_PRESENTATION;

    const now = this.clock.now().getTime();
    const cached = this.cache.get(scope.tenantId);
    if (cached !== undefined && now < cached.staleAt) return cached.presentation;

    const tenant = await this.tenants.findById(scope.tenantId);
    // A scope naming a tenant that is not there is a caller's defect the write path
    // reports elsewhere; a render is not the place to fail, and the miss is not
    // remembered, so the row is found as soon as it exists.
    if (tenant === null) return DEFAULT_TEMPLATE_PRESENTATION;

    const presentation: TemplatePresentation = {
      timezone: tenant.displayTimezone,
      calendar: tenant.calendar,
    };
    this.cache.set(scope.tenantId, { presentation, staleAt: now + PRESENTATION_CACHE_TTL_MS });
    return presentation;
  }
}
