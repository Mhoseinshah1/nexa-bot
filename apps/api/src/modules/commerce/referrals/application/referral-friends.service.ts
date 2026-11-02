import {
  MINIAPP_REFERRAL_FRIENDS_PAGE_SIZE,
  type ActorContext,
  type FeatureFlagKey,
  type PermissionKey,
  type TenantContext,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import { friendDisplayName } from './referral-friend-name.js';
import type {
  ReferralCursor,
  ReferralFriendCounts,
  ReferralFriendStatus,
  ReferralFriendsRepository,
} from './ports.js';

/** The customer reading their own records: the same key the wallet's own-history read holds. */
export const REFERRAL_FRIENDS_OWN_VIEW_PERMISSION: PermissionKey = 'maintenance.run';

/** The flag that switches the list on. Off by default. */
export const REFERRAL_FRIENDS_FLAG: FeatureFlagKey = 'referral_friends_list';

export interface ReferralFriendsServiceDeps {
  readonly friends: ReferralFriendsRepository;
  readonly features: {
    isEnabled(scope: TenantContext, key: FeatureFlagKey, tx?: unknown): Promise<boolean>;
  };
  readonly guard: PermissionGuard;
  readonly clock: { now(): Date };
}

export interface ReferralFriendView {
  readonly displayName: string | null;
  readonly joinedAt: Date;
  readonly status: ReferralFriendStatus;
  readonly rewardNotBefore: Date | null;
}

export type ReferralFriendsView =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly counts: ReferralFriendCounts & { readonly total: number };
      readonly items: readonly ReferralFriendView[];
      readonly next: ReferralCursor | null;
    };

/**
 * The customer's own invited friends (R11 B3), read-only: no write, no money moved, no message
 * sent. Behind `referral_friends_list` (default OFF), which is read here and not in the
 * controller so no surface can forget it.
 *
 * Own referrals only: the referrer id is the CUSTOMER THE SESSION AUTHENTICATED, passed by the
 * surface, never an id from the request, and the repository puts it and the tenant in the
 * WHERE before the page is cut. Imported (MIRZA) attributions are listed, because the figure
 * the screen already shows as «دعوت‌شده» counts them (`countReferredBy` has no source filter)
 * and a list that disagreed with its own total would be wrong about one of them.
 */
export class ReferralFriendsService {
  constructor(private readonly deps: ReferralFriendsServiceDeps) {}

  async list(
    scope: TenantContext,
    actor: ActorContext,
    customerId: string,
    cursor: ReferralCursor | null,
  ): Promise<ReferralFriendsView> {
    await this.deps.guard.check(scope, actor, REFERRAL_FRIENDS_OWN_VIEW_PERMISSION);
    if (!(await this.deps.features.isEnabled(scope, REFERRAL_FRIENDS_FLAG))) {
      return { enabled: false };
    }
    const now = this.deps.clock.now();
    const [page, counts] = await Promise.all([
      this.deps.friends.page(scope, customerId, MINIAPP_REFERRAL_FRIENDS_PAGE_SIZE, cursor),
      this.deps.friends.counts(scope, customerId),
    ]);
    return {
      enabled: true,
      counts: {
        ...counts,
        total: counts.joined + counts.purchased + counts.rewardPending + counts.rewardPaid,
      },
      items: page.items.map((row) => ({
        displayName: friendDisplayName(row.firstName, row.username),
        joinedAt: row.createdAt,
        status: row.status,
        // A cap day that has already come is no longer a reason to wait: only a future instant.
        rewardNotBefore:
          row.status === 'REWARD_PENDING' &&
          row.pendingNotBefore !== null &&
          row.pendingNotBefore.getTime() > now.getTime()
            ? row.pendingNotBefore
            : null,
      })),
      next: page.next,
    };
  }
}
