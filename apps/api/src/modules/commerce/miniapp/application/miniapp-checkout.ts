import {
  money,
  PAYMENT_GATEWAY_DESCRIPTORS,
  type ActorContext,
  type Money,
  type PaymentGatewayProvider,
  type PaymentPurpose,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { OrderRecord } from '../../orders/application/ports.js';
import type { TopupRoute } from '../../payments/application/wallet-topup-flow.service.js';

/**
 * The three decisions `docs/telegram-runtime.md` lists as still made in the bot's surface
 * and that a second surface must make the same way (Round 9, C5). They are stated here ONCE
 * for the mini app, rule for rule as the bot's flow makes them, and the authoritative check
 * behind each stays the service's own (`settleFromWallet`, the confirm lanes, the routes
 * each payment re-decides in its transaction):
 *
 * - which lane confirms a DRAFT (`purchase-flow.ts` `confirmDraft`);
 * - which routes an order offers (`checkout-flow.ts` `orderRouteButtons`);
 * - whether the wallet covers a total, and the shortfall (`checkout-flow.ts` `walletPayment`).
 *
 * Moving the bot onto this module is the follow-up that makes it one implementation; it is
 * not done in this round because the bot's keyboards must stay byte-identical.
 */
export interface MiniAppCheckoutDeps {
  readonly orders: {
    confirm(
      scope: TenantContext,
      actor: ActorContext,
      input: {
        readonly idempotencyKey: string;
        readonly customerId: string;
        readonly orderId: string;
      },
    ): Promise<OrderRecord>;
  };
  readonly commercial: {
    confirm(
      scope: TenantContext,
      actor: ActorContext,
      customerId: UserId,
      input: { readonly orderId: string; readonly idempotencyKey: string },
    ): Promise<OrderRecord>;
  };
  readonly routes: {
    routesFor(
      scope: TenantContext,
      customerId: UserId,
      purpose: PaymentPurpose,
      amount: Money | null,
    ): Promise<readonly TopupRoute[]>;
  };
  readonly payments: {
    manualTransferOffered(scope: TenantContext, purpose?: PaymentPurpose): Promise<boolean>;
  };
  readonly screens: {
    routeName(
      scope: TenantContext,
      route: { readonly provider: PaymentGatewayProvider; readonly displayName: string | null },
    ): Promise<string>;
  };
}

export interface OfferedRoute {
  readonly provider: PaymentGatewayProvider;
  readonly kind: 'GATEWAY' | 'CARD_TO_CARD';
  readonly name: string;
  /** The invoice is a message in the bot's chat (Stars, a Telegram-bound gateway). */
  readonly paysInChat: boolean;
  readonly giftPercent: number;
}

/** Whether a gateway's invoice is paid in the bot's chat rather than on a page. */
export function paysInChat(provider: PaymentGatewayProvider): boolean {
  const descriptor = PAYMENT_GATEWAY_DESCRIPTORS[provider];
  return descriptor.boundToBot;
}

export class MiniAppCheckout {
  constructor(private readonly deps: MiniAppCheckoutDeps) {}

  /**
   * DRAFT to AWAITING_PAYMENT through the lane that owns the purpose: a new or custom
   * service through `OrderService.confirm`, every action on an existing service through
   * `CommercialActionService.confirm` — the bot's `confirmDraft`, with the bot's suffixes.
   */
  async confirm(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
    order: OrderRecord,
    idempotencyKey: string,
  ): Promise<OrderRecord> {
    if (order.purpose === 'NEW_SERVICE' || order.purpose === 'CUSTOM_SERVICE') {
      return this.deps.orders.confirm(scope, actor, {
        idempotencyKey: `${idempotencyKey}:confirm`,
        customerId,
        orderId: order.id,
      });
    }
    return this.deps.commercial.confirm(scope, actor, customerId, {
      orderId: order.id,
      idempotencyKey: `${idempotencyKey}:action_confirm`,
    });
  }

  /**
   * The routes an order offers, in the bot's order: every GATEWAY route, then card-to-card
   * once while it is offered for a purchase — drawn at the first MANUAL_TRANSFER route, or
   * last when no route row names it. Exactly `orderRouteButtons`, as data.
   */
  async orderRoutes(
    scope: TenantContext,
    customerId: UserId,
    total: Money,
  ): Promise<readonly OfferedRoute[]> {
    const routes = await this.deps.routes.routesFor(scope, customerId, 'SERVICE_PURCHASE', total);
    const manualOffered = await this.deps.payments.manualTransferOffered(scope);
    const offered: OfferedRoute[] = [];
    let manualDrawn = false;
    for (const route of routes) {
      if (route.descriptor.settlesVia === 'GATEWAY') {
        offered.push({
          provider: route.provider,
          kind: 'GATEWAY',
          name: await this.deps.screens.routeName(scope, route),
          paysInChat: paysInChat(route.provider),
          giftPercent: 0,
        });
      } else if (
        route.descriptor.settlesVia === 'MANUAL_TRANSFER' &&
        manualOffered &&
        !manualDrawn
      ) {
        offered.push({
          provider: route.provider,
          kind: 'CARD_TO_CARD',
          name: await this.deps.screens.routeName(scope, route),
          paysInChat: false,
          giftPercent: 0,
        });
        manualDrawn = true;
      }
    }
    if (manualOffered && !manualDrawn) {
      offered.push({
        provider: 'MANUAL_TRANSFER',
        kind: 'CARD_TO_CARD',
        name: await this.deps.screens.routeName(scope, {
          provider: 'MANUAL_TRANSFER',
          displayName: null,
        }),
        paysInChat: false,
        giftPercent: 0,
      });
    }
    return offered;
  }

  /** A top-up's routes as the bot's chooser draws them, gift percent included. */
  async topupRoutes(
    scope: TenantContext,
    routes: readonly TopupRoute[],
  ): Promise<readonly OfferedRoute[]> {
    const offered: OfferedRoute[] = [];
    for (const route of routes) {
      offered.push({
        provider: route.provider,
        kind: route.descriptor.settlesVia === 'GATEWAY' ? 'GATEWAY' : 'CARD_TO_CARD',
        name: await this.deps.screens.routeName(scope, route),
        paysInChat: route.descriptor.settlesVia === 'GATEWAY' && paysInChat(route.provider),
        giftPercent: route.topupCashbackPercent,
      });
    }
    return offered;
  }
}

/**
 * The bot's wallet pre-check, as a value: covered, or the shortfall (the whole total when the
 * balance is in another currency). A courtesy for the screen; `settleFromWallet` decides.
 */
export function walletCoverage(
  balance: Money,
  total: Money,
): { readonly sufficient: boolean; readonly shortfall: Money | null } {
  if (balance.currency === total.currency && balance.amountMinor >= total.amountMinor) {
    return { sufficient: true, shortfall: null };
  }
  return {
    sufficient: false,
    shortfall: money(
      balance.currency === total.currency
        ? total.amountMinor - balance.amountMinor
        : total.amountMinor,
      total.currency,
    ),
  };
}

export { amountToTransfer } from '../../payments/domain/amount-to-transfer.js';
export { transferFigures } from '../../payments/domain/transfer-figures.js';
export { cardNumberToCopy } from '../../payments/domain/card-number.js';
