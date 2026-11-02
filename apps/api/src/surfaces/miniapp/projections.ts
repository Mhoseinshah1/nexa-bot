import {
  orderCodeOf,
  paymentTrackingCode,
  plainAmount,
  toWire,
  type MiniAppCardInstruction,
  type MiniAppGatewayAttempt,
  type MiniAppListedPersonalDiscount,
  type MiniAppOrder,
  type MiniAppProduct,
  type MiniAppServiceSummary,
  type Money,
  type MoneyWire,
  type ProductDisplay,
} from '@nexa/contracts';
import type { OrderRecord } from '../../modules/commerce/orders/application/ports.js';
import type { ListedProduct } from '../../modules/commerce/catalog/application/product.service.js';
import type { ListedPersonalDiscount } from '../../modules/commerce/pricing/application/pricing.service.js';
import type { ServiceRecord } from '../../modules/commerce/provisioning/application/ports.js';
import type {
  GatewayAttempt,
  ManualTransferInstruction,
} from '../../modules/commerce/payments/application/payment.service.js';
import type { GatewayAttemptView } from '../../modules/commerce/payments/application/gateway-payment.service.js';
import { paysInChat } from '../../modules/commerce/checkout/application/checkout.service.js';
import { amountToTransfer } from '../../modules/commerce/payments/domain/amount-to-transfer.js';
import { cardNumberToCopy } from '../../modules/commerce/payments/domain/card-number.js';
import { transferFigures } from '../../modules/commerce/payments/domain/transfer-figures.js';
import { personalDiscountPercentOf } from '../../modules/commerce/pricing/domain/pricing-engine.js';

/**
 * Records to the mini app's wire (`@nexa/contracts` miniapp.ts). Projection only: every
 * figure is the record's own — the order's frozen totals, the payment's own payable, the
 * service's stored usage — and nothing is computed that the bot would not show.
 */

export function wire(value: Money): MoneyWire {
  return toWire(value);
}

/**
 * R11 A9: a listed line's personal discount on the wire — the percent and the total the
 * line's quote charges (`PricingService.personalListPrices`), or null when it does not win.
 */
export function listedPersonalDiscountWire(
  discount: ListedPersonalDiscount | null,
): MiniAppListedPersonalDiscount | null {
  return discount === null ? null : { percent: discount.percent, price: wire(discount.price) };
}

export function productWire(product: ListedProduct): MiniAppProduct | null {
  // The SQL returns only priced products; one without a price is not something a customer can consent to.
  if (product.price === null) return null;
  return {
    id: product.id,
    title: product.title,
    price: wire(product.price),
    personalDiscount: listedPersonalDiscountWire(product.personalDiscount),
    trafficBytes: product.specification.trafficBytes.toString(),
    durationDays: product.specification.durationDays,
    deviceLimit: product.specification.deviceLimit,
    locations: [...product.display.displayLocations],
    features: [...product.display.displayFeatures],
  };
}

/**
 * The pre-invoice, with the bot's `preinvoice` rules for which figures a purpose shows: a
 * purchase its allowance, an extra-traffic package only the traffic it adds, a time package
 * only its days.
 */
export function orderWire(
  order: OrderRecord,
  extra: {
    readonly username: string | null;
    readonly usernameModes: readonly ('CUSTOM' | 'AUTOMATIC')[];
    readonly display: (ProductDisplay & { readonly description?: string | null }) | null;
    readonly serviceId: string | null;
  },
): MiniAppOrder {
  const purchase = order.purpose === 'NEW_SERVICE' || order.purpose === 'CUSTOM_SERVICE';
  const traffic =
    purchase || order.purpose === 'ADD_TRAFFIC'
      ? order.line.specification.trafficBytes.toString()
      : null;
  const days =
    order.purpose === 'ADD_TRAFFIC' ||
    order.purpose === 'ADD_DEVICES' ||
    order.purpose === 'CHANGE_LOCATION'
      ? null
      : order.line.specification.durationDays;
  const cashback = order.totals.quote.cashback;
  return {
    id: order.id,
    code: orderCodeOf(order) ?? '',
    state: order.state,
    purpose: order.purpose,
    title: order.line.title,
    trafficBytes: traffic,
    durationDays: days,
    subtotal: wire(order.totals.subtotal),
    discount: wire(order.totals.discount),
    total: wire(order.totals.total),
    discountApplied: order.discountCode !== null,
    // R10 D3: from the frozen quote's own decision, never today's percent.
    personalDiscountPercent: personalDiscountPercentOf(order.totals.quote),
    discountEditable: order.state === 'DRAFT' && purchase,
    cashback: cashback === undefined ? null : wire(cashback.amount),
    expiresAt: order.expiresAt?.toISOString() ?? null,
    serviceId: extra.serviceId,
    username: extra.username,
    usernameModes: [...extra.usernameModes],
    locations: [...(extra.display?.displayLocations ?? [])],
    features: [...(extra.display?.displayFeatures ?? [])],
    description: extra.display?.description ?? null,
  };
}

export function instructionWire(instruction: ManualTransferInstruction): MiniAppCardInstruction {
  const { payment, destination } = instruction;
  // v0.8.2 hotfix: shown as the bot's R8 A2 invoice shows it — rial, Toman in brackets — and
  // copied as the same rial digits, so what the customer reads is what they paste. R10 B6:
  // and, as there, one amount — no principal and fee apart, never «کارمزد».
  const figures = transferFigures(amountToTransfer(payment));
  return {
    paymentId: payment.id,
    orderId: payment.orderId,
    amount: wire(amountToTransfer(payment)),
    copyAmount: figures?.copyRial ?? plainAmount(amountToTransfer(payment)),
    amountRial: figures?.amountRial ?? null,
    amountToman: figures?.amountToman ?? null,
    reference: paymentTrackingCode(payment),
    expiresAt: payment.expiresAt?.toISOString() ?? null,
    destination:
      destination === null
        ? null
        : {
            cardNumber: destination.cardNumber,
            copyCardNumber: cardNumberToCopy(destination.cardNumber),
            holderName: destination.holderName === '' ? null : destination.holderName,
            bankName: destination.bankName === '' ? null : destination.bankName,
          },
  };
}

export function attemptWire(attempt: GatewayAttempt | GatewayAttemptView): MiniAppGatewayAttempt {
  const inChat = paysInChat(attempt.invoice.provider);
  const ready = attempt.invoice.creationState === 'CREATED';
  return {
    paymentId: attempt.payment.id,
    orderId: attempt.payment.orderId,
    provider: attempt.invoice.provider,
    invoiceReady: ready,
    payUrl:
      inChat || !ready
        ? null
        : (attempt.invoice.webInvoiceUrl ?? attempt.invoice.invoiceUrl ?? null),
    paysInChat: inChat,
    expiresAt: attempt.payment.expiresAt?.toISOString() ?? null,
  };
}

export function serviceSummaryWire(service: ServiceRecord, title: string): MiniAppServiceSummary {
  return {
    id: service.id,
    code: service.code,
    title,
    state: service.state,
    username: service.providerUsername,
    trafficUsedBytes: service.trafficUsedBytes.toString(),
    trafficLimitBytes: service.trafficLimitBytes.toString(),
    expiresAt: service.expiresAt?.toISOString() ?? null,
    usageSyncedAt: service.usageSyncedAt?.toISOString() ?? null,
    deviceLimit: service.deviceLimit,
    locationLabel: service.locationLabel,
    isTrial: service.isTrial,
  };
}
