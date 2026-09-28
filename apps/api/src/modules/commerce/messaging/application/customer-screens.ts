import {
  UNLIMITED_TRAFFIC_BYTES,
  type Money,
  type PaymentGatewayProvider,
  type ProviderLastSeen,
  type ScopeContext,
  type ServiceState,
  type TemplateKey,
  type TemplateValues,
} from '@nexa/contracts';
import type { TemplateResolver } from '../../../control/templates/application/template-resolver.js';

/**
 * The customer screens that are COMPOSED (docs/customer-ux-completion-audit.md §M).
 *
 * Each screen is one main key plus per-line keys. The surface cannot render a sub-line
 * itself — `check-boundaries.sh` keeps the template resolver out of the surfaces — so
 * this application service renders the pieces and hands the surface a `{ key, values }`
 * it can send. Every figure comes from a row or a setting the caller read; nothing here
 * decides a fact, and nothing here is persisted.
 */
export interface ComposedScreen {
  readonly key: TemplateKey;
  readonly values: TemplateValues;
}

export interface PreinvoiceFacts {
  readonly serviceUsername: string | null;
  readonly productName: string;
  /** Validity bought; null for a traffic-only package. */
  readonly durationDays: number | null;
  readonly total: Money;
  /** The plan's allowance; null for a time-only package. */
  readonly trafficBytes: bigint | null;
  /** What an add-traffic package adds; null otherwise. */
  readonly addedTrafficBytes: bigint | null;
  readonly discount: { readonly subtotal: Money; readonly discount: Money } | null;
  readonly cashback: Money | null;
  readonly locations: readonly string[];
  readonly features: readonly string[];
  readonly walletBalance: Money;
  /**
   * A custom service's breakdown (Package D), from the order's frozen terms; null or
   * absent for every other order.
   */
  readonly custom?: {
    readonly location: string;
    readonly volumeBytes: bigint;
    readonly pricePerGb: Money;
    readonly volumePrice: Money;
    readonly durationDays: number;
    readonly pricePerDay: Money;
    readonly timePrice: Money;
  } | null;
}

export interface WalletSummaryFacts {
  readonly telegramId: string;
  readonly displayName: string;
  readonly registeredAt: Date;
  readonly balance: Money;
  readonly serviceCount: number;
  readonly paidInvoiceCount: number;
  readonly referralCount: number;
  readonly group: 'CUSTOMER' | 'RESELLER';
}

export interface ServiceCardFacts {
  readonly state: ServiceState;
  readonly serviceUsername: string;
  readonly serviceLocation: string | null;
  readonly productName: string;
  readonly trafficLimitBytes: bigint;
  readonly trafficUsedBytes: bigint;
  /** Null means usage was never read: the figures are unknown, never 0. */
  readonly usageSyncedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly now: Date;
  readonly lastSeen: ProviderLastSeen;
  readonly note: string | null;
  /** Drawn only when the rotate button is: the hint names a button. */
  readonly rotateOffered: boolean;
}

/** What a transfer's summary shows of a service (Package F). */
export interface ServiceSummaryFacts {
  readonly serviceUsername: string;
  readonly serviceLocation: string | null;
  readonly trafficLimitBytes: bigint;
  readonly trafficUsedBytes: bigint;
  /** Null means usage was never read: what is left is unknown, never the whole allowance. */
  readonly usageSyncedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly now: Date;
}

export interface ReferralScreenFacts {
  readonly commissionPercent: number;
  readonly referralLink: string;
  readonly gift: {
    readonly total: Money;
    readonly referrerPercent: number;
    readonly referredPercent: number;
  } | null;
  readonly referralCount: number;
  readonly referredPurchaseCount: number;
  readonly referredPurchaseTotal: Money;
  readonly commissionReceivedTotal: Money;
}

const STATE_KEYS: Readonly<Record<ServiceState, TemplateKey>> = {
  PENDING_PROVISION: 'bot.service.state_pending_provision',
  ACTIVE: 'bot.service.state_active',
  SUSPENDED: 'bot.service.state_suspended',
  EXPIRED: 'bot.service.state_expired',
  TERMINATED: 'bot.service.state_terminated',
  UNRECONCILED: 'bot.service.state_unreconciled',
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** One key per route this installation can operate; grows with `PAYMENT_GATEWAY_PROVIDERS`. */
const ROUTE_NAME_KEYS: Readonly<Record<PaymentGatewayProvider, TemplateKey>> = {
  MANUAL_TRANSFER: 'bot.payment.route_name_manual_transfer',
  TONPAYS: 'bot.payment.route_name_tonpays',
  TELEGRAM_STARS: 'bot.payment.route_name_telegram_stars',
};

export class CustomerScreenComposer {
  constructor(private readonly templates: Pick<TemplateResolver, 'render'>) {}

  async preinvoice(scope: ScopeContext, facts: PreinvoiceFacts): Promise<ComposedScreen> {
    const lines = (items: readonly string[]) => items.join('\n');
    const values: TemplateValues = {
      ...(facts.serviceUsername === null ? {} : { serviceUsername: facts.serviceUsername }),
      productName: facts.productName,
      ...(facts.durationDays === null ? {} : { durationDays: facts.durationDays }),
      total: facts.total,
      ...(facts.trafficBytes === null ? {} : { trafficBytes: facts.trafficBytes }),
      ...(facts.addedTrafficBytes === null ? {} : { addedTrafficBytes: facts.addedTrafficBytes }),
      ...(facts.discount === null
        ? {}
        : {
            discountLine: await this.templates.render(scope, 'bot.order.preinvoice_discount_line', {
              discount: facts.discount.discount,
              subtotal: facts.discount.subtotal,
            }),
          }),
      ...(facts.cashback === null
        ? {}
        : {
            cashbackLine: await this.templates.render(scope, 'bot.order.preinvoice_cashback_line', {
              cashback: facts.cashback,
            }),
          }),
      ...(facts.locations.length === 0
        ? {}
        : {
            locationsBlock: await this.templates.render(scope, 'bot.order.preinvoice_locations', {
              lines: lines(facts.locations),
            }),
          }),
      ...(facts.features.length === 0
        ? {}
        : {
            featuresBlock: await this.templates.render(scope, 'bot.order.preinvoice_features', {
              lines: lines(facts.features),
            }),
          }),
      ...(facts.custom === null || facts.custom === undefined
        ? {}
        : {
            customBlock: await this.templates.render(scope, 'bot.order.preinvoice_custom', {
              location: facts.custom.location,
              volumeBytes: facts.custom.volumeBytes,
              pricePerGb: facts.custom.pricePerGb,
              volumePrice: facts.custom.volumePrice,
              durationDays: facts.custom.durationDays,
              pricePerDay: facts.custom.pricePerDay,
              timePrice: facts.custom.timePrice,
            }),
          }),
      walletBalance: facts.walletBalance,
    };
    return { key: 'bot.order.preinvoice', values };
  }

  async walletSummary(scope: ScopeContext, facts: WalletSummaryFacts): Promise<ComposedScreen> {
    return {
      key: 'bot.wallet.summary',
      values: {
        telegramId: facts.telegramId,
        displayName: facts.displayName,
        // Always "not sent": this installation stores no phone number and asks for none.
        phoneState: await this.templates.render(scope, 'bot.wallet.phone_missing', {}),
        registeredAt: facts.registeredAt,
        balance: facts.balance,
        serviceCount: facts.serviceCount,
        paidInvoiceCount: facts.paidInvoiceCount,
        referralCount: facts.referralCount,
        customerGroup: await this.templates.render(
          scope,
          facts.group === 'RESELLER' ? 'bot.wallet.group_reseller' : 'bot.wallet.group_customer',
          {},
        ),
      },
    };
  }

  async serviceCard(scope: ScopeContext, facts: ServiceCardFacts): Promise<ComposedScreen> {
    const known = facts.usageSyncedAt !== null;
    const usedTraffic = known
      ? await this.templates.render(scope, 'bot.service.traffic_value', {
          bytes: facts.trafficUsedBytes,
        })
      : await this.templates.render(scope, 'bot.service.traffic_unknown', {});
    const remainingTraffic = await this.remainingTraffic(scope, facts);

    const lastSeen =
      facts.lastSeen.kind === 'AT'
        ? await this.templates.render(scope, 'bot.service.last_seen_at', { at: facts.lastSeen.at })
        : facts.lastSeen.kind === 'NEVER'
          ? await this.templates.render(scope, 'bot.service.last_seen_never', {})
          : await this.templates.render(scope, 'bot.service.last_seen_unavailable', {});

    const expiry = await this.expiry(scope, facts);

    return {
      key: 'bot.service.card',
      values: {
        status: await this.templates.render(scope, STATE_KEYS[facts.state], {}),
        serviceUsername: facts.serviceUsername,
        ...(facts.serviceLocation === null ? {} : { serviceLocation: facts.serviceLocation }),
        productName: facts.productName,
        trafficBytes: facts.trafficLimitBytes,
        usedTraffic,
        remainingTraffic,
        ...expiry,
        lastSeen,
        ...(facts.note === null ? {} : { note: facts.note }),
        ...(facts.rotateOffered
          ? { rotateHint: await this.templates.render(scope, 'bot.service.rotate_hint', {}) }
          : {}),
      },
    };
  }

  /**
   * A service's name, location and what is left of it (Package F): the lines a transfer's
   * confirmation and the recipient's notification show. The same pieces, rendered the same
   * way, as the service card — so the two screens cannot disagree about what is left.
   */
  async serviceSummary(scope: ScopeContext, facts: ServiceSummaryFacts): Promise<TemplateValues> {
    return {
      service: facts.serviceUsername,
      ...(facts.serviceLocation === null ? {} : { location: facts.serviceLocation }),
      remainingTraffic: await this.remainingTraffic(scope, facts),
      ...(await this.expiry(scope, facts)),
    };
  }

  /** What is left of the allowance: a figure with its percentage, unlimited, or unknown. */
  private async remainingTraffic(
    scope: ScopeContext,
    facts: Pick<ServiceSummaryFacts, 'trafficLimitBytes' | 'trafficUsedBytes' | 'usageSyncedAt'>,
  ): Promise<string> {
    if (facts.trafficLimitBytes === UNLIMITED_TRAFFIC_BYTES) {
      return this.templates.render(scope, 'bot.service.remaining_unlimited', {});
    }
    if (facts.usageSyncedAt === null) {
      return this.templates.render(scope, 'bot.service.traffic_unknown', {});
    }
    const remaining =
      facts.trafficUsedBytes >= facts.trafficLimitBytes
        ? 0n
        : facts.trafficLimitBytes - facts.trafficUsedBytes;
    // Whole percent, rounded DOWN: a customer with 0.9% left is told 0%, never 1%.
    const percent = Number((remaining * 100n) / facts.trafficLimitBytes);
    return this.templates.render(scope, 'bot.service.remaining_value', {
      bytes: remaining,
      percent,
    });
  }

  /** The deadline and the whole days to it, or the rendered no-expiry line. */
  private async expiry(
    scope: ScopeContext,
    facts: Pick<ServiceSummaryFacts, 'expiresAt' | 'now'>,
  ): Promise<TemplateValues> {
    if (facts.expiresAt === null) {
      return { noExpiry: await this.templates.render(scope, 'bot.service.no_expiry', {}) };
    }
    return {
      expiresAt: facts.expiresAt,
      remainingDays: Math.max(
        0,
        Math.ceil((facts.expiresAt.getTime() - facts.now.getTime()) / DAY_MS),
      ),
    };
  }

  /**
   * A payment route's name as the customer sees it: the operator's display name, else
   * the product's own name for the route from the catalogue.
   */
  async routeName(
    scope: ScopeContext,
    route: { readonly provider: PaymentGatewayProvider; readonly displayName: string | null },
  ): Promise<string> {
    if (route.displayName !== null) return route.displayName;
    return this.templates.render(scope, ROUTE_NAME_KEYS[route.provider], {});
  }

  async referralScreen(scope: ScopeContext, facts: ReferralScreenFacts): Promise<ComposedScreen> {
    return {
      key: 'bot.referral.screen',
      values: {
        commissionPercent: facts.commissionPercent,
        referralLink: facts.referralLink,
        ...(facts.gift === null
          ? {}
          : {
              giftBlock: await this.templates.render(scope, 'bot.referral.gift_block', {
                total: facts.gift.total,
                referrerPercent: facts.gift.referrerPercent,
                referredPercent: facts.gift.referredPercent,
              }),
            }),
        referralCount: facts.referralCount,
        referredPurchaseCount: facts.referredPurchaseCount,
        referredPurchaseTotal: facts.referredPurchaseTotal,
        commissionReceivedTotal: facts.commissionReceivedTotal,
      },
    };
  }
}
