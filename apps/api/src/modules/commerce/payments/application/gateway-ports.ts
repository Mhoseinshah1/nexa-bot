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
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

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
    config: PaymentGatewayConfig,
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
}
