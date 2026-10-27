import type {
  PaymentGatewayConfig,
  SalesCurrencyCode,
  PaymentGatewayProvider,
  PaymentGatewayStatus,
  TenantContext,
  UserId,
} from '@nexa/contracts';

/**
 * One configured payment route, as the application layer holds it.
 *
 * No id, because `(tenant, provider)` IS the identity —
 * `packages/contracts/src/payment-gateways.ts` records why, and the short form is that a
 * surface then addresses a route with a value from a closed enum rather than with a
 * string it has to remember to scope.
 *
 * `displayName` is nullable and `null` means "the product's own name for this route".
 * That is what lets a route exist before an operator has typed anything, which is the
 * state every upgraded installation starts in.
 */
export interface PaymentGatewayRecord {
  readonly provider: PaymentGatewayProvider;
  readonly status: PaymentGatewayStatus;
  readonly displayName: string | null;
  readonly instructions: string | null;
  readonly minAmountMinor: bigint;
  readonly maxAmountMinor: bigint;
  /**
   * The denomination the bounds were written in. Compared, never converted. NULL for a
   * row the previous release wrote after the backfill ran — `schema.ts` says why the
   * column stays nullable this release — and a reader treats that as the installation's
   * current currency, the one that release meant.
   */
  readonly boundsCurrency: SalesCurrencyCode | null;
  readonly activateAfterPayments: number;
  readonly deactivateAfterPayments: number;
  readonly activateAfterAccountDays: number;
  readonly sortOrder: number;
  /**
   * The top-up gift this route promises, 0–100 (D5). A top-up SNAPSHOTS it onto the
   * payment when created; it is read here, never at confirmation.
   */
  readonly topupCashbackPercent: number;
  /**
   * The customer's gateway fee in basis points (WP18). Non-zero only on a route that
   * settles through `GATEWAY`. A gateway attempt SNAPSHOTS it onto the payment when
   * created; it is read here, never at confirmation.
   */
  readonly customerFeeBasisPoints: number;
  /**
   * A `FIXED_RATE` route's rate (Package A): sales-currency minor units per ONE provider
   * unit — for Stars, the owner's `toman_per_star`. Null until an operator sets it; such a
   * route cannot be enabled. Read here and SNAPSHOTTED onto each attempt's invoice.
   */
  readonly providerUnitRateMinor: bigint | null;
  /**
   * What the route may be offered FOR (customer UX completion §D/§F). `status` decides
   * whether it is offered at all; these decide for which purpose. An operator may take
   * card-to-card for a top-up and not for a purchase, or the reverse, and one switch
   * for both is a route that is on for something it was never meant for.
   */
  readonly allowServicePurchase: boolean;
  readonly allowWalletTopup: boolean;
  /**
   * R11 B7: offered only to a customer with a verified phone number, and only while the
   * `phone_verification` flag is on. Optional so a narrow test fake need not carry it;
   * absent is false.
   */
  readonly requiresVerifiedPhone?: boolean;
  /**
   * Round 6 item 6: until when the PROVIDER's own daily limit hides this route (TetraPay), or
   * null. Not `status`: the operator's switch is untouched, and the route returns by itself
   * when the instant passes. A route is not offered while this is after the clock.
   */
  readonly hiddenUntil: Date | null;
  /**
   * Round 10 C1: an `operatorEndpoint` route's bridge (the custom gateway): its `https://` base
   * URL, or null until an operator sets one (such a route cannot be enabled), and the callback
   * IP allow-list, empty for no address check. Null / empty on every other route. Optional on
   * the record so a narrow test fake need not carry them.
   */
  readonly endpointBaseUrl?: string | null;
  readonly webhookIpAllowlist?: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Everything `update` writes: the config, with every optional field already decided. */
export type StoredGatewayConfig = PaymentGatewayConfig & {
  readonly customerFeeBasisPoints: number;
  readonly providerUnitRateMinor: bigint | null;
  readonly requiresVerifiedPhone: boolean;
};

export interface PaymentGatewayRepository {
  /**
   * EVERY route this tenant has, in render order, with no cursor.
   *
   * Complete by construction for a stronger reason than the account list's: the roster
   * cannot exceed `PAYMENT_GATEWAY_PROVIDERS`, so there is no bound to enforce and no
   * page to miss a row in.
   */
  list(scope: TenantContext, tx?: unknown): Promise<readonly PaymentGatewayRecord[]>;

  find(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
    tx?: unknown,
  ): Promise<PaymentGatewayRecord | null>;

  /**
   * The route's row, FOR UPDATE, in the caller's transaction. Spec §8 (Codex review of
   * #143): switching a central-rate route ON and clearing its unit ratio are writes to two
   * different rows that each judge the other; both take THIS lock first, so they serialise
   * and the second sees what the first committed.
   */
  lockForUpdate(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
    tx: unknown,
  ): Promise<PaymentGatewayRecord | null>;

  /**
   * Creates the routes this release can operate, for a tenant that has none.
   *
   * `ON CONFLICT DO NOTHING`, so it is idempotent and so a route an operator has since
   * tuned is never reset — the same property migration 0071 relies on for the upgrade
   * path. Returns how many rows it actually wrote, because "nothing to do" and "created
   * the tenant's first route" are different facts to a caller that logs.
   */
  ensureDefaults(
    scope: TenantContext,
    currency: SalesCurrencyCode,
    now: Date,
    tx?: unknown,
  ): Promise<number>;

  /** Replaces one route's configuration. Null when there is no such route. */
  update(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
    config: StoredGatewayConfig,
    currency: SalesCurrencyCode,
    now: Date,
    tx: unknown,
  ): Promise<PaymentGatewayRecord | null>;

  /**
   * Moves one route to a status, only FROM a status it is not already in.
   *
   * Conditional on the current value rather than a blind SET, which makes a
   * double-click and a replayed request both no-ops that report the truth: `null` says
   * either the route is gone or it was already there, and the caller re-reads to tell
   * those apart. The rule ADR-0028 states for recovery, applied to the one gateway
   * change a customer notices immediately.
   */
  setStatus(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
    input: { readonly from: PaymentGatewayStatus; readonly to: PaymentGatewayStatus },
    now: Date,
    tx: unknown,
  ): Promise<PaymentGatewayRecord | null>;

  /**
   * Hides a route until `until` because the provider said its daily limit was reached.
   * Only ever LATER: a hiding already in force until a later instant is not shortened by an
   * earlier one. `status`, the configuration and `updated_at` are untouched — an operator's
   * form open on this route still saves. False when there is no such route.
   */
  hideUntil(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
    until: Date,
    now: Date,
    tx: unknown,
  ): Promise<boolean>;

  /**
   * Round 10 C1: points an `operatorEndpoint` route at its bridge — conditional on the route
   * being DISABLED (named in the WHERE, never checked and then written), so an enable that
   * commits first makes this a no-op that says so. Null when no DISABLED route matched.
   */
  setEndpoint(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
    input: { readonly baseUrl: string; readonly ipAllowlist: readonly string[] },
    now: Date,
    tx: unknown,
  ): Promise<PaymentGatewayRecord | null>;

  /**
   * Codex on #336 (2): how many of this route's attempts frozen to a bridge address OTHER than
   * `baseUrl` are still open — no outcome recorded, and either the payment is still PENDING or
   * UNKNOWN (held for review) or Nexa will still ask about it (`next_inquiry_at` set: a
   * decision retry, a late poll). Each is asked, and its callbacks verified, with the route's
   * ONE current secret, so the address may not move while any is open.
   */
  openAttemptsElsewhere(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
    baseUrl: string,
    tx: unknown,
  ): Promise<number>;
}

/**
 * What the eligibility rules need to know about one customer.
 *
 * Its own port rather than a method on the payment repository, because the two counts
 * come from different tables and neither is a payment query: one is a count of settled
 * payments, the other is the customer row's own age. A caller that had to assemble them
 * would be the place the definition of "a payment" quietly drifted.
 */
export interface GatewayAudienceReader {
  /**
   * CONFIRMED payments by this customer, and only confirmed ones.
   *
   * Counting pending payments would make a route that unlocks after three payments
   * unlockable by creating three invoices and paying none. `FBR-005`'s control is
   * `پس از X پرداخت` — a payment, not an attempt.
   */
  confirmedPaymentCount(scope: TenantContext, customerId: UserId, tx?: unknown): Promise<number>;

  /**
   * When this customer was first seen, or `null` if the tenant has no such customer.
   *
   * `first_seen_at` rather than `created_at`: the legacy control is
   * `پس از X روز عضویت` — days of MEMBERSHIP — and first-seen is when the person
   * arrived. The two are written together today, and naming the one that means what the
   * rule means is what keeps them from diverging silently later.
   */
  firstSeenAt(scope: TenantContext, customerId: UserId, tx?: unknown): Promise<Date | null>;

  /**
   * R11 B7: whether this customer's phone number is verified (`phone_verified_at` is set),
   * however it was — by an operator or by their own contact. False for a customer the
   * tenant does not have, which is the conservative answer: a route that requires a
   * verified number is refused to them.
   */
  phoneVerified(scope: TenantContext, customerId: UserId, tx?: unknown): Promise<boolean>;
}
