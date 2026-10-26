import type { ReferralGiftUnlockMode, TenantContext } from '@nexa/contracts';

/** The flag the referral-gift guard sits behind (default OFF). */
export const REFERRAL_ABUSE_GUARD_FEATURE = 'referral_abuse_guard';

/**
 * R10 D5 (b): the referral-gift guard as it stands, read in ONE place so no caller decides
 * "is the guard on" alone — the twin of `readSignupGiftTerms`.
 *
 * Flag off is every field at its no-op: no purchase condition, no cap. That is today's
 * behaviour byte for byte, and the reason the guard needs no data of its own: turning it off
 * restores the old rule with nothing to undo.
 */
export interface ReferralAbuseTerms {
  /** Both sides of the signup gift wait for the referee's first paid, delivered purchase. */
  readonly giftRequiresPurchase: boolean;
  /** Referrer shares paid per referrer per local day; null for no cap. */
  readonly referrerDailyGiftCap: number | null;
  /** Commissions earned per referrer per local day; null for no cap. */
  readonly referrerDailyCommissionCap: number | null;
}

export const REFERRAL_ABUSE_GUARD_OFF: ReferralAbuseTerms = {
  giftRequiresPurchase: false,
  referrerDailyGiftCap: null,
  referrerDailyCommissionCap: null,
};

export interface ReferralAbuseTermsSource {
  readonly features: {
    isEnabled(
      scope: TenantContext,
      key: typeof REFERRAL_ABUSE_GUARD_FEATURE,
      tx?: unknown,
    ): Promise<boolean>;
  };
  readonly settings: { valueOf<T>(scope: TenantContext, key: string, tx?: unknown): Promise<T> };
}

/** Read inside the caller's transaction when it has one, so a claim decides from what it sees. */
export async function readReferralAbuseTerms(
  source: ReferralAbuseTermsSource,
  scope: TenantContext,
  tx?: unknown,
): Promise<ReferralAbuseTerms> {
  if (!(await source.features.isEnabled(scope, REFERRAL_ABUSE_GUARD_FEATURE, tx))) {
    return REFERRAL_ABUSE_GUARD_OFF;
  }
  const [unlock, giftCap, commissionCap] = await Promise.all([
    source.settings.valueOf<ReferralGiftUnlockMode>(scope, 'referral.abuse.gift_unlock', tx),
    source.settings.valueOf<number | null>(scope, 'referral.abuse.referrer_daily_gift_cap', tx),
    source.settings.valueOf<number | null>(
      scope,
      'referral.abuse.referrer_daily_commission_cap',
      tx,
    ),
  ]);
  return {
    giftRequiresPurchase: unlock === 'ON_FIRST_PAID_PURCHASE',
    referrerDailyGiftCap: giftCap,
    referrerDailyCommissionCap: commissionCap,
  };
}
