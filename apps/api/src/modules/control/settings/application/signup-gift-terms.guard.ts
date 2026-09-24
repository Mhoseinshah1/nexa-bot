import {
  COMMERCE_ERROR_CODES,
  errors,
  money,
  type Money,
  type ScopeContext,
  type SettingKey,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { FeatureFlagResolver } from '../../features/application/feature-flags.service.js';
import type { SettingsResolver } from './settings-resolver.js';
import type { SettingChangeGuard } from './settings.service.js';

/** The three keys that together are the gift's terms. */
export const SIGNUP_GIFT_TERM_KEYS = [
  'referral.signup_gift.total',
  'referral.signup_gift.referrer_percent',
  'referral.signup_gift.referred_percent',
] as const satisfies readonly SettingKey[];

export type SignupGiftTermKey = (typeof SIGNUP_GIFT_TERM_KEYS)[number];

/** The gift's terms as the three settings hold them. */
export interface SignupGiftTerms {
  readonly total: Money;
  readonly referrerPercent: number;
  readonly referredPercent: number;
}

/** Why a set of terms cannot pay a gift, or null when it can. */
export type SignupGiftTermsProblem = 'TOTAL_ZERO' | 'SHARES_NOT_100';

/**
 * The ONE statement of what valid terms are: a positive total, and two shares that make
 * a whole. Read by the settings guard, the flag activation guard and the claim itself, so
 * the three cannot disagree about whether a gift is payable.
 */
export function signupGiftTermsProblem(terms: SignupGiftTerms): SignupGiftTermsProblem | null {
  if (terms.total.amountMinor <= 0n) return 'TOTAL_ZERO';
  if (terms.referrerPercent + terms.referredPercent !== 100) return 'SHARES_NOT_100';
  return null;
}

/** The three settings, resolved in one place, inside the caller's transaction when given. */
export async function readSignupGiftTerms(
  resolver: SettingsResolver,
  scope: ScopeContext,
  tx?: unknown,
): Promise<SignupGiftTerms> {
  const [total, referrerPercent, referredPercent] = await Promise.all([
    resolver.valueOf<{ amountMinor: string; currency: string }>(
      scope,
      'referral.signup_gift.total',
      tx,
    ),
    resolver.valueOf<number>(scope, 'referral.signup_gift.referrer_percent', tx),
    resolver.valueOf<number>(scope, 'referral.signup_gift.referred_percent', tx),
  ]);
  return {
    total: money(BigInt(total.amountMinor), total.currency as Money['currency']),
    referrerPercent,
    referredPercent,
  };
}

/**
 * The veto that keeps the gift's three settings coherent WHILE the gift is on.
 *
 * The same shape as `ReminderThresholdsGuard`, for the same reason: one setting's schema
 * sees one value and cannot say that two shares must total a hundred. While the flag is
 * off the terms may be edited freely — an operator sets the total first and the shares
 * afterwards, and refusing the first step would make the second unreachable; the flag's
 * own activation guard is what stops it turning on over incoherent terms.
 *
 * It THROWS the typed refusal rather than returning a reason. `SettingsService.set`
 * turns a returned string into `INVALID_VALUE`, which is the right code for a value that
 * is wrong on its own; these values are each fine on their own and wrong together, and
 * `REFERRAL_GIFT_TERMS_INVALID` is the code the contract declares for exactly that, so
 * the Web Admin can name the combination rather than blame the one field just typed.
 */
export class SignupGiftTermsGuard implements SettingChangeGuard {
  constructor(
    readonly key: SignupGiftTermKey,
    private readonly settings: SettingsResolver,
    private readonly features: FeatureFlagResolver,
  ) {}

  /** One guard per key, built from the one list, so none can be forgotten. */
  static all(
    settings: SettingsResolver,
    features: FeatureFlagResolver,
  ): readonly SignupGiftTermsGuard[] {
    return SIGNUP_GIFT_TERM_KEYS.map((key) => new SignupGiftTermsGuard(key, settings, features));
  }

  async refuseChange(
    scope: ScopeContext,
    change: { readonly from: unknown; readonly to: unknown },
    tx: TransactionScope,
  ): Promise<string | null> {
    if (!(await this.features.isEnabled(scope, 'referral_signup_gift', tx))) return null;

    const current = await readSignupGiftTerms(this.settings, scope, tx);
    const proposed = this.withChange(current, change.to);
    const problem = signupGiftTermsProblem(proposed);
    if (problem === null) return null;
    throw errors.validation(
      COMMERCE_ERROR_CODES.REFERRAL_GIFT_TERMS_INVALID,
      problem === 'TOTAL_ZERO'
        ? 'The signup gift is on, so its total must be above zero.'
        : 'The signup gift is on, so the referrer and referred shares must total 100.',
      {
        key: this.key,
        problem,
        referrerPercent: proposed.referrerPercent,
        referredPercent: proposed.referredPercent,
        totalMinor: proposed.total.amountMinor.toString(),
      },
    );
  }

  /**
   * The terms as they would stand if this change committed. The proposed value has
   * passed the key's schema by the time a guard is asked; a shape that still does not
   * fit is refused as invalid terms rather than coerced into a number that passes.
   */
  private withChange(current: SignupGiftTerms, to: unknown): SignupGiftTerms {
    const invalid = () =>
      errors.validation(
        COMMERCE_ERROR_CODES.REFERRAL_GIFT_TERMS_INVALID,
        'The signup gift terms must be a money amount and two whole percents.',
        { key: this.key },
      );
    switch (this.key) {
      case 'referral.signup_gift.total': {
        if (typeof to !== 'object' || to === null) throw invalid();
        const candidate = to as { amountMinor?: unknown; currency?: unknown };
        if (typeof candidate.amountMinor !== 'string' || typeof candidate.currency !== 'string') {
          throw invalid();
        }
        return {
          ...current,
          total: money(BigInt(candidate.amountMinor), candidate.currency as Money['currency']),
        };
      }
      case 'referral.signup_gift.referrer_percent':
        if (typeof to !== 'number') throw invalid();
        return { ...current, referrerPercent: to };
      case 'referral.signup_gift.referred_percent':
        if (typeof to !== 'number') throw invalid();
        return { ...current, referredPercent: to };
    }
  }
}
