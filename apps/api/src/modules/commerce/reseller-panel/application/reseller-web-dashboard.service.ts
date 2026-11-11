import {
  RESELLER_WEB_DASHBOARD_LIST_SIZE,
  money,
  toWire,
  type CurrencyCode,
  type ResellerDashboard,
  type ResellerPricesResponse,
  type ScopeContext,
} from '@nexa/contracts';
import type { TemplatePresentation } from '../../../control/templates/application/ports.js';
import type { ProductService } from '../../catalog/application/product.service.js';
import type { WalletService } from '../../wallet/application/wallet.service.js';
import type { ResellerWebContext } from './reseller-web-access.service.js';
import type { ResellerWebServicesService } from './reseller-web-services.service.js';

export interface ResellerWebDashboardDeps {
  readonly wallet: Pick<WalletService, 'balanceForCustomer' | 'historyForCustomer'>;
  readonly services: Pick<ResellerWebServicesService, 'expiring'>;
  readonly products: Pick<ProductService, 'resellerPriceList'>;
  /** WP12's reseller sales, by the report's own statement, for ONE reseller. */
  readonly sales: {
    resellerSalesOf(
      scope: ScopeContext & { readonly tenantId: string },
      customerId: string,
      window: { readonly from: Date; readonly to: Date },
    ): Promise<
      readonly {
        readonly currency: CurrencyCode;
        readonly count: number;
        readonly amount: bigint;
      }[]
    >;
  };
  /** The reports' own month boundaries, in the tenant's calendar. */
  readonly periods: {
    month(
      which: 'THIS_MONTH',
      now: Date,
      presentation: TemplatePresentation,
    ): { readonly start: Date; readonly end: Date };
  };
  readonly presentation: { presentationFor(scope: ScopeContext): Promise<TemplatePresentation> };
  readonly clock: { now(): Date };
}

/**
 * PR-4 §5.2 — the reseller's dashboard and price list, composed from the services the bot
 * and the reports already use. Reads only: nothing here prices a sale, moves money or writes.
 */
export class ResellerWebDashboardService {
  constructor(private readonly deps: ResellerWebDashboardDeps) {}

  async dashboard(context: ResellerWebContext): Promise<ResellerDashboard> {
    const now = this.deps.clock.now();
    const balance = await this.deps.wallet.balanceForCustomer(
      context.scope,
      context.actor,
      context.customer.id,
    );
    const expiring = await this.deps.services.expiring(context, RESELLER_WEB_DASHBOARD_LIST_SIZE);
    const presentation = await this.deps.presentation.presentationFor(context.scope);
    // «فروش این ماه»: the current calendar month, half-open, in the tenant's calendar.
    const month = this.deps.periods.month('THIS_MONTH', now, presentation);
    const sales = await this.deps.sales.resellerSalesOf(context.scope, context.customer.id, {
      from: month.start,
      to: month.end,
    });
    const history = await this.deps.wallet.historyForCustomer(
      context.scope,
      context.actor,
      context.customer.id,
      { limit: RESELLER_WEB_DASHBOARD_LIST_SIZE },
    );
    const { reseller, tier } = context.standing;
    return {
      balance: toWire(money(balance.amountMinor, balance.currency)),
      activeServices: expiring.active,
      monthSales: {
        count: sales.reduce((sum, row) => sum + row.count, 0),
        amount: sales.map((row) => toWire(money(row.amount, row.currency))),
      },
      expiringCount: expiring.count,
      expiring: expiring.rows,
      tier: {
        name: tier.name,
        pricingMode: reseller.pricingMode === 'TIER' ? tier.pricingMode : reseller.pricingMode,
        discountPercent: reseller.discountPercentage ?? null,
      },
      recentTransactions: history.items.map((entry) => ({
        id: entry.id,
        direction: entry.direction,
        reason: entry.reason,
        amount: toWire(entry.amount),
        at: entry.createdAt.toISOString(),
      })),
    };
  }

  /** «لیست قیمت»: list price, the reseller's price and the discount, by category. */
  async prices(context: ResellerWebContext): Promise<ResellerPricesResponse> {
    const groups = await this.deps.products.resellerPriceList(
      context.scope,
      context.actor,
      context.customer.id,
    );
    return {
      groups: groups.map((group) => ({
        categoryId: group.category.id,
        title: group.category.name,
        items: group.items.map(({ product, listPrice, offered }) => ({
          productId: product.id,
          title: product.title,
          trafficBytes:
            product.specification.trafficBytes === null
              ? null
              : product.specification.trafficBytes.toString(),
          durationDays: product.specification.durationDays,
          listPrice: toWire(listPrice),
          yourPrice: toWire(offered),
          discountPercent: discountPercent(listPrice.amountMinor, offered.amountMinor),
        })),
      })),
    };
  }
}

/** Whole percent off the list, floored, 0 when the reseller pays list or more. */
export function discountPercent(list: bigint, offered: bigint): number {
  if (list <= 0n || offered >= list) return 0;
  return Number(((list - offered) * 100n) / list);
}
