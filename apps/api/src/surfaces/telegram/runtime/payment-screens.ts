// The payment screens: a gateway attempt, a card transfer, a provider's need, a refusal.
// Pure renderers, moved verbatim out of bot-runtime.ts, which still re-exports their names.
import {
  type InlineButtonKey,
  money,
  type Money,
  PAYMENT_GATEWAY_DESCRIPTORS,
  type PaymentGatewayProvider,
  paymentTrackingCode,
  plainAmount,
  RIALIT_AMOUNT_OUT_OF_RANGE_STORED,
  RIALIT_DOUBLE_FEE_STORED,
  RIALIT_PAYER_AMOUNT_MISMATCH_STORED,
  RIALIT_PAYER_AMOUNT_UNREADABLE_STORED,
  type TemplateKey,
  TETRAPAY_AMOUNT_OUT_OF_RANGE_STORED,
  TETRAPAY_DAILY_LIMIT_STORED,
  TONPAYS_TELEGRAM_STATUS_LESS,
  TONPAYS_TELEGRAM_STATUS_MORE,
} from '@nexa/contracts';
import type { PaymentRecord } from '../../../modules/commerce/payments/application/ports.js';
import type { CustomerButton } from '../../../modules/commerce/messaging/application/ports.js';
import { inlineLabel } from '../../../modules/commerce/messaging/application/inline-buttons.js';
import type { GatewayAttempt } from '../../../modules/commerce/payments/application/payment.service.js';
import type {
  GatewayAttemptView,
  GatewayCardFacts,
} from '../../../modules/commerce/payments/application/gateway-payment.service.js';
import type {
  GatewayInvoiceRecord,
  GatewayProviderRequestRecord,
} from '../../../modules/commerce/payments/application/gateway-invoice-ports.js';
import {
  cancelAvailable,
  cardChangeOffered,
  createEndedRateLimited,
  customerMessageKeyOfError,
  isBuyerConflictCode,
  receiptUploadAvailable,
  refundCardAvailable,
  remainderReceiptAvailable,
} from '../../../modules/commerce/payments/domain/tonpays-telegram.js';
import { gatewaySettlementDeadline } from '../../../modules/commerce/payments/domain/settlement.js';
import { failureStatusOf } from '../../../modules/commerce/payments/domain/payment-failure-outcome.js';
import { rialitLinkDeadline } from '../../../modules/commerce/payments/domain/rialit.js';
import {
  CARD_INVOICE_ROW,
  cardInvoiceAmountValues,
  cardInvoiceCardValues,
  copyCardNumberButton,
  copyRialAmountButton,
} from '../card-invoice.js';
import type { WizardDirective } from '../wizard-state.js';
import {
  GATEWAY_CANCEL_ASK_CALLBACK_PREFIX,
  GATEWAY_CARD_CHANGE_CALLBACK_PREFIX,
  GATEWAY_CHECK_CALLBACK_PREFIX,
  GATEWAY_RECEIPT_CALLBACK_PREFIX,
  GATEWAY_REFUND_CARD_CALLBACK_PREFIX,
  PAY_METHODS_CALLBACK_PREFIX,
  TOPUP_MENU_CALLBACK_PREFIX,
} from './callbacks.js';
import { mainMenuButton } from './keyboards.js';
import type { PendingReply } from './replies.js';

/**
 * «🧾 ثبت پرداخت»: opens the order's payment-method selector (`pm:`). It is the generic
 * entry to every route, never card-to-card itself; drawn only when at least one route is
 * offered for the order, because a selector with nothing in it is a button with no outcome.
 */
export function payMethodsButton(orderId: string): CustomerButton {
  return {
    ...inlineLabel('payment.methods'),
    data: `${PAY_METHODS_CALLBACK_PREFIX}${orderId}`,
  };
}

/**
 * The Stars summary for one attempt, from its snapshot: principal, fee and payable in the
 * sales currency, and the Stars the invoice asks for. With no fee the payable is all three.
 */
function starsInvoiceBody(
  payment: PaymentRecord,
  stars: bigint,
): Pick<PendingReply, 'key' | 'values'> {
  const fee = payment.customerFee;
  const expiresAt = payment.expiresAt ?? new Date(0);
  // FIX-02: the payment's one public code, on the invoice before anything is paid.
  const reference = paymentTrackingCode(payment);
  if (fee !== null && fee.fee.amountMinor > 0n) {
    return {
      key:
        payment.orderId === null
          ? 'bot.payment.stars_invoice_topup_fee'
          : 'bot.payment.stars_invoice_order_fee',
      values: {
        principal: payment.amount,
        fee: fee.fee,
        payable: fee.payable,
        stars,
        expiresAt,
        reference,
      },
    };
  }
  return {
    key:
      payment.orderId === null
        ? 'bot.payment.stars_invoice_topup'
        : 'bot.payment.stars_invoice_order',
    values: { payable: fee?.payable ?? payment.amount, stars, expiresAt, reference },
  };
}

/**
 * «🔎 بررسی وضعیت» on a TonPays Telegram screen: the same `gc:` tap, its own label.
 */
export function cardCheck(paymentId: string): CustomerButton {
  return {
    ...inlineLabel('payment.gateway_card_check'),
    data: `${GATEWAY_CHECK_CALLBACK_PREFIX}${paymentId}`,
  };
}

/**
 * R6 item 2: the amount a card-transfer invoice tells the customer to transfer. TonPays
 * approves automatically only on the EXACT amount it named (its odd `final_amount`); when it
 * named none, what Nexa asked for (`sentAmount`, the payable in the provider's own unit).
 * Display and clipboard only — what Nexa settles, credits and refunds is the payment's own
 * principal. One function, so the invoice, its follow-ups and the review screen (R10 B6)
 * cannot state two different figures.
 */
function cardTransferAmount(invoice: GatewayInvoiceRecord): Money {
  return money(
    invoice.finalAmount !== null ? invoice.finalAmount : invoice.sentAmount,
    invoice.providerUnit === 'IRR' ? 'IRR' : 'IRT',
  );
}

/**
 * A created TonPays Telegram attempt in its customer window (`docs/tonpays-telegram-gateway-
 * audit.md` §8.1): the payable from the payment's own snapshot, TonPays' transfer figure when
 * it differs (labelled as TonPays', never what Nexa settles), the CURRENT card, the deadline,
 * and the three actions — each drawn only while the rule behind it allows it, and each
 * re-decided against the rows when tapped. Never says paid.
 */
function cardTransferScreen(
  payment: PaymentRecord,
  invoice: GatewayInvoiceRecord,
  orderId: string | null,
  at: Date,
  facts: GatewayCardFacts | null,
): PendingReply {
  const kind = payment.orderId === null ? ('TOPUP' as const) : ('ORDER' as const);
  const retry: CustomerButton =
    payment.orderId === null ? topupButton() : payMethodsButton(payment.orderId);
  const wizard = { kind, step: 'INVOICE' as const, paymentId: payment.id };
  // FIX-02: every screen of this attempt quotes the same public code.
  const reference = paymentTrackingCode(payment);
  if (invoice.creationErrorCode !== null) {
    // Created without a card: it cannot be paid from here, and a new attempt is the way on.
    return {
      key: 'bot.payment.gateway_card_missing',
      values: { reference },
      buttons: [retry, mainMenuButton()],
      orderId,
      wizard: { kind, step: 'NOTICE', paymentId: payment.id },
    };
  }
  const expiresAt = payment.expiresAt ?? new Date(0);
  const fee = payment.customerFee;
  const payable = fee?.payable ?? payment.amount;
  const submissions = facts?.submissions ?? [];
  const latest = facts?.latestChange ?? null;
  const windowOpen =
    payment.state === 'PENDING' &&
    (payment.providerReviewUntil ?? null) === null &&
    payment.expiresAt !== null &&
    at.getTime() < payment.expiresAt.getTime();
  // R8 A2: the owner-approved rows — copies, the card switch, receipt and cancel, main menu.
  const receipt: CustomerButton = {
    ...inlineLabel('payment.gateway_receipt'),
    data: `${GATEWAY_RECEIPT_CALLBACK_PREFIX}${payment.id}`,
    row: CARD_INVOICE_ROW.ACTIONS,
  };
  const change: CustomerButton = {
    ...inlineLabel('payment.gateway_change_card'),
    data: `${GATEWAY_CARD_CHANGE_CALLBACK_PREFIX}${payment.id}`,
    row: CARD_INVOICE_ROW.SWITCH,
  };
  const cancelRequest = facts?.latestCancel ?? null;
  const cancel: CustomerButton = {
    ...inlineLabel('payment.gateway_cancel'),
    data: `${GATEWAY_CANCEL_ASK_CALLBACK_PREFIX}${payment.id}`,
    row: CARD_INVOICE_ROW.ACTIONS,
  };
  /*
   * R6 item 2: TonPays approves automatically only on the EXACT amount it named (its odd
   * `final_amount`), so that is what the customer is told and what the copy button carries.
   * When TonPays named none, the exact amount IS what Nexa asked for - `sentAmount`, the
   * payable in the provider's own unit (Toman), never the payment-currency payable (an IRR
   * payment would show rial as Toman). R8 A2: shown in RIAL (Toman beside it) and copied as
   * bare rial digits. It is display and clipboard only: what Nexa settles, credits and
   * refunds is still the payment's own principal.
   */
  const exact = cardTransferAmount(invoice);
  const transferAmount = plainAmount(exact);
  const copyExact = copyRialAmountButton(exact);
  const copyCard = invoice.cardNumber === null ? null : copyCardNumberButton(invoice.cardNumber);
  /*
   * R8 A2: «🔄 تعویض کارت» is drawn while a change is allowed now OR after a cooldown — the
   * invoice is drawn the moment its card arrives, inside the first minute, so a button that
   * waited for the cooldown to pass was never on the screen. The tap decides again under the
   * payment's lock and answers a cooldown with the seconds left. The owner's R5C-1 limits
   * (`changeAllowance`) bound it like the manual switch.
   */
  const menu = mainMenuButton();
  const cancelOffered =
    facts !== null && windowOpen && cancelAvailable(invoice, cancelRequest, submissions);
  const actions = [
    copyExact,
    ...(copyCard === null ? [] : [copyCard]),
    ...(facts !== null &&
    windowOpen &&
    cardChangeOffered(invoice, latest, at, facts.changeAllowance ?? null)
      ? [change]
      : []),
    ...(facts !== null && windowOpen && receiptUploadAvailable(invoice, submissions)
      ? [receipt]
      : []),
    ...(cancelOffered ? [cancel] : []),
    menu,
  ];
  const copies = (button: CustomerButton): boolean => button !== copyExact && button !== copyCard;
  const brief = {
    payable,
    transferAmount,
    expiresAt,
    expiresTime: expiresAt,
    reference,
    ...cardInvoiceAmountValues(exact),
  };
  // Round 6: a cancel with the provider, or one it refused / lost and no inquiry has answered since.
  if (cancelRequest !== null) {
    const cancelKey = cancelNoticeKey(cancelRequest, invoice);
    if (cancelKey !== null) {
      /*
       * R11 A8 (owner): a LOST answer is not a cancellation. While the invoice is still open as
       * far as Nexa knows, the notice keeps «❌ لغو فاکتور» so the customer can ask again (the
       * tap asks first, and re-decides under the payment's lock).
       */
      const retry =
        (cancelKey === 'bot.payment.gateway_cancel_unknown' ||
          cancelKey === 'bot.payment.gateway_cancel_rate_limited') &&
        cancelOffered
          ? [
              {
                ...inlineLabel('payment.gateway_cancel'),
                data: `${GATEWAY_CANCEL_ASK_CALLBACK_PREFIX}${payment.id}`,
              },
            ]
          : [];
      /*
       * R12 F3 lead review: the rate-limited notice asks the customer to tap «❌ لغو فاکتور»
       * again — true only while that button is offered. Otherwise the same notice without it.
       */
      const shownKey =
        cancelKey === 'bot.payment.gateway_cancel_rate_limited' && !cancelOffered
          ? 'bot.payment.gateway_cancel_rate_limited_closed'
          : cancelKey;
      return {
        key: shownKey,
        values: { reference },
        buttons: [...retry, cardCheck(payment.id), mainMenuButton()],
        orderId,
        wizard,
      };
    }
  }
  const newest = submissions.at(-1) ?? null;
  // A receipt on its way, accepted without a review, or whose answer was lost: shown as sent.
  if (
    newest !== null &&
    (newest.state === 'QUEUED' ||
      newest.state === 'SENDING' ||
      newest.state === 'ACCEPTED' ||
      (newest.state === 'UNKNOWN' && newest.inquiryResolvedAt === null))
  ) {
    return {
      key: 'bot.payment.gateway_card_receipt_sent',
      values: brief,
      buttons: actions,
      orderId,
      wizard,
    };
  }
  // TonPays itself says the receipt is being checked (an inquiry, not an acknowledgement).
  if (invoice.providerStatus === 'processing') {
    return {
      key: 'bot.payment.gateway_card_receipt_sent',
      values: brief,
      buttons: actions,
      orderId,
      wizard,
    };
  }
  if (latest !== null && (latest.state === 'REQUESTED' || latest.state === 'SENT')) {
    return {
      key: 'bot.payment.gateway_card_changing',
      values: brief,
      // No copy buttons: the new card may carry a new exact amount, copied once it shows.
      buttons: actions.filter(copies),
      orderId,
      wizard,
    };
  }
  if (invoice.cardNumber === null) {
    // The last card change's answer was lost: no card is shown, never a stale one.
    return {
      key: 'bot.payment.gateway_card_unconfirmed',
      values: brief,
      // No card is shown, so no exact amount is offered for copying either. Its text offers a
      // status check, so the check stays on this one screen.
      buttons: [
        ...actions.filter((button) => copies(button) && button !== menu),
        cardCheck(payment.id),
        menu,
      ],
      orderId,
      wizard,
    };
  }
  const card = {
    cardNumber: invoice.cardNumber,
    ...cardInvoiceCardValues(invoice.cardNumber),
    ...(invoice.cardName === null ? {} : { cardName: invoice.cardName }),
  };
  if (newest !== null && (newest.state === 'REFUSED' || newest.state === 'ABANDONED')) {
    // Round 6: the provider's own words for an empty image or a receipt it could not match.
    const refusedKey = customerMessageKeyOfError(newest.errorCode);
    return {
      key:
        refusedKey === 'bot.payment.gateway_card_receipt_empty' ||
        refusedKey === 'bot.payment.gateway_card_receipt_invoice'
          ? refusedKey
          : 'bot.payment.gateway_card_receipt_refused',
      values: { ...brief, ...card },
      buttons: actions,
      orderId,
      wizard,
    };
  }
  return {
    key: 'bot.payment.gateway_card_invoice',
    values: {
      ...brief,
      ...card,
      ...(fee !== null && fee.fee.amountMinor > 0n
        ? { principal: payment.amount, fee: fee.fee }
        : {}),
    },
    buttons: actions,
    orderId,
    wizard,
  };
}

/**
 * An external-gateway attempt, as the customer sees it (brief §11, §23) — and, since R2
 * (item 4), the SAME screen whether the turn draws it or the gateway worker edits the wizard
 * message into it once the invoice is ready (`WizardInvoiceScreens`). A pure function of the
 * attempt and the moment, so the two can never show different things for one attempt.
 *
 * Only a CONFIRMED payment is ever called paid, and a payment is CONFIRMED only by the
 * gateway's own inquiry through the one settlement path. The link is the invoice's web link
 * when the gateway returned one, else its Telegram link; nothing is fabricated.
 *
 * Every screen that ends the attempt without an invoice — refused, not approved, closed, or
 * a create whose answer was lost — says so truthfully and offers a way back to choosing how
 * to pay (the order's method selector, or the top-up's amount), never a retry of THIS
 * attempt: an attempt whose create is unknown is never created again (TonPays rule three).
 */
/**
 * The notice a customer's cancel request leaves on the invoice (Round 6): "cancelling…" while
 * it is with the provider; the provider's refusal or a lost answer until the next inquiry has
 * answered (that inquiry says what the invoice is now, and replaces the notice). A request that
 * was applied, or answered before the latest inquiry, leaves none; since R11 A8 the customer's
 * rate-limited one reads as a lost answer.
 */
function cancelNoticeKey(
  request: GatewayProviderRequestRecord,
  invoice: Pick<GatewayInvoiceRecord, 'lastInquiryAt'>,
): TemplateKey | null {
  if (request.state === 'REQUESTED' || request.state === 'SENT') {
    return 'bot.payment.gateway_cancel_requested';
  }
  const answeredSince =
    request.decidedAt !== null &&
    invoice.lastInquiryAt !== null &&
    invoice.lastInquiryAt.getTime() >= request.decidedAt.getTime();
  if (answeredSince) return null;
  if (request.state === 'UNKNOWN') return 'bot.payment.gateway_cancel_unknown';
  /*
   * R11 A8: the customer's cancel that TonPays rate-limited did not go through either (one the
   * TonPays client's own limiter HELD is not decided at all: the lane puts it back and sends it
   * when the key may be used, so it reads "cancelling…" meanwhile), with the same way on as a
   * lost answer: the cancel button, which `cancelAvailable` keeps. Nexa's own rate-limited cancel
   * (before a new create) is asked again by Nexa and says nothing here.
   *
   * R12 F3 item 10: but it is NOT a lost answer. A readable RATE_LIMIT_EXCEEDED (or a cancel
   * Nexa's limiter held past the customer window) is the provider's — or our own — definite
   * "not processed": the answer is known, and `gateway_cancel_unknown` («پاسخ تون‌پی دریافت نشد»)
   * would say the opposite. Its own sentence: not cancelled yet, may be asked again, do not pay
   * again. A genuinely lost answer (`UNKNOWN`: timeout, 5xx, a bare 429) keeps the old key.
   */
  if (request.state === 'RATE_LIMITED' && request.requestedByNexa !== true) {
    return 'bot.payment.gateway_cancel_rate_limited';
  }
  if (request.state === 'REFUSED') {
    const key = customerMessageKeyOfError(request.errorCode);
    // Only the cancel refusals have a sentence of their own here; others change nothing.
    return key !== null &&
      (key.startsWith('bot.payment.gateway_cancel_not_allowed_') ||
        key === 'bot.payment.gateway_not_pending')
      ? key
      : null;
  }
  return null;
}

/**
 * An under- or overpaid TonPays Telegram invoice (Round 6): `action_required_less` shows the
 * remainder, the card to pay it to (tap-to-copy buttons for the card and the exact amount) and
 * «📤 ارسال رسید مابقی»; `action_required_more` asks for the refund card. Null for any other
 * status — and for one whose settlement deadline has passed. Every figure is TonPays' own
 * instruction to the customer; none of it is what Nexa settles, credits or refunds.
 */
function providerNeedScreen(
  payment: PaymentRecord,
  invoice: GatewayInvoiceRecord,
  orderId: string | null,
  at: Date,
  facts: GatewayCardFacts,
): PendingReply | null {
  const less = invoice.providerStatus === TONPAYS_TELEGRAM_STATUS_LESS;
  const more = invoice.providerStatus === TONPAYS_TELEGRAM_STATUS_MORE;
  if (!less && !more) return null;
  const deadline = gatewaySettlementDeadline(payment);
  if (payment.state !== 'PENDING' || deadline === null || at.getTime() >= deadline.getTime()) {
    return null;
  }
  const kind = payment.orderId === null ? ('TOPUP' as const) : ('ORDER' as const);
  const wizard = { kind, step: 'INVOICE' as const, paymentId: payment.id };
  const reference = paymentTrackingCode(payment);
  const provider = facts.providerFacts ?? null;
  const base = { expiresAt: deadline, reference };
  const tail = [cardCheck(payment.id), mainMenuButton()];
  const submissions = facts.submissions;
  if (less) {
    /*
     * v0.8.2 hotfix: TonPays reports the remainder in Toman (`remaining_amount`, OQ-TPTG-23),
     * and a customer types what they read or copy into a banking app, which takes RIAL. So it
     * is shown in rial with Toman beside it and copied as bare rial digits — the R8 A2 card
     * invoice's own helpers — never as the Toman figure, which was transferred ten times too
     * little. `{shortfall}` stays supplied for an override written for the earlier text.
     * Display and clipboard only: nothing Nexa settles, credits or refunds reads it.
     */
    const remainder =
      provider?.remainingAmount == null ? null : money(provider.remainingAmount, 'IRT');
    const shortfall =
      remainder === null ? {} : { shortfall: remainder, ...cardInvoiceAmountValues(remainder) };
    // Only a receipt aimed at the REMAINDER invoice says the remainder was paid: the original's
    // accepted receipt is how the shortfall was found, not an answer to it.
    const remainderNewest =
      provider?.remainingInvoiceId == null
        ? null
        : (submissions
            .filter((one) => one.providerInvoiceId === provider.remainingInvoiceId)
            .at(-1) ?? null);
    const sending =
      (remainderNewest !== null &&
        (remainderNewest.state === 'QUEUED' ||
          remainderNewest.state === 'SENDING' ||
          remainderNewest.state === 'ACCEPTED' ||
          (remainderNewest.state === 'UNKNOWN' && remainderNewest.inquiryResolvedAt === null))) ||
      provider?.remainingReceiptReceived === true;
    if (sending) {
      return {
        key: 'bot.payment.gateway_card_underpaid_receipt_sent',
        values: { ...base, ...shortfall },
        buttons: tail,
        orderId,
        wizard,
      };
    }
    if (
      provider === null ||
      provider.remainingAmount === null ||
      provider.remainingCardNumber === null ||
      provider.remainingInvoiceId === null
    ) {
      // TonPays said "less" without a usable remainder: nothing is invented.
      return {
        key: 'bot.payment.gateway_card_underpaid_unavailable',
        values: base,
        buttons: tail,
        orderId,
        wizard,
      };
    }
    const amount = money(provider.remainingAmount, 'IRT');
    const offerReceipt = remainderReceiptAvailable(invoice, provider, submissions);
    return {
      key: 'bot.payment.gateway_card_underpaid',
      values: {
        ...base,
        shortfall: amount,
        ...cardInvoiceAmountValues(amount),
        cardNumber: provider.remainingCardNumber,
        ...(provider.remainingCardHolder === null
          ? {}
          : { cardName: provider.remainingCardHolder }),
      },
      buttons: [
        // The card invoice's first row: the remainder in rial digits, then the card's digits.
        copyRialAmountButton(amount),
        copyCardNumberButton(provider.remainingCardNumber),
        ...(offerReceipt
          ? [
              {
                ...inlineLabel('payment.gateway_remainder_receipt'),
                data: `${GATEWAY_RECEIPT_CALLBACK_PREFIX}${payment.id}`,
              },
            ]
          : []),
        ...tail,
      ],
      orderId,
      wizard,
    };
  }
  // action_required_more
  /*
   * R10 B6: TonPays' `refund_amount` is Toman, like its remainder; shown in RIAL with Toman
   * beside it, as every other amount of this attempt is. `{refundAmount}` stays supplied for an
   * override written for the earlier text. Display only: nothing Nexa credits reads it.
   */
  const refundAmount =
    provider?.refundAmount == null
      ? {}
      : {
          refundAmount: money(provider.refundAmount, 'IRT'),
          ...cardInvoiceAmountValues(money(provider.refundAmount, 'IRT')),
        };
  const latest = facts.latestRefund ?? null;
  const masked = latest?.refundCardMasked == null ? {} : { maskedCard: latest.refundCardMasked };
  const retryCard: CustomerButton = {
    ...inlineLabel('payment.gateway_refund_card'),
    data: `${GATEWAY_REFUND_CARD_CALLBACK_PREFIX}${payment.id}`,
  };
  if (
    (latest !== null && (latest.state === 'REQUESTED' || latest.state === 'SENT')) ||
    provider?.refundPending === true ||
    latest?.state === 'APPLIED'
  ) {
    return {
      key: 'bot.payment.gateway_card_overpaid_pending',
      values: { ...base, ...refundAmount, ...masked },
      buttons: tail,
      orderId,
      wizard,
    };
  }
  if (latest !== null && latest.state === 'UNKNOWN') {
    return {
      key: 'bot.payment.gateway_refund_unknown',
      values: { reference },
      buttons: [retryCard, ...tail],
      orderId,
      wizard,
    };
  }
  if (latest !== null && latest.state === 'REFUSED') {
    const key = customerMessageKeyOfError(latest.errorCode);
    if (
      key === 'bot.payment.gateway_refund_not_allowed' ||
      key === 'bot.payment.gateway_refund_already_open'
    ) {
      return { key, values: { reference }, buttons: tail, orderId, wizard };
    }
    if (
      key === 'bot.payment.gateway_refund_card_refused' ||
      key === 'bot.payment.gateway_refund_holder_refused'
    ) {
      return { key, values: { reference }, buttons: [retryCard, ...tail], orderId, wizard };
    }
  }
  return {
    key: 'bot.payment.gateway_card_overpaid',
    values: { ...base, ...refundAmount },
    buttons: [...(refundCardAvailable(invoice, provider, latest) ? [retryCard] : []), ...tail],
    orderId,
    wizard,
  };
}

/**
 * A FAILED card-transfer attempt that deserves its own words (Round 6): one the customer
 * cancelled, one TonPays rejected WITH reasons (shown as TonPays worded them, sanitised), and
 * a create TonPays refused because the buyer already holds an open invoice (the invoice that
 * blocks is one tap away when Nexa knows it). Null for everything else.
 */
function failedCardScreen(
  payment: PaymentRecord,
  invoice: GatewayInvoiceRecord,
  orderId: string | null,
  facts: GatewayCardFacts | null,
  screen: (
    key: TemplateKey,
    buttons: readonly CustomerButton[],
    step: WizardDirective['step'],
    pending?: boolean,
  ) => PendingReply,
): PendingReply | null {
  if (PAYMENT_GATEWAY_DESCRIPTORS[invoice.provider].invoiceForm !== 'CARD_TRANSFER') return null;
  const retry: CustomerButton =
    payment.orderId === null ? topupButton() : payMethodsButton(payment.orderId);
  if (facts?.latestCancel?.state === 'APPLIED') {
    return screen('bot.payment.gateway_cancelled', [retry], 'NOTICE');
  }
  /*
   * R11 A8: the customer's cancel whose answer was lost (or the retry the provider then refused
   * as no longer pending) DID cancel it — the inquiry read `canceled` and failed the payment.
   * The customer asked for exactly that, so it reads "cancelled", not "failed".
   */
  const asked = facts?.latestCancel ?? null;
  if (
    asked !== null &&
    asked.requestedByNexa !== true &&
    failureStatusOf(payment.resolutionNote) === 'canceled'
  ) {
    return screen('bot.payment.gateway_cancelled', [retry], 'NOTICE');
  }
  if (invoice.creationState === 'CREATE_FAILED' && isBuyerConflictCode(invoice.creationErrorCode)) {
    const key = customerMessageKeyOfError(invoice.creationErrorCode);
    if (key === null) return null;
    const open = facts?.openElsewherePaymentId ?? null;
    return screen(
      key,
      [
        ...(open === null
          ? []
          : [
              {
                ...inlineLabel('payment.gateway_open_invoice'),
                data: `${GATEWAY_CHECK_CALLBACK_PREFIX}${open}`,
              },
            ]),
        retry,
      ],
      'NOTICE',
    );
  }
  // R9 C1: a reason that is one of the provider's documented codes reads in Persian.
  const reasons = facts?.rejectReasonsShown ?? facts?.providerFacts?.rejectReasons ?? [];
  if (reasons.length > 0) {
    return {
      ...screen('bot.payment.gateway_card_rejected', [retry], 'NOTICE'),
      values: { reasons: reasons.join('\n'), reference: paymentTrackingCode(payment) },
    };
  }
  return null;
}

/**
 * The review-window and needs-review sentences per provider, for a route whose own words
 * differ from TonPays Telegram's receipt wording (NOWPayments: coins confirming on chain,
 * `docs/nowpayments-gateway-audit.md` §5.8). A provider absent here keeps the original keys.
 */
const PROVIDER_REVIEW_SCREEN_KEYS: Partial<
  Record<
    PaymentGatewayProvider,
    { readonly inReview: TemplateKey; readonly unresolved: TemplateKey }
  >
> = {
  NOWPAYMENTS: {
    inReview: 'bot.payment.nowpayments_in_review',
    unresolved: 'bot.payment.nowpayments_review_unresolved',
  },
  /*
   * CentralPay has no review window (`docs/centralpay-gateway-audit.md` §5.8): it reaches
   * UNKNOWN only when a verify did not match the payment, which its own sentence says.
   */
  CENTRALPAY: {
    inReview: 'bot.payment.gateway_in_review',
    unresolved: 'bot.payment.centralpay_review_unresolved',
  },
  /*
   * TetraPay has no review window either: it reaches UNKNOWN only when a verify said `paid` for
   * an amount, order id or receipt that does not match the payment, which its own sentence says.
   */
  TETRAPAY: {
    inReview: 'bot.payment.gateway_in_review',
    unresolved: 'bot.payment.tetrapay_review_unresolved',
  },
  /*
   * Rialit has no review window: it reaches UNKNOWN only when its status read said `paid` for an
   * amount, payer amount or order id that does not match the payment.
   */
  RIALIT: {
    inReview: 'bot.payment.gateway_in_review',
    unresolved: 'bot.payment.rialit_review_unresolved',
  },
};

/**
 * The label of the URL button that opens a provider's invoice page. NOWPayments carries the
 * owner's «💳 پرداخت با ارز دیجیتال» under its OWN key, isolated so the central inline-button
 * registry can take it over as `payment.nowpayments_open` without touching any other route;
 * CentralPay's «💳 پرداخت با CentralPay» is isolated the same way (`payment.centralpay_open`).
 */
const PROVIDER_PAY_BUTTON_KEYS: Partial<Record<PaymentGatewayProvider, InlineButtonKey>> = {
  NOWPAYMENTS: 'payment.nowpayments_open',
  CENTRALPAY: 'payment.centralpay_open',
};

/**
 * The screen for a TetraPay create refusal the customer can act on, or null for any other code.
 * Pure: the code is what the attempt recorded (`tetrapay.DAILY_LIMIT_REACHED`, or
 * `tetrapay.AMOUNT_OUT_OF_RANGE:<min Toman>:<max Toman>` with 0 for a bound not stated).
 */
export function tetrapayRefusalScreen(
  code: string | null,
  reference: string,
  retry: CustomerButton,
  orderId: string | null,
  kind: 'ORDER' | 'TOPUP',
  paymentId: string,
): PendingReply | null {
  if (code === null) return null;
  const wizard = { kind, step: 'NOTICE' as const, paymentId };
  if (code === TETRAPAY_DAILY_LIMIT_STORED) {
    return {
      key: 'bot.payment.tetrapay_daily_limit',
      values: { reference },
      buttons: [retry, mainMenuButton()],
      orderId,
      wizard,
    };
  }
  const range = new RegExp(
    `^${TETRAPAY_AMOUNT_OUT_OF_RANGE_STORED.replace('.', '\\.')}:(\\d{1,18}):(\\d{1,18})$`,
    'u',
  ).exec(code);
  if (range === null) return null;
  const min = BigInt(range[1] ?? '0');
  const max = BigInt(range[2] ?? '0');
  return {
    key: 'bot.payment.tetrapay_amount_out_of_range',
    // A bound the provider did not state (0) is left out, and its line is dropped with it.
    values: {
      reference,
      ...(min > 0n ? { min: money(min, 'IRT') } : {}),
      ...(max > 0n ? { max: money(max, 'IRT') } : {}),
    },
    buttons: [retry, mainMenuButton()],
    orderId,
    wizard,
  };
}

/**
 * The screen for a Rialit create refusal the customer can act on, or null for any other code.
 * Pure: the code is what the attempt recorded — `rialit.AMOUNT_OUT_OF_RANGE:<min>:<max>` (the
 * payable outside Rialit's range, refused before any call) or a misconfiguration (both Nexa and
 * Rialit would charge a fee, or Rialit's payer figures did not add up), whose link was never shown.
 */
export function rialitRefusalScreen(
  code: string | null,
  reference: string,
  retry: CustomerButton,
  orderId: string | null,
  kind: 'ORDER' | 'TOPUP',
  paymentId: string,
): PendingReply | null {
  if (code === null) return null;
  const wizard = { kind, step: 'NOTICE' as const, paymentId };
  if (
    code === RIALIT_DOUBLE_FEE_STORED ||
    code === RIALIT_PAYER_AMOUNT_MISMATCH_STORED ||
    code === RIALIT_PAYER_AMOUNT_UNREADABLE_STORED
  ) {
    return {
      key: 'bot.payment.rialit_misconfigured',
      values: { reference },
      buttons: [retry, mainMenuButton()],
      orderId,
      wizard,
    };
  }
  const range = new RegExp(
    `^${RIALIT_AMOUNT_OUT_OF_RANGE_STORED.replace('.', '\\.')}:(\\d{1,18}):(\\d{1,18})$`,
    'u',
  ).exec(code);
  if (range === null) return null;
  return {
    key: 'bot.payment.rialit_amount_out_of_range',
    values: {
      reference,
      min: money(BigInt(range[1] ?? '0'), 'IRT'),
      max: money(BigInt(range[2] ?? '0'), 'IRT'),
    },
    buttons: [retry, mainMenuButton()],
    orderId,
    wizard,
  };
}

export function gatewayAttemptScreen(
  attempt: GatewayAttempt | GatewayAttemptView,
  orderId: string | null,
  at: Date,
  /**
   * A card-transfer attempt's card-change and receipt facts (TonPays Telegram, §8.1); null
   * for every other route — and absent, the card screen offers neither the receipt nor the
   * card-change button, never a stale one.
   */
  cardFacts: GatewayCardFacts | null = null,
): PendingReply {
  const { payment, invoice } = attempt;
  const kind = payment.orderId === null ? ('TOPUP' as const) : ('ORDER' as const);
  /*
   * FIX-02: the payment's ONE public tracking code, on every screen of this attempt — the
   * preparing screen, the invoice, the review and every end — computed from the payment's
   * own stored reference, so a re-render, a worker edit or a replayed tap shows the same code.
   */
  const reference = paymentTrackingCode(payment);
  const check: CustomerButton = {
    ...inlineLabel('payment.gateway_check'),
    data: `${GATEWAY_CHECK_CALLBACK_PREFIX}${payment.id}`,
  };
  const retry: CustomerButton =
    payment.orderId === null ? topupButton() : payMethodsButton(payment.orderId);
  const screen = (
    key: TemplateKey,
    buttons: readonly CustomerButton[],
    step: WizardDirective['step'],
    pending = false,
  ): PendingReply => ({
    key,
    values: { reference },
    buttons: [...buttons, mainMenuButton()],
    orderId,
    wizard: {
      kind,
      step,
      paymentId: payment.id,
      ...(pending ? { invoicePending: true } : {}),
    },
  });
  if (payment.state === 'CONFIRMED') return screen('bot.payment.gateway_confirmed', [], 'CLOSED');
  /*
   * R5A item 4: the gateway approved after the payment closed and the amount went to the
   * wallet. Decided BEFORE the unresolved / closed / failed screens below, which would all
   * still tell this customer the payment is open, expired or lost. It offers no way to pay.
   */
  if (invoice.outcome === 'LATE_CREDITED') {
    return screen('bot.payment.gateway_late_credited_screen', [], 'CLOSED');
  }
  /*
   * TonPays Telegram, the owner's review window (§8.1, §9.6.6), decided BEFORE the "closed"
   * test below: a payment whose receipt the provider is reviewing is not closed, and one
   * whose review ended unresolved has neither failed nor closed. Neither invites a new
   * payment, a new receipt or a card change. Both stay `INVOICE` so the worker's edit of the
   * outcome (confirmed, failed) replaces them in place.
   */
  const reviewKeys = PROVIDER_REVIEW_SCREEN_KEYS[invoice.provider] ?? {
    inReview: 'bot.payment.gateway_in_review',
    unresolved: 'bot.payment.gateway_review_unresolved',
  };
  if (payment.state === 'UNKNOWN') {
    return screen(reviewKeys.unresolved, [], 'INVOICE');
  }
  /*
   * Round 6: an under- or overpaid invoice is never shown as plain open (or "in review"): it
   * has a next step, decided from what the provider's latest inquiry said. Before the review
   * and closed tests because a review window may be what the invoice is inside when the
   * provider finds the mismatch.
   */
  if (cardFacts !== null && invoice.creationState === 'CREATED') {
    const needed = providerNeedScreen(payment, invoice, orderId, at, cardFacts);
    if (needed !== null) return needed;
  }
  const reviewUntil = payment.providerReviewUntil ?? null;
  if (payment.state === 'PENDING' && reviewUntil !== null) {
    if (reviewUntil.getTime() > at.getTime()) {
      /*
       * R10 B6: the amount in RIAL, Toman beside it, as the card invoice states it. On a
       * card-transfer route that is the exact figure the invoice and its receipt-sent screen
       * told the customer to transfer (TonPays' `final_amount`), not the payable it differs
       * from by TonPays' marker; elsewhere the payable. `{payable}` stays for an old override.
       */
      const payable = payment.customerFee?.payable ?? payment.amount;
      const shown =
        PAYMENT_GATEWAY_DESCRIPTORS[invoice.provider].invoiceForm === 'CARD_TRANSFER'
          ? cardTransferAmount(invoice)
          : payable;
      return {
        key: reviewKeys.inReview,
        values: {
          payable,
          ...cardInvoiceAmountValues(shown),
          reviewUntil,
          reference,
        },
        buttons: [cardCheck(payment.id), mainMenuButton()],
        orderId,
        wizard: { kind, step: 'INVOICE', paymentId: payment.id },
      };
    }
    // Lapsed and not yet swept: the same truth the sweep is about to record.
    return screen(reviewKeys.unresolved, [], 'INVOICE');
  }
  /*
   * TetraPay's two create refusals a customer can act on: the daily limit (the route is hidden
   * until 00:00 Tehran) and an amount outside the provider's range (its own bounds, in Toman).
   * Read from the code the attempt recorded; every other refusal keeps the generic sentence.
   */
  const refusal =
    invoice.creationState === 'CREATE_FAILED'
      ? (tetrapayRefusalScreen(
          invoice.creationErrorCode,
          reference,
          retry,
          orderId,
          kind,
          payment.id,
        ) ??
        rialitRefusalScreen(invoice.creationErrorCode, reference, retry, orderId, kind, payment.id))
      : null;
  if (refusal !== null && (payment.state === 'FAILED' || payment.state === 'PENDING')) {
    return refusal;
  }
  if (payment.state === 'FAILED') {
    // Round 6: the customer's own cancel, a rejection with reasons, a buyer with another invoice.
    const failed = failedCardScreen(payment, invoice, orderId, cardFacts, screen);
    if (failed !== null) return failed;
    // A create the gateway refused is "unavailable" — or, Round 11 A8, "busy" when it was the
    // provider's own rate limit; an invoice it did not approve failed.
    return screen(
      invoice.creationState === 'CREATE_FAILED'
        ? createEndedRateLimited(invoice.provider, invoice.creationErrorCode)
          ? 'bot.payment.gateway_busy'
          : 'bot.payment.gateway_unavailable'
        : 'bot.payment.gateway_failed',
      [retry],
      'NOTICE',
    );
  }
  if (
    payment.state !== 'PENDING' ||
    payment.expiresAt === null ||
    payment.expiresAt.getTime() <= at.getTime()
  ) {
    return screen('bot.payment.gateway_closed', [retry], 'NOTICE');
  }
  /*
   * Telegram Stars (Package A): the invoice is its own Telegram message, sent by this bot —
   * Telegram cannot turn a text message into an invoice, so it follows this one. The summary
   * shows the principal, the fee when there is one, the payable in the sales currency and the
   * Stars asked for — all from THIS attempt's snapshot — while the invoice is being sent and
   * once it has been.
   *
   * B12: no «check payment status» button here. A Stars payment settles from Telegram's own
   * `successful_payment`, never from a status read, so the button could only ever answer
   * "still waiting"; the invoice message's Pay button (Telegram's own, the first and only
   * button of an invoice sent with no keyboard) is the one action, and the way back stays.
   */
  if (
    PAYMENT_GATEWAY_DESCRIPTORS[invoice.provider].invoiceCredential === 'BOT_TOKEN' &&
    (invoice.creationState === 'CREATING' || invoice.creationState === 'CREATED')
  ) {
    return {
      ...starsInvoiceBody(payment, invoice.sentAmount),
      buttons: [mainMenuButton()],
      orderId,
      wizard: { kind, step: 'INVOICE', paymentId: payment.id },
    };
  }
  /*
   * The loading screen: the worker edits this very message into the invoice once it exists.
   * Landed at `INVOICE_LOADING` and marked `INVOICE_PENDING` by the turn once its edit has
   * been asked for (`editWizard`). It carries the check button, gated from both, so a
   * worker edit that did not land is one tap from the current attempt.
   */
  if (invoice.creationState === 'CREATING') {
    return screen('bot.payment.gateway_preparing', [check], 'INVOICE_LOADING', true);
  }
  /*
   * F3 (round N): each end says what actually happened, and each offers a way on that opens
   * a NEW attempt — none of these is an open attempt (`findOpenAttempt`), so the retry is
   * never handed this one back.
   *
   * - A create the gateway REFUSED is "unavailable" even while its payment is still PENDING
   *   (the failure's own write did not land): it was a refusal, never a lost answer.
   * - An invoice the gateway reported CREATED with no link a customer can open: its answer
   *   was received, so it is not "the answer was lost".
   * - Only a create whose answer really was lost (`CREATE_UNKNOWN`) is `gateway_unknown`.
   */
  if (invoice.creationState === 'CREATE_FAILED') {
    const failed = failedCardScreen(payment, invoice, orderId, cardFacts, screen);
    if (failed !== null) return failed;
    return screen(
      createEndedRateLimited(invoice.provider, invoice.creationErrorCode)
        ? 'bot.payment.gateway_busy'
        : 'bot.payment.gateway_unavailable',
      [retry],
      'NOTICE',
    );
  }
  if (
    PAYMENT_GATEWAY_DESCRIPTORS[invoice.provider].invoiceForm === 'CARD_TRANSFER' &&
    invoice.creationState === 'CREATED'
  ) {
    return cardTransferScreen(payment, invoice, orderId, at, cardFacts);
  }
  const link = invoice.webInvoiceUrl ?? invoice.invoiceUrl;
  if (invoice.creationState === 'CREATED' && link === null) {
    return screen('bot.payment.gateway_no_link', [retry], 'NOTICE');
  }
  if (invoice.creationState !== 'CREATED' || link === null) {
    return screen('bot.payment.gateway_unknown', [retry], 'NOTICE');
  }
  /*
   * A route that charges a customer fee shows the three figures apart (WP18): the
   * principal — the order amount, or the top-up the wallet receives — the gateway fee, and
   * the payable the invoice asks for. From THIS attempt's snapshot, never the route's
   * current rate. With no fee the single amount is already all three.
   */
  const fee = payment.customerFee;
  /*
   * Rialit's link lives thirty minutes while the attempt lives seventy (owner rule): the
   * customer is shown the LINK's deadline, and once it has passed the pay button is no longer
   * offered — the check button stays, since Rialit can still report a payment made in time.
   */
  const payBy =
    invoice.provider === 'RIALIT'
      ? rialitLinkDeadline(invoice.createdInvoiceAt ?? invoice.createdAt, payment.expiresAt)
      : payment.expiresAt;
  const linkOpen = payBy.getTime() > at.getTime();
  /*
   * Rialit, with Nexa's own fee off and Rialit's payer fee on (owner rule: only ONE side
   * charges): the customer pays Rialit's `payer_amount`, so that is the figure shown — the
   * order (or top-up) as sent, Rialit's fee, and what the page will ask for, all in Rialit's
   * Toman. Display only: the payment settles and credits its principal as on every route.
   */
  const rialitPayerFee =
    invoice.provider === 'RIALIT' &&
    (fee === null || fee.fee.amountMinor === 0n) &&
    invoice.finalAmount !== null &&
    invoice.finalAmount > invoice.sentAmount
      ? invoice.finalAmount - invoice.sentAmount
      : null;
  const invoiceBody: Pick<PendingReply, 'key' | 'values'> =
    rialitPayerFee !== null && invoice.finalAmount !== null
      ? {
          key:
            payment.orderId === null
              ? 'bot.payment.gateway_invoice_topup_fee'
              : 'bot.payment.gateway_invoice_order_fee',
          values: {
            principal: money(invoice.sentAmount, 'IRT'),
            fee: money(rialitPayerFee, 'IRT'),
            payable: money(invoice.finalAmount, 'IRT'),
            expiresAt: payBy,
            reference,
          },
        }
      : fee !== null && fee.fee.amountMinor > 0n
        ? {
            key:
              payment.orderId === null
                ? 'bot.payment.gateway_invoice_topup_fee'
                : 'bot.payment.gateway_invoice_order_fee',
            values: {
              principal: payment.amount,
              fee: fee.fee,
              payable: fee.payable,
              expiresAt: payBy,
              reference,
            },
          }
        : {
            key: 'bot.payment.gateway_invoice',
            values: { total: payment.amount, expiresAt: payBy, reference },
          };
  return {
    ...invoiceBody,
    buttons: [
      ...(linkOpen
        ? [
            {
              ...inlineLabel(PROVIDER_PAY_BUTTON_KEYS[invoice.provider] ?? 'payment.gateway_pay'),
              url: link,
            },
          ]
        : []),
      check,
      mainMenuButton(),
    ],
    orderId,
    wizard: { kind, step: 'INVOICE', paymentId: payment.id },
  };
}

export function topupButton(): CustomerButton {
  return {
    ...inlineLabel('wallet.topup'),
    data: TOPUP_MENU_CALLBACK_PREFIX,
  };
}
