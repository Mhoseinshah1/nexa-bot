import {
  MAX_ORDER_QUANTITY,
  SUPPORT_CONTEXT_LIMITS,
  isPurchasable,
  type CurrencyCode,
  type Money,
  type ProductId,
  type TenantContext,
} from '@nexa/contracts';
import type { ProductService } from '../../catalog/application/product.service.js';
import type { ProductRecord, ProductRepository } from '../../catalog/application/ports.js';
import type { ServiceAddonRepository } from '../../catalog/application/addon-ports.js';
import type { PricingService } from '../../pricing/application/pricing.service.js';
import { quoteAddon, quoteProduct } from '../../orders/application/order-pricing.js';
import type { SupportFactFormatter } from '../domain/support-context-payload.js';
import type { SettingsResolver } from '../../../control/settings/application/settings-resolver.js';

/**
 * Phase 4 PR-2 — the live catalogue the support AI may quote from.
 *
 * Every price here is what the CHECKOUT of that line would quote this customer: the list price
 * (`quoteProduct` / `quoteAddon`, the base every draft hands the pricing boundary) priced by
 * `PricingService.quoteListPrices` — `quoteWith` over the same facts `price` reads, so the
 * customer's personal discount (R10 D3 / R11 A9), an automatic promotion and a reseller's tier
 * decide the figure exactly as they decide the invoice. Never a second calculation.
 *
 * READ-ONLY: nothing is drafted, quoted, stored or locked to learn a price.
 *
 * Which plans: the PUBLIC customer catalogue (`ProductService.publicCatalogue` — the browse's
 * own predicate: ACTIVE, for everyone, priced, on a panel that may take a new account, in a
 * visible category). A reseller is priced through the boundary's reseller layer; a plan their
 * table does not sell is left out. Reseller-only plans are not listed (decision recorded in the
 * PR). Packages: the offerable traffic and time packages in the tenant's sales currency, without
 * any one panel's per-purchase cap (the bot re-decides availability per service).
 */
export interface SupportCatalogueDeps {
  readonly catalogue: Pick<ProductService, 'publicCatalogue'>;
  readonly products: Pick<ProductRepository, 'findById'>;
  readonly addons: Pick<ServiceAddonRepository, 'listOfferable'>;
  readonly pricing: Pick<PricingService, 'quoteListPrices'>;
  readonly settings: Pick<SettingsResolver, 'valueOf'>;
  /** The bot's own duration and traffic formatters, behind the domain's port. */
  readonly format: Pick<SupportFactFormatter, 'durationDays' | 'trafficLimit'>;
}

export interface SupportCataloguePlan {
  readonly productId: string;
  readonly title: string;
  readonly duration: string;
  readonly traffic: string;
  readonly deviceLimit: number | null;
  readonly locations: string | null;
  readonly price: Money;
  readonly renewalPrice: Money | null;
  readonly personalDiscountPercent: number | null;
}

export interface SupportCatalogueAddon {
  readonly kind: 'ADD_TRAFFIC' | 'ADD_TIME';
  readonly title: string;
  readonly price: Money;
}

export interface SupportCatalogue {
  readonly plans: readonly SupportCataloguePlan[];
  readonly addons: readonly SupportCatalogueAddon[];
  /** What renewing each named service's own plan costs (purpose RENEW), by service id. */
  readonly renewals: ReadonlyMap<string, Money>;
}

/** A service, as far as its renewal price is concerned. */
export interface RenewableServiceFact {
  readonly id: string;
  readonly productId: string | null;
  /** `MIRZA`: an imported service renews from its panel's current plans, never its own. */
  readonly source: string;
}

export class SupportCatalogueReader {
  constructor(private readonly deps: SupportCatalogueDeps) {}

  async forCustomer(
    scope: TenantContext,
    customerId: string | null,
    services: readonly RenewableServiceFact[],
    now: Date,
  ): Promise<SupportCatalogue> {
    const currency = await this.deps.settings.valueOf<CurrencyCode>(scope, 'sales.currency');
    const page = await this.deps.catalogue.publicCatalogue(scope, SUPPORT_CONTEXT_LIMITS.catalogue);
    const plans = page.items.filter(
      (product): product is ProductRecord & { readonly price: Money } =>
        product.price !== null && product.price.currency === currency,
    );
    const [bought, renewed] = await Promise.all([
      this.priced(scope, 'NEW_SERVICE', customerId, plans, now),
      this.priced(scope, 'RENEW', customerId, plans, now),
    ]);
    const renewals = await this.renewals(scope, customerId, services, currency, now);
    const addons = await this.addons(scope, customerId, currency, now);
    return {
      plans: plans.flatMap((product) => {
        const quote = bought.get(product.id);
        if (quote === undefined) return [];
        return [
          {
            productId: product.id,
            title: product.title,
            duration: this.deps.format.durationDays(product.specification.durationDays),
            traffic: this.deps.format.trafficLimit(product.specification.trafficBytes),
            deviceLimit: product.specification.deviceLimit,
            locations:
              product.display.displayLocations.length === 0
                ? null
                : product.display.displayLocations.join('، '),
            price: quote.total,
            renewalPrice: renewed.get(product.id)?.total ?? null,
            personalDiscountPercent: quote.personalPercent,
          },
        ];
      }),
      addons,
      renewals,
    };
  }

  /** Each product's checkout quote for `purpose`, through the one pricing boundary. */
  private priced(
    scope: TenantContext,
    purpose: 'NEW_SERVICE' | 'RENEW',
    customerId: string | null,
    products: readonly (ProductRecord & { readonly price: Money })[],
    now: Date,
  ) {
    return this.deps.pricing.quoteListPrices(scope, {
      purpose,
      customerId,
      now,
      items: products.map((product) => ({
        id: product.id,
        base: quoteProduct(product, product.price, MAX_ORDER_QUANTITY, now),
        productId: product.id,
        categoryId: product.categoryId,
      })),
    });
  }

  /**
   * The RENEW quote of each service's own plan — `CommercialActionService.renewableProduct`'s
   * conditions: a product, still purchasable, priced, in the sales currency; never a custom
   * service (no product) and never an imported one (it renews from its panel's plans).
   */
  private async renewals(
    scope: TenantContext,
    customerId: string | null,
    services: readonly RenewableServiceFact[],
    currency: CurrencyCode,
    now: Date,
  ): Promise<ReadonlyMap<string, Money>> {
    if (customerId === null) return new Map();
    const productIds = [
      ...new Set(
        services.flatMap((service) =>
          service.productId === null || service.source === 'MIRZA' ? [] : [service.productId],
        ),
      ),
    ];
    const products = (
      await Promise.all(productIds.map((id) => this.deps.products.findById(scope, id as ProductId)))
    ).filter(
      (product): product is ProductRecord & { readonly price: Money } =>
        product !== null &&
        isPurchasable(product.status) &&
        product.price !== null &&
        product.price.currency === currency,
    );
    const quoted = await this.priced(scope, 'RENEW', customerId, products, now);
    const out = new Map<string, Money>();
    for (const service of services) {
      if (service.productId === null || service.source === 'MIRZA') continue;
      const quote = quoted.get(service.productId);
      if (quote !== undefined) out.set(service.id, quote.total);
    }
    return out;
  }

  /** The offerable traffic and time packages, each priced as `quoteAddon` prices its draft. */
  private async addons(
    scope: TenantContext,
    customerId: string | null,
    currency: CurrencyCode,
    now: Date,
  ): Promise<readonly SupportCatalogueAddon[]> {
    const out: SupportCatalogueAddon[] = [];
    for (const kind of ['ADD_TRAFFIC', 'ADD_TIME'] as const) {
      if (out.length >= SUPPORT_CONTEXT_LIMITS.addons) break;
      const page = await this.deps.addons.listOfferable(
        scope,
        kind,
        currency,
        SUPPORT_CONTEXT_LIMITS.addons - out.length,
      );
      const priced = page.items.filter(
        (addon): addon is typeof addon & { readonly price: Money } => addon.price !== null,
      );
      const quoted = await this.deps.pricing.quoteListPrices(scope, {
        purpose: kind,
        customerId,
        now,
        items: priced.map((addon) => ({
          id: addon.id,
          base: quoteAddon(addon.price, now),
          productId: null,
          categoryId: null,
        })),
      });
      for (const addon of priced) {
        const quote = quoted.get(addon.id);
        if (quote !== undefined) out.push({ kind, title: addon.title, price: quote.total });
      }
    }
    return out;
  }
}
