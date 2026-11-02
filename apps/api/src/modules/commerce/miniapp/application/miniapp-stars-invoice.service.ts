import {
  COMMERCE_ERROR_CODES,
  MINIAPP_ERROR_CODES,
  errors,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdempotencyStore,
  type Money,
  type OperationalEventRecorder,
  type PaymentGatewayProvider,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
  type MutationDenial,
} from '../../../platform/access/application/authorized-mutation.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { FeatureFlagResolver } from '../../../control/features/application/feature-flags.service.js';
import type { OrderRecord } from '../../orders/application/ports.js';
import type { GatewayAttemptView } from '../../payments/application/gateway-payment.service.js';
import { PAYMENT_PLACE_PERMISSION } from '../../payments/application/payment.service.js';
import type { MiniAppContext } from './miniapp-session.service.js';
import type { StarsInvoiceLinkCreator } from './ports.js';

const STARS = 'TELEGRAM_STARS' as const;
const FLAG = 'miniapp_stars_invoice' as const;
const LINK_ACTION = 'gateway_invoice.stars_link_created';

export interface MiniAppStarsInvoiceServiceDeps {
  readonly features: Pick<FeatureFlagResolver, 'isEnabled'>;
  /** The customer's own gateway attempt, by id AND owner (`GatewayPaymentService.attemptFor`). */
  readonly attempts: {
    attemptFor(
      scope: TenantContext,
      customerId: UserId,
      paymentId: string,
    ): Promise<GatewayAttemptView | null>;
  };
  /** The customer's own order (`OrderService.orderForCustomer`): another's is not found. */
  readonly orders: {
    orderForCustomer(
      scope: TenantContext,
      actor: ActorContext,
      input: { readonly customerId: string; readonly orderId: string },
    ): Promise<OrderRecord>;
  };
  /** The bot's own route rule (`CheckoutService.gatewayRouteFor`) — never a second one. */
  readonly checkout: {
    gatewayRouteFor(
      scope: TenantContext,
      customerId: UserId,
      total: Money,
      provider: PaymentGatewayProvider | null,
    ): Promise<PaymentGatewayProvider | null>;
  };
  readonly links: StarsInvoiceLinkCreator;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly clock: Clock;
  readonly logger: { warn(context: Record<string, unknown>, message: string): void };
}

/** One attempt's in-app invoice. */
export interface MiniAppStarsInvoiceLink {
  readonly paymentId: string;
  readonly invoiceLink: string;
}

/**
 * Telegram Stars paid INSIDE the mini app (R11 B5): `Telegram.WebApp.openInvoice(link)`.
 *
 * The mini app adds a second way to OPEN the invoice of an attempt the bot's own path opened
 * (`CheckoutService.payByGateway` → `PaymentService.requestGatewayPayment`), and nothing else:
 *
 * - the link carries the attempt's own payload (its provider order id) and its snapshotted
 *   Stars, through the body the chat invoice is sent with, so a payment through it is the
 *   same `pre_checkout_query` and `successful_payment` on the bot's webhook, decided and
 *   settled by `StarsPaymentService` — there is no settlement here and no credit path;
 * - one link per attempt: the first one made is remembered against the attempt (idempotency
 *   store, `MINI_APP` namespace, keyed by the payment id) and handed back on every later ask,
 *   so a replay is the same link and never a second attempt;
 * - offered exactly when the bot would offer Stars for this order NOW (`gatewayRouteFor`, the
 *   bot's rule), for an order attempt still PENDING inside its deadline, bound to the bot this
 *   session runs in (pre-checkout refuses any other bot), and only while
 *   `miniapp_stars_invoice` is on; anything else is the mini app's existing
 *   `MINIAPP_ROUTE_UNAVAILABLE` refusal.
 *
 * What the client is told by `openInvoice` (`paid`) is never evidence: the payment is paid
 * when, and only when, the webhook recorded Telegram's charge.
 *
 * Making a link again after an answer was lost is safe, unlike a gateway create: a link is
 * not a charge, it names the same attempt, and pre-checkout lets that attempt be charged once.
 */
export class MiniAppStarsInvoiceService {
  constructor(private readonly deps: MiniAppStarsInvoiceServiceDeps) {}

  /** Whether the order routes may say Stars is payable here: the flag, nothing per order. */
  async paysInApp(scope: TenantContext, provider: PaymentGatewayProvider): Promise<boolean> {
    return provider === STARS && (await this.deps.features.isEnabled(scope, FLAG));
  }

  /**
   * Whether this attempt's wire says `inAppInvoice`: a Stars ORDER attempt bound to the bot
   * this session runs in, while the flag is on. The route is re-decided when the link is
   * asked for; this only decides whether the button is drawn.
   */
  async offersInApp(
    context: Pick<MiniAppContext, 'scope' | 'botInstanceId'>,
    attempt: GatewayAttemptView,
  ): Promise<boolean> {
    return (
      attempt.invoice.provider === STARS &&
      attempt.payment.orderId !== null &&
      attempt.invoice.botInstanceId === context.botInstanceId &&
      (await this.deps.features.isEnabled(context.scope, FLAG))
    );
  }

  /** The attempt's one invoice link: the remembered one, or a new one remembered now. */
  async linkFor(
    context: MiniAppContext,
    actor: ActorContext,
    paymentId: string,
  ): Promise<MiniAppStarsInvoiceLink> {
    const { scope, customer } = context;
    const denial: MutationDenial = { action: LINK_ACTION, entityType: 'Payment', entityId: null };
    // Early, before anything is asked of Telegram: a permission checked after the side effect
    // is not a permission check. The authoritative check is re-run inside the write below.
    try {
      await this.deps.guard.check(scope, actor, PAYMENT_PLACE_PERMISSION);
    } catch (error) {
      await recordMutationDenial(this.deps, scope, actor, PAYMENT_PLACE_PERMISSION, denial, error);
      throw error;
    }

    const attempt = await this.deps.attempts.attemptFor(scope, customer.id, paymentId);
    if (attempt === null) {
      throw errors.notFound(MINIAPP_ERROR_CODES.MINIAPP_NOT_FOUND, 'Not found.');
    }
    const { payment, invoice } = attempt;
    if (!(await this.offersInApp(context, attempt)) || payment.orderId === null) {
      throw notOffered();
    }
    const now = this.deps.clock.now();
    if (
      payment.state !== 'PENDING' ||
      payment.expiresAt === null ||
      now.getTime() >= payment.expiresAt.getTime()
    ) {
      throw errors.conflict(COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID, 'Not payable.');
    }
    const order = await this.deps.orders.orderForCustomer(scope, actor, {
      customerId: customer.id,
      orderId: payment.orderId,
    });
    if (order.state !== 'AWAITING_PAYMENT') {
      throw errors.conflict(COMMERCE_ERROR_CODES.ORDER_STATE_INVALID, 'Not payable.');
    }
    // The bot's rule for this order NOW: the route on, for purchases, its bounds, the
    // customer's eligibility. Not offered → the same refusal `payGateway` gives.
    if (
      (await this.deps.checkout.gatewayRouteFor(scope, customer.id, order.totals.total, STARS)) !==
      STARS
    ) {
      throw notOffered();
    }

    const key = `stars-invoice:${context.botInstanceId}:${customer.id}:${payment.id}`;
    const requestHash = hashRequest({
      paymentId: payment.id,
      payload: invoice.providerOrderId,
      stars: invoice.sentAmount.toString(),
      unit: invoice.providerUnit,
      botInstanceId: invoice.botInstanceId,
    });
    const stored = await this.deps.idempotency.find<MiniAppStarsInvoiceLink>(
      scope,
      'MINI_APP',
      key,
      requestHash,
    );
    if (stored !== null) return stored.result;

    const made = await this.deps.links.create(scope, {
      botInstanceId: context.botInstanceId,
      payload: invoice.providerOrderId,
      stars: invoice.sentAmount,
    });
    if (made.outcome !== 'CREATED') {
      this.deps.logger.warn(
        { paymentId: payment.id, provider: STARS, code: made.code },
        'mini-app stars invoice link could not be created',
      );
      throw errors.conflict(
        COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_UNAVAILABLE,
        'The Stars invoice could not be opened here.',
        { reason: 'INVOICE_LINK_FAILED' },
      );
    }

    const result: MiniAppStarsInvoiceLink = { paymentId: payment.id, invoiceLink: made.link };
    const remembered = await runAuthorizedMutation(
      this.deps,
      scope,
      actor,
      PAYMENT_PLACE_PERMISSION,
      { ...denial, entityId: payment.id },
      async (tx) => {
        // Inside the transaction, as every write path reads it: a stop that committed while
        // Telegram was asked records nothing.
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(MINIAPP_ERROR_CODES.MINIAPP_UNAVAILABLE, 'Not accepting work.');
        }
        const first = await this.deps.idempotency.remember(
          scope,
          'MINI_APP',
          key,
          requestHash,
          result,
          tx,
        );
        if (!first) return false;
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: LINK_ACTION,
            entityType: 'Payment',
            entityId: payment.id,
            before: null,
            after: {
              provider: STARS,
              providerUnit: invoice.providerUnit,
              providerAmount: invoice.sentAmount.toString(),
              botInstanceId: context.botInstanceId,
            },
            result: 'SUCCESS',
          },
          tx,
        );
        return true;
      },
    );
    if (remembered) return result;
    // A concurrent ask for the same attempt remembered its link first: that one is THE link.
    const winner = await this.deps.idempotency.find<MiniAppStarsInvoiceLink>(
      scope,
      'MINI_APP',
      key,
      requestHash,
    );
    if (winner === null) {
      throw errors.conflict(COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_UNAVAILABLE, 'Retry.', {
        reason: 'INVOICE_LINK_FAILED',
      });
    }
    return winner.result;
  }
}

function notOffered() {
  return errors.conflict(MINIAPP_ERROR_CODES.MINIAPP_ROUTE_UNAVAILABLE, 'Route not offered.');
}
