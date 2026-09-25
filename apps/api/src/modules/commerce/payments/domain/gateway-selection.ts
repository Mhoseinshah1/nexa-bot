import {
  money,
  type CurrencyCode,
  type Money,
  type PaymentMethod,
  type PaymentPurpose,
} from '@nexa/contracts';

/**
 * Which routes a customer is SHOWN, as pure functions over configuration.
 *
 * `gateway-eligibility.ts` answers "may THIS customer use this route" from the
 * thresholds. What is here is everything else the selector decides — purpose, amount
 * bounds, and which of the offered routes settle externally — kept pure for the reason
 * that file gives: these functions decide whether a person can give this installation
 * money, and a rule that can only be exercised through a database is a rule whose
 * corners never get tested. `gateway-selector.test.ts` runs them against FAKE
 * descriptors that never become rows; the CHECK constraint on `provider` keeps the
 * database honest about which providers actually exist.
 */

/** The two per-purpose switches a route carries (customer UX completion §D/§F). */
export interface RoutePurposeFlags {
  readonly allowServicePurchase: boolean;
  readonly allowWalletTopup: boolean;
}

/**
 * Whether a route is switched on for this purpose.
 *
 * A closed switch statement rather than a lookup keyed by the purpose name, so a third
 * `PaymentPurpose` is a compile error here rather than a route silently offered for a
 * purpose nobody configured a switch for.
 */
export function allowsPurpose(flags: RoutePurposeFlags, purpose: PaymentPurpose): boolean {
  switch (purpose) {
    case 'SERVICE_PURCHASE':
      return flags.allowServicePurchase;
    case 'WALLET_TOPUP':
      return flags.allowWalletTopup;
  }
}

/** The rows whose switch for this purpose is on, in the order they were given. */
export function filterRoutesByPurpose<T extends RoutePurposeFlags>(
  rows: readonly T[],
  purpose: PaymentPurpose,
): T[] {
  return rows.filter((row) => allowsPurpose(row, purpose));
}

/**
 * The offered routes that settle through an external gateway, in the order given.
 *
 * Decided from the DESCRIPTOR, never from the provider's name: this is the function
 * that decides whether the pre-invoice draws `پرداخت با درگاه`, and with every provider
 * in this release settling by `MANUAL_TRANSFER` it answers the empty list — so the
 * button is never drawn. When an external route lands, its descriptor says `GATEWAY`
 * and the branch already exists.
 */
export function externalRoutes<
  T extends { readonly descriptor: { readonly settlesVia: PaymentMethod } },
>(routes: readonly T[]): T[] {
  return routes.filter((route) => route.descriptor.settlesVia === 'GATEWAY');
}

/** A route's amount window, denominated. `maxAmount` null is "no ceiling". */
export interface RouteBounds {
  readonly minAmount: Money;
  readonly maxAmount: Money | null;
}

/**
 * The bounds a route stores, in the currency they were WRITTEN in.
 *
 * `fallbackCurrency` stands in only for a row the previous release wrote without one —
 * `gateway-ports.ts` says why that row exists and why it means exactly the currency
 * the amount is in. Never the amount's currency for a row that HAS its own: that
 * relabelling is how switching `sales.currency` once made every route accept a tenth
 * of what it had.
 */
export function boundsOf(
  gateway: {
    readonly minAmountMinor: bigint;
    readonly maxAmountMinor: bigint;
    readonly boundsCurrency: CurrencyCode | null;
  },
  fallbackCurrency: CurrencyCode,
): RouteBounds {
  const currency = gateway.boundsCurrency ?? fallbackCurrency;
  return {
    minAmount: money(gateway.minAmountMinor, currency),
    maxAmount: gateway.maxAmountMinor === 0n ? null : money(gateway.maxAmountMinor, currency),
  };
}

/** Why an amount fell outside a route's window, in the words the refusals use. */
export type AmountVerdict =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reason: 'BOUND_CURRENCY_MISMATCH' }
  | { readonly admitted: false; readonly reason: 'BELOW_MINIMUM'; readonly bound: Money }
  | { readonly admitted: false; readonly reason: 'ABOVE_MAXIMUM'; readonly bound: Money };

/**
 * Whether a route's window admits this amount.
 *
 * ONE statement of the rule, consumed two ways: `assertAmountAccepted` throws on it
 * with the refusal a misconfiguration deserves, and `routesFor` filters on it so a
 * customer choosing a route for a typed amount is shown only the routes that will
 * take it. A second copy of the comparison in either place would be the predicate
 * that disagrees with itself invisibly.
 *
 * A window in another currency admits NOTHING. Converting it would be the FX guess
 * the money model refuses, so it fails closed until the operator re-saves the bounds.
 */
export function decideAmount(bounds: RouteBounds, amount: Money): AmountVerdict {
  if (amount.currency !== bounds.minAmount.currency) {
    return { admitted: false, reason: 'BOUND_CURRENCY_MISMATCH' };
  }
  if (bounds.minAmount.amountMinor > 0n && amount.amountMinor < bounds.minAmount.amountMinor) {
    return { admitted: false, reason: 'BELOW_MINIMUM', bound: bounds.minAmount };
  }
  if (bounds.maxAmount !== null && amount.amountMinor > bounds.maxAmount.amountMinor) {
    return { admitted: false, reason: 'ABOVE_MAXIMUM', bound: bounds.maxAmount };
  }
  return { admitted: true };
}
