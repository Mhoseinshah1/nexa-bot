import { z } from 'zod';
import { CUSTOMER_NOTIFICATION_TEMPLATES } from './customer-notifications.js';
import type { GatewayInvoiceCreationState } from './gateway-invoices.js';
import type { PaymentMethod, PaymentState } from './payment.js';
import type { PaymentOpsQueue } from './payment-operations.js';
import type { ReceiptDisposition } from './payment-receipts.js';
import { REFUND_METHOD_SUPPORT } from './refunds.js';
import type { TemplateKey } from './templates.js';

/**
 * The under-review UX (roadmap E1, `docs/payments-under-review-ux.md`).
 *
 * ## What a situation is, and what it is not
 *
 * A SITUATION is the answer to "what is going on with this payment, in words an operator can
 * act on". It is derived from facts other flows already RECORDED — the payment's state, the
 * customer's claim, the provider's review window, the gateway's last word, the refunds — and
 * it is never stored and never written. It is not a state:
 *
 * - `PAYMENT_STATES` stays the one answer to "where is this payment", and every surface that
 *   shows a situation shows the state beside it;
 * - two accounting states never become one situation. `FAILED` alone is four situations
 *   (`REJECTED`, `CREDITED_TO_WALLET`, `FAILED`, and `LATE_COMPLETION`/`PARTIAL` when the
 *   provider later said otherwise), because each means something different about the money;
 * - and one situation never spans two states with different money: `CONFIRMED` is not
 *   merged with `REFUNDED`, and an `UNKNOWN` is never shown as a failure.
 *
 * ## One computation
 *
 * `paymentSituationOf` is the ONE classifier. The server calls it while building a payment
 * summary and sends its answer; the Web Admin renders that answer and never classifies. The
 * operator's actions are decided here too, from the same facts the services decide them on
 * (`REFUND_METHOD_SUPPORT`, the reconcile rule's `UNKNOWN`), so a button the guide offers is a
 * command the server will accept the shape of — the server still decides authoritatively.
 */
export const PAYMENT_SITUATIONS = [
  /** PENDING; the customer has the instructions or the link and has said nothing yet. */
  'AWAITING_PAYMENT',
  /** PENDING gateway attempt whose invoice was refused or whose create answer was lost. */
  'INVOICE_NOT_ISSUED',
  /** PENDING manual transfer the customer SAYS they sent. Their claim, never evidence. */
  'CUSTOMER_SIGNALLED',
  /** PENDING inside the provider's own review window (TonPays Telegram, NOWPayments). */
  'PROVIDER_REVIEW',
  /** UNKNOWN with nothing more specific recorded: a lapsed review, a lost answer. */
  'OUTCOME_UNKNOWN',
  /** The gateway lane held it for a mismatch (another amount, customer or reference). */
  'MISMATCH',
  /** The provider's own "partially paid" status was recorded on a payment not confirmed. */
  'PARTIAL',
  /** The provider approved after the attempt stopped being eligible. Nothing settled. */
  'LATE_COMPLETION',
  /** CONFIRMED with no refund row. */
  'CONFIRMED',
  /** CONFIRMED with a refund still open (REQUESTED or AWAITING_EXTERNAL). */
  'REFUND_IN_PROGRESS',
  /** CONFIRMED with at least one COMPLETED refund and none open. */
  'REFUNDED',
  /** FAILED by state, a reviewer credited the receipt to the wallet instead. */
  'CREDITED_TO_WALLET',
  /** FAILED by an administrator's rejection. */
  'REJECTED',
  /** FAILED with no person deciding it: the gateway said unsuccessful, or reconciliation. */
  'FAILED',
  /** EXPIRED: the window closed with nothing confirmed. */
  'EXPIRED',
  /** CANCELLED: withdrawn before confirmation. */
  'CANCELLED',
] as const;
export type PaymentSituation = (typeof PAYMENT_SITUATIONS)[number];
export const paymentSituationSchema = z.enum(PAYMENT_SITUATIONS);

/**
 * Whether money probably moved, as far as THIS installation can say. Each member is a
 * different sentence to an operator and none is a guess dressed as a fact:
 *
 * - `NOT_YET` — nothing has been paid yet, and paying is still possible.
 * - `NO` — as recorded, no money arrived (a definite refusal, an expiry, a withdrawal, a
 *   rejection after review).
 * - `CLAIMED` — the customer says they paid; nobody has checked.
 * - `POSSIBLY` — the outside world may have taken money and this installation cannot tell.
 * - `PARTIALLY` — the provider recorded a partial payment.
 * - `AT_PROVIDER` — the provider approved, too late; the money sits with the provider and
 *   nothing was settled here.
 * - `YES` — confirmed by evidence this installation trusts.
 * - `TO_WALLET` — a reviewer judged money arrived and credited the wallet with what they saw.
 * - `RETURNING` — confirmed, and a refund of some of it is open.
 * - `RETURNED` — confirmed, and some or all of it went back.
 */
export const PAYMENT_MONEY_SIGNALS = [
  'NOT_YET',
  'NO',
  'CLAIMED',
  'POSSIBLY',
  'PARTIALLY',
  'AT_PROVIDER',
  'YES',
  'TO_WALLET',
  'RETURNING',
  'RETURNED',
] as const;
export type PaymentMoneySignal = (typeof PAYMENT_MONEY_SIGNALS)[number];

/**
 * What the CUSTOMER should do. `WAIT_DO_NOT_PAY_AGAIN` is the one that prevents double
 * charges, and it is the answer for every situation where money may already have moved.
 */
export const PAYMENT_CUSTOMER_GUIDANCE = [
  'PAY_WITHIN_WINDOW',
  'START_AGAIN',
  'WAIT_DO_NOT_PAY_AGAIN',
  'MAY_PAY_AGAIN',
  'NOTHING',
] as const;
export type PaymentCustomerGuidance = (typeof PAYMENT_CUSTOMER_GUIDANCE)[number];

/**
 * The operator actions that EXIST for a situation — each an existing command, never a new
 * one. None of them is "mark as paid".
 *
 * - `REVIEW_RECEIPT_IN_TELEGRAM` — approve, reject or credit, in Telegram only (Payment
 *   File 02 §10); the Web Admin shows what it decided and never decides it.
 * - `ASK_PROVIDER_AGAIN` — bring the next inquiry forward (`payments.reconcile`).
 * - `RECONCILE` — resolve an UNKNOWN from the RECORDED inquiry evidence (`payments.reconcile`).
 * - `VERIFY_AT_PROVIDER` — read the provider's own panel; a step, not a command.
 * - `MANUAL_WALLET_ADJUSTMENT` — the customer page's wallet credit (`users.wallet.credit`).
 *   The only path that exists for money the domain cannot settle (late or partial money on a
 *   payment that is no longer UNKNOWN); whether to use it is UNRESOLVED (`OQ-WP11A-03`), and
 *   the guide says so wherever it offers it.
 * - `ISSUE_REFUND` — an operator refund (`refunds.issue`), only where `REFUND_METHOD_SUPPORT`
 *   has a channel and the payment bought an order (a top-up is already on the wallet).
 * - `SETTLE_REFUND` — complete or fail an open refund (`refunds.issue`).
 */
export const PAYMENT_OPERATOR_ACTIONS = [
  'REVIEW_RECEIPT_IN_TELEGRAM',
  'ASK_PROVIDER_AGAIN',
  'RECONCILE',
  'VERIFY_AT_PROVIDER',
  'MANUAL_WALLET_ADJUSTMENT',
  'ISSUE_REFUND',
  'SETTLE_REFUND',
] as const;
export type PaymentOperatorAction = (typeof PAYMENT_OPERATOR_ACTIONS)[number];

/** What the classifier reads. Every field is something a flow already recorded. */
export interface PaymentSituationFacts {
  readonly state: PaymentState;
  readonly method: PaymentMethod;
  /** True for a payment that names no order: a wallet top-up. */
  readonly topup: boolean;
  readonly customerSignalled: boolean;
  /** `providerReviewUntil` is set: the provider acknowledged a receipt and opened a review. */
  readonly providerReviewOpened: boolean;
  /** `resolvedByAdminId` is set: a person decided the resolution. */
  readonly resolvedByAdmin: boolean;
  readonly receiptDisposition: ReceiptDisposition | null;
  /** The gateway invoice's creation state, or null for a payment with no invoice. */
  readonly invoiceCreation: GatewayInvoiceCreationState | null;
  /**
   * The Payment Operations Center queues the payment is in, from the SAME SQL predicates
   * the queue list and counts use — so the MISMATCH, PARTIAL and LATE_COMPLETION facts here
   * cannot disagree with the queue a chip opens.
   */
  readonly queues: readonly PaymentOpsQueue[];
  /** At least one refund REQUESTED or AWAITING_EXTERNAL. */
  readonly refundOpen: boolean;
  /** At least one refund COMPLETED. */
  readonly refundCompleted: boolean;
}

export interface PaymentSituationGuide {
  readonly situation: PaymentSituation;
  readonly money: PaymentMoneySignal;
  readonly customer: PaymentCustomerGuidance;
  readonly actions: readonly PaymentOperatorAction[];
  /** A person must act for this payment to move on. What the `NEEDS_ACTION` queue lists. */
  readonly needsAction: boolean;
}

/** The classification, in precedence order. Pure and total. */
export function paymentSituationCode(facts: PaymentSituationFacts): PaymentSituation {
  const inQueue = (queue: PaymentOpsQueue) => facts.queues.includes(queue);
  switch (facts.state) {
    case 'CONFIRMED':
      if (facts.refundOpen) return 'REFUND_IN_PROGRESS';
      if (facts.refundCompleted) return 'REFUNDED';
      return 'CONFIRMED';
    case 'UNKNOWN':
      if (inQueue('LATE_COMPLETION')) return 'LATE_COMPLETION';
      if (inQueue('PARTIAL')) return 'PARTIAL';
      if (inQueue('MISMATCH')) return 'MISMATCH';
      return 'OUTCOME_UNKNOWN';
    case 'PENDING':
      if (facts.providerReviewOpened) return 'PROVIDER_REVIEW';
      if (inQueue('PARTIAL')) return 'PARTIAL';
      if (
        facts.method === 'GATEWAY' &&
        (facts.invoiceCreation === 'CREATE_FAILED' || facts.invoiceCreation === 'CREATE_UNKNOWN')
      ) {
        return 'INVOICE_NOT_ISSUED';
      }
      if (facts.method === 'MANUAL_TRANSFER' && facts.customerSignalled) {
        return 'CUSTOMER_SIGNALLED';
      }
      return 'AWAITING_PAYMENT';
    case 'FAILED':
    case 'EXPIRED':
    case 'CANCELLED':
      /*
       * What the provider said AFTER the payment ended outranks how it ended: an expired
       * attempt the provider then approved is money at the provider, and showing it as
       * "expired, nothing moved" is the sentence that loses it.
       */
      if (inQueue('LATE_COMPLETION')) return 'LATE_COMPLETION';
      if (inQueue('PARTIAL')) return 'PARTIAL';
      if (facts.state === 'EXPIRED') return 'EXPIRED';
      if (facts.state === 'CANCELLED') return 'CANCELLED';
      if (facts.receiptDisposition === 'CREDITED_TO_WALLET') return 'CREDITED_TO_WALLET';
      if (facts.resolvedByAdmin) return 'REJECTED';
      return 'FAILED';
  }
}

const MONEY: Readonly<Record<PaymentSituation, PaymentMoneySignal>> = {
  AWAITING_PAYMENT: 'NOT_YET',
  INVOICE_NOT_ISSUED: 'NO',
  CUSTOMER_SIGNALLED: 'CLAIMED',
  PROVIDER_REVIEW: 'POSSIBLY',
  OUTCOME_UNKNOWN: 'POSSIBLY',
  MISMATCH: 'POSSIBLY',
  PARTIAL: 'PARTIALLY',
  LATE_COMPLETION: 'AT_PROVIDER',
  CONFIRMED: 'YES',
  REFUND_IN_PROGRESS: 'RETURNING',
  REFUNDED: 'RETURNED',
  CREDITED_TO_WALLET: 'TO_WALLET',
  REJECTED: 'NO',
  FAILED: 'NO',
  EXPIRED: 'NO',
  CANCELLED: 'NO',
};

const CUSTOMER: Readonly<Record<PaymentSituation, PaymentCustomerGuidance>> = {
  AWAITING_PAYMENT: 'PAY_WITHIN_WINDOW',
  INVOICE_NOT_ISSUED: 'START_AGAIN',
  CUSTOMER_SIGNALLED: 'WAIT_DO_NOT_PAY_AGAIN',
  PROVIDER_REVIEW: 'WAIT_DO_NOT_PAY_AGAIN',
  OUTCOME_UNKNOWN: 'WAIT_DO_NOT_PAY_AGAIN',
  MISMATCH: 'WAIT_DO_NOT_PAY_AGAIN',
  PARTIAL: 'WAIT_DO_NOT_PAY_AGAIN',
  LATE_COMPLETION: 'WAIT_DO_NOT_PAY_AGAIN',
  CONFIRMED: 'NOTHING',
  REFUND_IN_PROGRESS: 'NOTHING',
  REFUNDED: 'NOTHING',
  CREDITED_TO_WALLET: 'NOTHING',
  REJECTED: 'MAY_PAY_AGAIN',
  FAILED: 'MAY_PAY_AGAIN',
  EXPIRED: 'MAY_PAY_AGAIN',
  CANCELLED: 'NOTHING',
};

/** The situations a person must act on. The `NEEDS_ACTION` queue is this set in SQL. */
export const PAYMENT_SITUATIONS_NEEDING_ACTION: readonly PaymentSituation[] = [
  'CUSTOMER_SIGNALLED',
  'OUTCOME_UNKNOWN',
  'MISMATCH',
  'PARTIAL',
  'LATE_COMPLETION',
  'REFUND_IN_PROGRESS',
];

function actionsFor(
  situation: PaymentSituation,
  facts: PaymentSituationFacts,
): readonly PaymentOperatorAction[] {
  // Reconciliation exists for an UNKNOWN gateway payment and nothing else.
  const reconcilable = facts.state === 'UNKNOWN' && facts.method === 'GATEWAY';
  // An operator refund needs a channel this release performs, and an order it bought.
  const refundable =
    REFUND_METHOD_SUPPORT[facts.method].supported && !facts.topup && facts.state === 'CONFIRMED';
  switch (situation) {
    case 'CUSTOMER_SIGNALLED':
      return ['REVIEW_RECEIPT_IN_TELEGRAM'];
    case 'OUTCOME_UNKNOWN':
      return reconcilable ? ['ASK_PROVIDER_AGAIN', 'RECONCILE'] : ['VERIFY_AT_PROVIDER'];
    case 'MISMATCH':
      return reconcilable
        ? ['VERIFY_AT_PROVIDER', 'ASK_PROVIDER_AGAIN', 'RECONCILE']
        : ['VERIFY_AT_PROVIDER'];
    case 'PARTIAL':
    case 'LATE_COMPLETION':
      return reconcilable
        ? ['VERIFY_AT_PROVIDER', 'ASK_PROVIDER_AGAIN', 'RECONCILE']
        : ['VERIFY_AT_PROVIDER', 'MANUAL_WALLET_ADJUSTMENT'];
    case 'CONFIRMED':
    case 'REFUNDED':
      return refundable ? ['ISSUE_REFUND'] : [];
    case 'REFUND_IN_PROGRESS':
      return ['SETTLE_REFUND'];
    default:
      return [];
  }
}

/** The one classifier: the situation and everything an operator is told about it. */
export function paymentSituationOf(facts: PaymentSituationFacts): PaymentSituationGuide {
  const situation = paymentSituationCode(facts);
  return {
    situation,
    money: MONEY[situation],
    customer: CUSTOMER[situation],
    actions: actionsFor(situation, facts),
    needsAction: PAYMENT_SITUATIONS_NEEDING_ACTION.includes(situation),
  };
}

/** The guide on the wire, inside a payment summary. */
export const paymentSituationViewSchema = z.object({
  situation: paymentSituationSchema,
  money: z.enum(PAYMENT_MONEY_SIGNALS),
  customer: z.enum(PAYMENT_CUSTOMER_GUIDANCE),
  actions: z.array(z.enum(PAYMENT_OPERATOR_ACTIONS)),
  needsAction: z.boolean(),
});
export type PaymentSituationView = z.infer<typeof paymentSituationViewSchema>;

/**
 * What the CUSTOMER was told in each situation: the frozen template keys that carry it.
 *
 * Every customer-facing sentence is a template key (`CLAUDE.md`); this table is the audit
 * that each situation has one, and the two that deliberately have none say why:
 *
 * - `LATE_COMPLETION` — telling the customer "we saw your late payment" would promise an
 *   outcome nobody has decided (`OQ-WP11A-03`: credit by hand, or nothing). The customer
 *   was told the attempt expired or was unresolved, which was true when it was said.
 * - `REFUND_IN_PROGRESS` — an open refund has moved nothing; the customer is told when it
 *   completes (`REFUND_COMPLETED`), never that it was requested.
 */
export const PAYMENT_SITUATION_CUSTOMER_TEMPLATES: Readonly<
  Record<PaymentSituation, readonly TemplateKey[]>
> = {
  AWAITING_PAYMENT: [
    'bot.payment.transfer_instructions',
    'bot.payment.gateway_invoice',
    'bot.payment.pending_reminder',
  ],
  INVOICE_NOT_ISSUED: ['bot.payment.gateway_unknown', 'bot.payment.gateway_unavailable'],
  CUSTOMER_SIGNALLED: [
    'bot.payment.receipt_prompt',
    'bot.payment.received_for_review',
    'bot.payment.receipt_received',
  ],
  PROVIDER_REVIEW: ['bot.payment.gateway_in_review', 'bot.payment.nowpayments_in_review'],
  OUTCOME_UNKNOWN: [
    'bot.payment.gateway_review_unresolved',
    'bot.payment.nowpayments_review_unresolved',
    'bot.payment.centralpay_review_unresolved',
  ],
  MISMATCH: [
    'bot.payment.gateway_review_unresolved',
    'bot.payment.nowpayments_review_unresolved',
    'bot.payment.centralpay_review_unresolved',
  ],
  PARTIAL: ['bot.payment.nowpayments_review_unresolved'],
  LATE_COMPLETION: [],
  CONFIRMED: [
    'bot.payment.gateway_confirmed',
    CUSTOMER_NOTIFICATION_TEMPLATES.WALLET_TOPUP_CREDITED,
  ],
  REFUND_IN_PROGRESS: [],
  REFUNDED: [
    CUSTOMER_NOTIFICATION_TEMPLATES.REFUND_COMPLETED,
    CUSTOMER_NOTIFICATION_TEMPLATES.ORDER_REFUNDED_TO_WALLET,
  ],
  CREDITED_TO_WALLET: [CUSTOMER_NOTIFICATION_TEMPLATES.RECEIPT_CREDITED_TO_WALLET],
  REJECTED: [CUSTOMER_NOTIFICATION_TEMPLATES.PAYMENT_REJECTED],
  FAILED: [CUSTOMER_NOTIFICATION_TEMPLATES.GATEWAY_PAYMENT_FAILED],
  EXPIRED: [CUSTOMER_NOTIFICATION_TEMPLATES.PAYMENT_EXPIRED],
  CANCELLED: ['bot.payment.cancelled'],
};
