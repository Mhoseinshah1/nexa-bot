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
import type {
  GatewayAttempt,
  ManualTransferInstruction,
} from '../../payments/application/payment.service.js';
import type { PaymentRecord } from '../../payments/application/ports.js';
import type { WalletBalance } from '../../wallet/application/ports.js';
import type { TopupRoute } from '../../payments/application/wallet-topup-flow.service.js';

/**
 * The checkout rules both customer surfaces apply — the Telegram bot and the mini app —
 * stated ONCE (Round 10, B1). Round 9 (C5) gave the mini app a copy of the bot's rules so
 * the bot's keyboards stayed byte-identical; this is the one implementation they now share,
 * and a surface keeps only how it presents each answer:
 *
 * - which lane confirms a DRAFT: a new or custom service through `OrderService.confirm`,
 *   every action on an existing service through `CommercialActionService.confirm`;
 * - which routes an order offers, and in what order;
 * - whether the wallet covers a total, and the shortfall — decided BEFORE a draft is
 *   confirmed, so no reservation is held for money that is not there;
 * - which gateway a tap may start — decided BEFORE a draft is confirmed, so a stale button
 *   reserves nothing for a payment that cannot be made;
 * - the idempotency suffix each step takes within the caller's own key.
 *
 * It decides no price and moves no money itself. The quote is the order's frozen snapshot
 * (`PricingService.price`, through the order lanes); every figure that moves money is read
 * by the payment service inside the transaction that moves it, and each check here is the
 * courtesy in front of the authoritative one there: `settleFromWallet` decides the wallet
 * (with its negative-wallet gate), the confirm lanes decide the order, and each payment
 * request re-decides its route in its own transaction.
 */
export interface CheckoutDeps {
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
  readonly wallet: {
    balanceForCustomer(
      scope: TenantContext,
      actor: ActorContext,
      customerId: UserId,
    ): Promise<WalletBalance>;
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
    settleFromWallet(
      scope: TenantContext,
      actor: ActorContext,
      customerId: UserId,
      intent: { readonly idempotencyKey: string; readonly orderId: string },
    ): Promise<{ readonly payment: PaymentRecord; readonly order: OrderRecord }>;
    requestGatewayPayment(
      scope: TenantContext,
      actor: ActorContext,
      customerId: UserId,
      intent: {
        readonly idempotencyKey: string;
        readonly orderId: string;
        readonly provider: PaymentGatewayProvider;
      },
    ): Promise<GatewayAttempt>;
    requestManualTransfer(
      scope: TenantContext,
      actor: ActorContext,
      customerId: UserId,
      intent: { readonly idempotencyKey: string; readonly orderId: string },
    ): Promise<ManualTransferInstruction>;
  };
  readonly screens: {
    routeName(
      scope: TenantContext,
      route: { readonly provider: PaymentGatewayProvider; readonly displayName: string | null },
    ): Promise<string>;
  };
}

/** One route a customer is offered, as data: each surface draws it its own way. */
export interface CheckoutRoute {
  readonly provider: PaymentGatewayProvider;
  readonly kind: 'GATEWAY' | 'CARD_TO_CARD';
  readonly name: string;
  /** The invoice is a message in the bot's chat (Stars, a Telegram-bound gateway). */
  readonly paysInChat: boolean;
  readonly giftPercent: number;
}

/** The wallet against a total: the balance, and whether it covers it or what is missing. */
export interface WalletCoverage {
  readonly balance: Money;
  readonly sufficient: boolean;
  /** What a top-up would have to add; null when the balance covers the total. */
  readonly shortfall: Money | null;
}

export type WalletPayment =
  /** The balance does not cover a DRAFT's total: nothing was confirmed or debited. */
  | { readonly outcome: 'SHORT'; readonly shortfall: Money }
  | {
      readonly outcome: 'SETTLED';
      readonly order: OrderRecord;
      readonly payment: PaymentRecord;
    };

export type GatewayPayment =
  /** The route is not one this order is offered now: nothing was confirmed or requested. */
  | { readonly outcome: 'NOT_OFFERED' }
  | { readonly outcome: 'REQUESTED'; readonly attempt: GatewayAttempt };

/** Whether a gateway's invoice is paid in the bot's chat rather than on a page. */
export function paysInChat(provider: PaymentGatewayProvider): boolean {
  return PAYMENT_GATEWAY_DESCRIPTORS[provider].boundToBot;
}

/**
 * The wallet pre-check, as a value: covered when the balance is in the total's currency and
 * not below it; otherwise the shortfall — the whole total when the balance is in another
 * currency. A courtesy for the screen and for not confirming in vain; `settleFromWallet`
 * decides.
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

export class CheckoutService {
  constructor(private readonly deps: CheckoutDeps) {}

  /**
   * DRAFT to AWAITING_PAYMENT through the lane that owns the order's purpose: a new or custom
   * service through `OrderService.confirm`, a renewal or a package through
   * `CommercialActionService.confirm`. Both are exactly-once under the caller's key.
   */
  async confirmDraft(
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
   * The routes an order offers, in the operator's order.
   *
   * Built from the routes rather than from a list of providers, so a route added later is
   * offered without a change: each is dispatched by what its DESCRIPTOR says it settles
   * through. A `GATEWAY` route is offered as itself; a route that settles any way other than
   * `GATEWAY` or `MANUAL_TRANSFER` has no order payment and is not offered.
   *
   * Card-to-card keeps the offer rule it always had: `manualTransferOffered` (the route
   * switched on for purchases AND an enabled account to pay into), not the per-customer
   * thresholds or the route's own bounds — whether those apply to an order payment is
   * `OQ-5C-01`. So it is offered ONCE, where the operator ordered it when `routesFor` lists
   * it, and last otherwise.
   */
  async orderRoutes(
    scope: TenantContext,
    customerId: UserId,
    total: Money,
  ): Promise<readonly CheckoutRoute[]> {
    const routes = await this.deps.routes.routesFor(scope, customerId, 'SERVICE_PURCHASE', total);
    const manualOffered = await this.deps.payments.manualTransferOffered(scope);
    const offered: CheckoutRoute[] = [];
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

  /** A top-up's routes, in the order given, each with its name and its gift percent. */
  async topupRoutes(
    scope: TenantContext,
    routes: readonly TopupRoute[],
  ): Promise<readonly CheckoutRoute[]> {
    const offered: CheckoutRoute[] = [];
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

  /** The customer's balance against a total: `walletCoverage` over the balance read now. */
  async walletCoverageFor(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
    total: Money,
  ): Promise<WalletCoverage> {
    const read = await this.deps.wallet.balanceForCustomer(scope, actor, customerId);
    const balance = money(read.amountMinor, read.currency);
    return { balance, ...walletCoverage(balance, total) };
  }

  /**
   * Paying an order from the wallet. A DRAFT is paid in one step: the balance is read FIRST,
   * and a shortfall answers without confirming anything — a reservation held for money that
   * is not there is a slot nobody can buy until it lapses. Then the confirm (which reserves
   * and redeems) and the settlement, each under its own suffix of the caller's key, each
   * exactly-once on replay. `order` is the caller's own read of the customer's order.
   */
  async payFromWallet(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
    order: OrderRecord,
    idempotencyKey: string,
  ): Promise<WalletPayment> {
    if (order.state === 'DRAFT') {
      const coverage = await this.walletCoverageFor(scope, actor, customerId, order.totals.total);
      if (coverage.shortfall !== null) {
        return { outcome: 'SHORT', shortfall: coverage.shortfall };
      }
      await this.confirmDraft(scope, actor, customerId, order, idempotencyKey);
    }
    const settled = await this.deps.payments.settleFromWallet(scope, actor, customerId, {
      idempotencyKey: `${idempotencyKey}:wallet-pay`,
      orderId: order.id,
    });
    return { outcome: 'SETTLED', order: settled.order, payment: settled.payment };
  }

  /**
   * The gateway route a tap may start for this order: the first route offered for the order's
   * total that settles through `GATEWAY` and, when one is named, is that provider. Null when
   * none is — the route is off, unconfigured, not for purchases, or its bounds refuse the total.
   */
  async gatewayRouteFor(
    scope: TenantContext,
    customerId: UserId,
    total: Money,
    provider: PaymentGatewayProvider | null,
  ): Promise<PaymentGatewayProvider | null> {
    const routes = await this.deps.routes.routesFor(scope, customerId, 'SERVICE_PURCHASE', total);
    const route = routes.find(
      (candidate) =>
        candidate.descriptor.settlesVia === 'GATEWAY' &&
        (provider === null || candidate.provider === provider),
    );
    return route?.provider ?? null;
  }

  /**
   * Paying an order through an external gateway. The route is decided BEFORE a draft is
   * confirmed, so a customer shown a stale button does not reserve a slot for a payment they
   * cannot make. Then the payment service opens (or hands back) the attempt; the provider
   * invoice is created by the worker, never while the customer waits.
   */
  async payByGateway(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
    order: OrderRecord,
    idempotencyKey: string,
    /** The route the customer chose, or null for "the first one offered" (the bot's `g:`). */
    provider: PaymentGatewayProvider | null,
  ): Promise<GatewayPayment> {
    const route = await this.gatewayRouteFor(scope, customerId, order.totals.total, provider);
    if (route === null) return { outcome: 'NOT_OFFERED' };
    if (order.state === 'DRAFT') {
      await this.confirmDraft(scope, actor, customerId, order, idempotencyKey);
    }
    const attempt = await this.deps.payments.requestGatewayPayment(scope, actor, customerId, {
      idempotencyKey: `${idempotencyKey}:gateway-pay`,
      orderId: order.id,
      provider: route,
    });
    return { outcome: 'REQUESTED', attempt };
  }

  /**
   * Paying an order card to card: a DRAFT is confirmed through its lane, then the transfer is
   * requested — the payment service decides whether card to card is offered, and the amount.
   */
  async payByCard(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
    order: OrderRecord,
    idempotencyKey: string,
  ): Promise<ManualTransferInstruction> {
    if (order.state === 'DRAFT') {
      await this.confirmDraft(scope, actor, customerId, order, idempotencyKey);
    }
    return this.deps.payments.requestManualTransfer(scope, actor, customerId, {
      idempotencyKey: `${idempotencyKey}:manual-pay`,
      orderId: order.id,
    });
  }
}
