import {
  COMMERCE_ERROR_CODES,
  REFERRAL_PAGE_DEFAULT,
  REFERRAL_PAGE_MAX,
  errors,
  userIdSchema,
  type ActorContext,
  type PermissionKey,
  type ReferralCommissionState,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import type { CustomerRepository } from '../../customers/application/ports.js';
import type {
  ReferralCommissionListing,
  ReferralCommissionRepository,
  ReferralCursor,
  ReferralListing,
  ReferralRepository,
  ReferralTotals,
} from './ports.js';

/** Every read here; there is no referral write an operator can make (F10). */
export const REFERRALS_VIEW_PERMISSION: PermissionKey = 'referrals.view';

export interface ReferralReadServiceDeps {
  readonly referrals: ReferralRepository;
  readonly commissions: ReferralCommissionRepository;
  readonly customers: Pick<CustomerRepository, 'findById'>;
  readonly guard: PermissionGuard;
}

export interface CustomerReferral {
  readonly customerId: string;
  readonly code: string | null;
  readonly referredBy: ReferralListing | null;
  readonly referredCount: number;
  readonly totals: readonly ReferralTotals[];
}

/**
 * The operator's view of the referral graph and the commission ledger
 * (`docs/wp9-referral-audit.md` F10, F12).
 *
 * Read-only, and authorized here rather than in the controller: `referrals.view` for
 * everything. Every list is keyset-paged newest first, with the tenant predicate applied
 * by the repository before the page is cut.
 */
export class ReferralReadService {
  constructor(private readonly deps: ReferralReadServiceDeps) {}

  async list(
    scope: TenantContext,
    actor: ActorContext,
    query: {
      readonly limit?: number;
      readonly cursor?: ReferralCursor;
      readonly referrerId?: string;
    },
  ): Promise<{ readonly items: readonly ReferralListing[]; readonly next: ReferralCursor | null }> {
    await this.deps.guard.check(scope, actor, REFERRALS_VIEW_PERMISSION);
    return this.deps.referrals.list(
      scope,
      query.referrerId === undefined ? {} : { referrerId: query.referrerId },
      this.limit(query.limit),
      query.cursor ?? null,
    );
  }

  async commissions(
    scope: TenantContext,
    actor: ActorContext,
    query: {
      readonly limit?: number;
      readonly cursor?: ReferralCursor;
      readonly state?: ReferralCommissionState;
      readonly referrerId?: string;
    },
  ): Promise<{
    readonly items: readonly ReferralCommissionListing[];
    readonly next: ReferralCursor | null;
  }> {
    await this.deps.guard.check(scope, actor, REFERRALS_VIEW_PERMISSION);
    return this.deps.commissions.list(
      scope,
      {
        ...(query.state === undefined ? {} : { state: query.state }),
        ...(query.referrerId === undefined ? {} : { referrerId: query.referrerId }),
      },
      this.limit(query.limit),
      query.cursor ?? null,
    );
  }

  /**
   * One customer's place in the graph. Another tenant's customer is NOT FOUND, never an
   * empty summary: an empty one would confirm that the id exists somewhere.
   */
  async customer(
    scope: TenantContext,
    actor: ActorContext,
    rawCustomerId: string,
  ): Promise<CustomerReferral> {
    await this.deps.guard.check(scope, actor, REFERRALS_VIEW_PERMISSION);
    const parsed = userIdSchema.safeParse(rawCustomerId);
    const customer = parsed.success
      ? await this.deps.customers.findById(scope, parsed.data as UserId)
      : null;
    if (customer === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
    }
    const [code, referredBy, referredCount, totals] = await Promise.all([
      this.deps.referrals.codeOf(scope, customer.id),
      this.deps.referrals.findListingByReferee(scope, customer.id),
      this.deps.referrals.countReferredBy(scope, customer.id),
      this.deps.commissions.totalsForReferrer(scope, customer.id),
    ]);
    return { customerId: customer.id, code, referredBy, referredCount, totals };
  }

  private limit(requested: number | undefined): number {
    if (requested === undefined) return REFERRAL_PAGE_DEFAULT;
    return Math.min(Math.max(1, Math.trunc(requested)), REFERRAL_PAGE_MAX);
  }
}
