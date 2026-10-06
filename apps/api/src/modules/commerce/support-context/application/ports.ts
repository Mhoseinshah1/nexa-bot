import type {
  CurrencyCode,
  OrderPurpose,
  OrderState,
  PaymentGatewayProvider,
  PaymentMethod,
  PaymentState,
  TenantContext,
  UserId,
} from '@nexa/contracts';

/**
 * TB3 — the customer-scoped reads the support context needs that no existing reader
 * answers (ADR-0034 §4).
 *
 * Every method is a READ, takes the customer id as a REQUIRED argument (the scoping IS the
 * authorisation, as for `ProvisioningService.pageForCustomer`), puts the tenant and the
 * customer in the WHERE, is one statement, and is bounded by `limit`. None takes a
 * permission: the caller is the support agent acting for the conversation's own customer,
 * and `SYSTEM_JOB` holds no operator permission to charge.
 *
 * Each returns the minimum it needs. A row id appears only where the builder keeps it on
 * the server as an alias's target; it never reaches the payload.
 */
export interface SupportContextReader {
  /** The customer's newest orders, `DRAFT` excluded (a quote nobody confirmed), DESC. */
  recentOrders(
    scope: TenantContext,
    customerId: UserId,
    limit: number,
  ): Promise<readonly SupportOrderFact[]>;

  /**
   * The customer's newest payments, DESC, each with `underReview` computed in SQL from the
   * Payment Operations Center's own queue predicates, and `anyUnderReview` over ALL of the
   * customer's payments (not only the ones returned).
   */
  recentPayments(
    scope: TenantContext,
    customerId: UserId,
    limit: number,
  ): Promise<{ readonly items: readonly SupportPaymentFact[]; readonly anyUnderReview: boolean }>;

  /**
   * L4: whether ANY of the customer's services is UNRECONCILED — over all of them, not the page
   * the payload shows (`hasUnreconciledService`).
   */
  anyUnreconciledService(scope: TenantContext, customerId: UserId): Promise<boolean>;

  /**
   * ACTIVE incidents with a customer message that reach this customer under the notice
   * audience's own rule (`IncidentRepository.audience`): a live service on the incident's
   * scope, or any live service when the incident names no panel, location or product.
   */
  activeIncidentNotices(
    scope: TenantContext,
    customerId: UserId,
    limit: number,
  ): Promise<readonly SupportIncidentFact[]>;

  /**
   * For each `(orderId, productId)` pair, the order line's title (the customer's own order
   * only) and the product's customer-visible location label — ONE statement for the whole
   * page of services, aligned with the input by index.
   */
  serviceCardFacts(
    scope: TenantContext,
    customerId: UserId,
    refs: readonly { readonly orderId: string; readonly productId: string | null }[],
  ): Promise<readonly SupportServiceCardFact[]>;
}

export interface SupportOrderFact {
  readonly id: string;
  readonly state: OrderState;
  readonly purpose: OrderPurpose;
  readonly title: string;
  readonly totalMinor: bigint;
  readonly currency: CurrencyCode;
  readonly createdAt: Date;
  readonly settledAt: Date | null;
  readonly expiresAt: Date | null;
}

export interface SupportPaymentFact {
  readonly id: string;
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
  readonly method: PaymentMethod;
  readonly gatewayProvider: PaymentGatewayProvider | null;
  readonly state: PaymentState;
  readonly underReview: boolean;
  readonly createdAt: Date;
  readonly confirmedAt: Date | null;
}

export interface SupportIncidentFact {
  readonly customerMessage: string;
  readonly startedAt: Date;
  readonly scheduledEndAt: Date | null;
}

export interface SupportServiceCardFact {
  /** The order line's title; null when the order is not this customer's (never expected). */
  readonly title: string | null;
  /** The product's `service_location_label`; null for none or for a custom service. */
  readonly productLocationLabel: string | null;
}

/**
 * TB8 — approved support knowledge (ADR-0035 §1). The implementation's query names
 * `state = 'APPROVED' AND enabled` in SQL: a draft, a retired article and a learning candidate
 * are unreachable from here by construction.
 */
export interface SupportKnowledgeReader {
  activeForContext(
    scope: TenantContext,
    limit: number,
  ): Promise<
    readonly {
      readonly title: string;
      readonly body: string;
      /** D2: the reviewer's tags, which the relevance score reads. */
      readonly tags: readonly string[];
      /** TB9: the source a NEXA_BUILD article was built from; null for any other article. */
      readonly sourceType: string | null;
      readonly sourceKey: string | null;
    }[]
  >;
}
