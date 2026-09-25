import {
  COMMERCE_ERROR_CODES,
  errors,
  type FeatureFlagKey,
  type ScopeContext,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { SettingsResolver } from '../../settings/application/settings-resolver.js';
import {
  readSignupGiftTerms,
  readWalletCurrency,
  signupGiftTermsProblem,
  signupGiftTermsProblemMessage,
} from '../../settings/application/signup-gift-terms.guard.js';
import type { FlagActivationGuard } from './feature-flags.service.js';

/**
 * `referral_signup_gift` may not turn on over terms that cannot pay a gift.
 *
 * The other half of `SignupGiftTermsGuard`: that one holds the terms coherent while the
 * flag is on, this one refuses the flag while they are not. Without it an operator could
 * switch the gift on at 60/30 and every customer's claim would be refused with a code
 * that names the terms — after the button had been drawn.
 */
export class SignupGiftActivationGuard implements FlagActivationGuard {
  readonly key: FeatureFlagKey = 'referral_signup_gift';

  constructor(private readonly settings: SettingsResolver) {}

  async assertMayEnable(scope: ScopeContext, tx: TransactionScope): Promise<void> {
    const [terms, walletCurrency] = await Promise.all([
      readSignupGiftTerms(this.settings, scope, tx),
      readWalletCurrency(this.settings, scope, tx),
    ]);
    const problem = signupGiftTermsProblem(terms, walletCurrency);
    if (problem === null) return;
    throw errors.validation(
      COMMERCE_ERROR_CODES.REFERRAL_GIFT_TERMS_INVALID,
      signupGiftTermsProblemMessage(problem, 'ENABLING'),
      {
        key: this.key,
        problem,
        referrerPercent: terms.referrerPercent,
        referredPercent: terms.referredPercent,
        totalMinor: terms.total.amountMinor.toString(),
        currency: terms.total.currency,
        walletCurrency,
      },
    );
  }
}
