import {
  type PaymentGatewayEligibility,
  type PaymentGatewayIneligibilityReason,
  type PaymentGatewayStatus,
  type PhoneAllowedNumbers,
} from '@nexa/contracts';

/**
 * R11 B7: the bot-wide phone switch. NEXA v095 PR-4 A: on, it is MANDATORY — a customer with
 * no verified number and no exemption can do nothing in the bot until they verify. It no
 * longer governs a route's verified-phone rule (C): that rule stands on its own.
 */
export const PHONE_VERIFICATION_FLAG = 'phone_verification' as const;

/**
 * What a route's verified-phone rule may know about the customer (NEXA v095 PR-4 C/D):
 * `EXEMPT` — an operator exempted them («معاف از تأیید شماره»), so no rule asks them;
 * otherwise whether their phone number is verified. Independent of `phone_verification`.
 */
export type GatewayPhoneStanding = 'EXEMPT' | 'VERIFIED' | 'UNVERIFIED';

/**
 * NEXA v099 (owner): THE rule for a number stored as NOT accepted
 * (`customers.phone_not_accepted_at` — the customer's own non-+98 number, shared while
 * `phone_verification.allowed_numbers` was IRAN_ONLY): whether, under the setting as it is
 * NOW, it counts as a verified number. While IRAN_ONLY is on it satisfies nothing — not the
 * bot-wide gate, not the mini app's, not a route's verified-phone rule; once the owner
 * switches to ALL it counts as verified, with no re-share. Decided at READ time by every
 * reader, so the switch migrates nothing and can be switched back. One predicate for the
 * gate (`phoneGateOf`) and the route rule (`PaymentGatewayService.phoneStanding`).
 */
export function notAcceptedPhoneCounts(allowed: PhoneAllowedNumbers): boolean {
  return allowed === 'ALL';
}

/** What the evaluator is told about the customer, and nothing else. */
export interface GatewayAudience {
  /** Confirmed payments this customer has made. Never pending ones — see below. */
  readonly confirmedPayments: number;
  /** Whole days between the customer being first seen and now, floored. */
  readonly accountAgeDays: number;
  /**
   * R11 B7. NOT an eligibility input any more (NEXA v095 PR-4 C: a route with the rule is
   * SHOWN to every customer); it is what `phoneRuleRefuses` decides from where a payment is
   * about to be opened, and what an operator's `explain` reports. Absent refuses nothing.
   */
  readonly phone?: GatewayPhoneStanding;
}

/** NEXA v095 PR-4 C/D: the standing the customer row gives — an exemption wins. */
export function phoneStandingOf(verified: boolean, exempt: boolean): GatewayPhoneStanding {
  if (exempt) return 'EXEMPT';
  return verified ? 'VERIFIED' : 'UNVERIFIED';
}

/**
 * THE gate of a route's verified-phone rule (NEXA v095 PR-4 C): whether this route refuses
 * this customer a payment now. True only when the route has the rule AND the customer is
 * UNVERIFIED — never for an exempt or a verified customer, and whatever `phone_verification`
 * says. Asked inside the transaction that would open the payment, BEFORE any payment row
 * exists (every gateway attempt, every card-to-card transfer, for an order and a top-up), and
 * by the checkout before a draft is confirmed, so a refused tap holds no reservation.
 */
export function phoneRuleRefuses(
  eligibility: Pick<PaymentGatewayEligibility, 'requiresVerifiedPhone'>,
  phone: GatewayPhoneStanding | undefined,
): boolean {
  return eligibility.requiresVerifiedPhone === true && phone === 'UNVERIFIED';
}

/** Offered, or refused with the reason an operator can act on. */
export type GatewayEligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: PaymentGatewayIneligibilityReason };

/**
 * Whether this customer may use this route, and if not, which rule refused.
 *
 * Pure, total and synchronous: every input is a number or an enum, so the whole
 * decision table is a unit test rather than a fixture. That is deliberate — this is the
 * function that decides whether a person can give this installation money, and a rule
 * that can only be exercised through a database is a rule whose corners never get tested.
 *
 * ## The order of the checks is part of the answer
 *
 * `DISABLED` is checked first because it is not a fact about the customer at all, and
 * reporting `ACCOUNT_TOO_NEW` for a route the operator switched off would send them
 * looking at the wrong screen. After that the payment-count bounds precede the age
 * bound, so the reason names the condition an operator is most likely to have set
 * deliberately.
 *
 * ## Confirmed payments only
 *
 * `confirmedPayments` counts payments that actually settled. Counting pending ones would
 * make a route that unlocks after three payments unlockable by creating three invoices
 * and paying none — and `FBR-005`'s control is `پس از X پرداخت`, a payment, not an
 * attempt. The legacy system's own counter is not inspectable (`UNK-PR-007` leaves what
 * a receipt approval credits unresolved), so this is Nexa's reading and it is the
 * conservative one.
 *
 * ## Both bounds are inclusive at the threshold, and `0` is off
 *
 * `activateAfterPayments: 3` means three payments is enough — "after 3 payments" reads
 * as satisfied by the third, not the fourth. `deactivateAfterPayments: 10` hides the
 * route once the tenth lands. `WEB-BR-014` establishes `0` as "condition disabled",
 * which is why a zero threshold is not a bound that everybody trivially satisfies but a
 * check that does not run — the distinction matters for `deactivateAfterPayments`, where
 * "0 means everybody is past it" would hide the route from every customer alive.
 */
export function evaluateGatewayEligibility(
  status: PaymentGatewayStatus,
  eligibility: PaymentGatewayEligibility,
  audience: GatewayAudience,
): GatewayEligibility {
  if (status !== 'ACTIVE') return { eligible: false, reason: 'DISABLED' };

  const { activateAfterPayments, deactivateAfterPayments, activateAfterAccountDays } = eligibility;

  if (activateAfterPayments > 0 && audience.confirmedPayments < activateAfterPayments) {
    return { eligible: false, reason: 'TOO_FEW_PAYMENTS' };
  }
  if (deactivateAfterPayments > 0 && audience.confirmedPayments >= deactivateAfterPayments) {
    return { eligible: false, reason: 'TOO_MANY_PAYMENTS' };
  }
  if (activateAfterAccountDays > 0 && audience.accountAgeDays < activateAfterAccountDays) {
    return { eligible: false, reason: 'ACCOUNT_TOO_NEW' };
  }
  /*
   * NEXA v095 PR-4 C: the verified-phone rule is NOT checked here. A route that has it is
   * shown to every customer, and an unverified one is asked for their number when they pick
   * it (`phoneRuleRefuses`, at the payment's creation).
   */
  return { eligible: true };
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Whole days between two instants, floored, and never negative.
 *
 * Floored because a route that unlocks "after 7 days of membership" is not unlocked on
 * day 6 and 23 hours, and clamped at zero because a `firstSeenAt` in the future is a
 * clock disagreement rather than a negative age — treating it as one would make the age
 * check pass for a customer whose account does not exist yet.
 *
 * Elapsed milliseconds rather than calendar days, deliberately. A calendar-day count
 * needs a timezone to be meaningful, and the tenant's display timezone is a PRESENTATION
 * concern: deriving eligibility from it would make the same customer eligible or not
 * depending on a setting nobody associates with payment routes.
 */
export function accountAgeInDays(firstSeenAt: Date, now: Date): number {
  const elapsed = now.getTime() - firstSeenAt.getTime();
  if (elapsed <= 0) return 0;
  return Math.floor(elapsed / MILLISECONDS_PER_DAY);
}
