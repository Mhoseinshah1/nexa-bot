import {
  money,
  type ActorContext,
  type BotInstanceId,
  type CurrencyCode,
  type Money,
  type PaymentGatewayDescriptor,
  type PaymentGatewayProvider,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { SettingsResolver } from '../../../control/settings/application/settings-resolver.js';
import type { CustomerCaptureService } from '../../customers/application/customer-capture.service.js';
import type { CustomerCaptureRecord } from '../../customers/application/customer-capture-ports.js';
import type { GatewayAttempt, ManualTransferInstruction } from './payment.service.js';

/** One route the customer may pay a top-up through, as the chooser draws it. */
export interface TopupRoute {
  readonly provider: PaymentGatewayProvider;
  readonly displayName: string | null;
  readonly topupCashbackPercent: number;
  readonly descriptor: PaymentGatewayDescriptor;
}

export interface TopupRouteSource {
  routesFor(
    scope: TenantContext,
    customerId: UserId,
    purpose: 'WALLET_TOPUP',
    amount: Money | null,
    tx?: unknown,
  ): Promise<readonly TopupRoute[]>;
}

export interface TypedTopupRequester {
  requestWalletTopupTyped(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
    input: {
      readonly amount: Money;
      readonly provider: PaymentGatewayProvider;
      readonly idempotencyKey: string;
    },
  ): Promise<ManualTransferInstruction>;
  /**
   * The same top-up through an EXTERNAL gateway route (WP11A): a payment attempt and its
   * provider invoice, created asynchronously by the gateway lane.
   */
  requestGatewayTopup(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
    input: {
      readonly amount: Money;
      readonly provider: PaymentGatewayProvider;
      readonly idempotencyKey: string;
    },
  ): Promise<GatewayAttempt>;
}

export type AmountParser = (
  text: string,
  currency: CurrencyCode,
) => { readonly ok: true; readonly amount: Money } | { readonly ok: false };

interface MoneyWire {
  readonly amountMinor: string;
  readonly currency: CurrencyCode;
}

export interface WalletTopupFlowDeps {
  readonly captures: CustomerCaptureService;
  readonly routes: TopupRouteSource;
  readonly payments: TypedTopupRequester;
  readonly parseAmount: AmountParser;
  readonly settings: Pick<SettingsResolver, 'valueOf'>;
  readonly uow: UnitOfWork<TransactionScope>;
}

export type TopupAmountResult =
  | { readonly outcome: 'GONE' }
  | { readonly outcome: 'INVALID' }
  | { readonly outcome: 'BELOW_MINIMUM'; readonly minimum: Money }
  | { readonly outcome: 'ABOVE_MAXIMUM'; readonly maximum: Money }
  | {
      readonly outcome: 'RECORDED';
      readonly capture: CustomerCaptureRecord;
      readonly amount: Money;
      readonly routes: readonly TopupRoute[];
    };

export type TopupChoiceResult =
  | { readonly outcome: 'GONE' }
  | {
      readonly outcome: 'NOT_OFFERED';
      readonly amount: Money;
      readonly routes: readonly TopupRoute[];
    }
  | { readonly outcome: 'REQUESTED'; readonly instruction: ManualTransferInstruction }
  | { readonly outcome: 'GATEWAY_REQUESTED'; readonly attempt: GatewayAttempt };

/** The idempotency key of the top-up a chooser tap creates: the capture's, so a double tap is one payment. */
export function topupCaptureKey(captureId: string): string {
  return `topup-capture:${captureId}`;
}

/**
 * The typed top-up flow (customer UX completion §F): amount, then route.
 *
 * The amount is TYPED into a bounded capture, validated against the installation's
 * floor and ceiling, and recorded ON the capture row; the route buttons then carry the
 * capture id and a provider name and nothing else, so the figure a route acts on is the
 * one the customer typed and confirmed by tapping, never one a callback claimed. The
 * request itself is `requestWalletTopupTyped`, which re-decides the route and snapshots
 * its gift exactly as the preset path does.
 */
export class WalletTopupFlowService {
  constructor(private readonly deps: WalletTopupFlowDeps) {}

  async begin(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly customerId: UserId;
      readonly botInstanceId: BotInstanceId;
      readonly idempotencyKey: string;
    },
  ): Promise<{
    readonly capture: CustomerCaptureRecord;
    readonly minimum: Money | null;
    readonly maximum: Money | null;
  }> {
    const capture = await this.deps.captures.open(scope, actor, {
      idempotencyKey: input.idempotencyKey,
      botInstanceId: input.botInstanceId,
      customerId: input.customerId,
      purpose: 'TOPUP_AMOUNT',
      subjectId: null,
    });
    const bounds = await this.bounds(scope);
    return { capture, ...bounds };
  }

  /**
   * The typed text, for a `TOPUP_AMOUNT` capture the surface has just read. Parsing and
   * the bounds are decided here; the capture moves to AMOUNT_RECORDED only when the
   * figure is one the installation accepts, so an invalid figure leaves the question
   * open for another try.
   */
  async recordAmountText(
    scope: TenantContext,
    input: { readonly customerId: UserId; readonly captureId: string; readonly text: string },
  ): Promise<TopupAmountResult> {
    const capture = await this.deps.captures.findOwnedOpen(
      scope,
      input.customerId,
      input.captureId,
    );
    if (capture === null || capture.purpose !== 'TOPUP_AMOUNT') return { outcome: 'GONE' };
    const currency = await this.deps.settings.valueOf<CurrencyCode>(scope, 'sales.currency');
    const parsed = this.deps.parseAmount(input.text, currency);
    if (!parsed.ok) return { outcome: 'INVALID' };
    return this.recordAmount(scope, { ...input, amount: parsed.amount }, capture);
  }

  /**
   * A figure already in minor units — a preset button — recorded on the capture after
   * the same bounds the typed path applies. One rule for both entries.
   */
  async recordAmount(
    scope: TenantContext,
    input: { readonly customerId: UserId; readonly captureId: string; readonly amount: Money },
    known?: CustomerCaptureRecord,
  ): Promise<TopupAmountResult> {
    const capture =
      known ?? (await this.deps.captures.findOwnedOpen(scope, input.customerId, input.captureId));
    if (capture === null || capture.purpose !== 'TOPUP_AMOUNT') return { outcome: 'GONE' };
    if (capture.state === 'AMOUNT_RECORDED') {
      /*
       * A redelivered update. Telegram resends an update whose answer it did not get,
       * and the runtime replays it against the window it read the first time — by then
       * the figure is recorded and the row is waiting for a ROUTE. The same figure is
       * the same request, so it is answered with the chooser again, re-decided now;
       * a different figure under a recorded one is not an answer to anything.
       */
      if (
        capture.amount === null ||
        capture.amount.amountMinor !== input.amount.amountMinor ||
        capture.amount.currency !== input.amount.currency
      ) {
        return { outcome: 'GONE' };
      }
      return this.recorded(scope, input.customerId, capture, capture.amount);
    }
    if (capture.state !== 'AWAITING_TEXT') return { outcome: 'GONE' };
    const { minimum, maximum } = await this.bounds(scope);
    if (minimum !== null && input.amount.amountMinor < minimum.amountMinor) {
      return { outcome: 'BELOW_MINIMUM', minimum };
    }
    if (maximum !== null && input.amount.amountMinor > maximum.amountMinor) {
      return { outcome: 'ABOVE_MAXIMUM', maximum };
    }
    const recorded = await this.deps.uow.run(scope, (tx) =>
      this.deps.captures.recordAmount(scope, capture.id, input.amount, tx),
    );
    if (!recorded) return { outcome: 'GONE' };
    return this.recorded(scope, input.customerId, capture, input.amount);
  }

  /** The chooser for a recorded figure: the routes for it, decided now. */
  private async recorded(
    scope: TenantContext,
    customerId: UserId,
    capture: CustomerCaptureRecord,
    amount: Money,
  ): Promise<TopupAmountResult> {
    const routes = await this.deps.routes.routesFor(scope, customerId, 'WALLET_TOPUP', amount);
    return {
      outcome: 'RECORDED',
      capture: { ...capture, state: 'AMOUNT_RECORDED', amount },
      amount,
      routes,
    };
  }

  /** The routes for a recorded amount, re-decided now — for a tap on a stale chooser. */
  async routesForCapture(
    scope: TenantContext,
    input: { readonly customerId: UserId; readonly captureId: string },
  ): Promise<{ readonly amount: Money; readonly routes: readonly TopupRoute[] } | null> {
    const capture = await this.deps.captures.findOwnedOpen(
      scope,
      input.customerId,
      input.captureId,
    );
    if (capture === null || capture.amount === null) return null;
    const routes = await this.deps.routes.routesFor(
      scope,
      input.customerId,
      'WALLET_TOPUP',
      capture.amount,
    );
    return { amount: capture.amount, routes };
  }

  async choose(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly customerId: UserId;
      readonly captureId: string;
      readonly provider: PaymentGatewayProvider;
    },
  ): Promise<TopupChoiceResult> {
    const capture = await this.deps.captures.findOwnedOpen(
      scope,
      input.customerId,
      input.captureId,
    );
    if (capture === null || capture.purpose !== 'TOPUP_AMOUNT' || capture.amount === null) {
      return { outcome: 'GONE' };
    }
    const amount = capture.amount;
    const routes = await this.deps.routes.routesFor(
      scope,
      input.customerId,
      'WALLET_TOPUP',
      amount,
    );
    const chosen = routes.find((route) => route.provider === input.provider);
    if (chosen === undefined) {
      return { outcome: 'NOT_OFFERED', amount, routes };
    }
    // The request first, keyed by the capture: a double tap replays the same payment.
    // The capture closes afterwards; a close that raced is harmless because the key,
    // not the capture's state, is what makes the payment one.
    const request = {
      amount,
      provider: input.provider,
      idempotencyKey: topupCaptureKey(capture.id),
    };
    /*
     * HOW the route settles is the descriptor's to say, never the provider's name: an
     * external gateway is a payment attempt with a provider invoice (WP11A), a manual
     * route is a transfer instruction. Both re-decide the route inside their transaction.
     */
    const result: TopupChoiceResult =
      chosen.descriptor.settlesVia === 'GATEWAY'
        ? {
            outcome: 'GATEWAY_REQUESTED',
            attempt: await this.deps.payments.requestGatewayTopup(
              scope,
              actor,
              input.customerId,
              request,
            ),
          }
        : {
            outcome: 'REQUESTED',
            instruction: await this.deps.payments.requestWalletTopupTyped(
              scope,
              actor,
              input.customerId,
              request,
            ),
          };
    await this.deps.captures.close(scope, actor, {
      customerId: input.customerId,
      captureId: capture.id,
      reason: 'RECEIVED',
    });
    return result;
  }

  async close(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly customerId: UserId; readonly captureId: string },
  ): Promise<boolean> {
    return this.deps.captures.close(scope, actor, {
      customerId: input.customerId,
      captureId: input.captureId,
      reason: 'CANCELLED',
    });
  }

  private async bounds(
    scope: TenantContext,
  ): Promise<{ readonly minimum: Money | null; readonly maximum: Money | null }> {
    const asBound = (wire: MoneyWire): Money | null => {
      const amountMinor = BigInt(wire.amountMinor);
      return amountMinor > 0n ? money(amountMinor, wire.currency) : null;
    };
    const [minimum, maximum] = await Promise.all([
      this.deps.settings.valueOf<MoneyWire>(scope, 'wallet.topup.minimum'),
      this.deps.settings.valueOf<MoneyWire>(scope, 'wallet.topup.maximum'),
    ]);
    return { minimum: asBound(minimum), maximum: asBound(maximum) };
  }
}
