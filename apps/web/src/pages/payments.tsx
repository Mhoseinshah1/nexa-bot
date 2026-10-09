import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  COMMERCE_ERROR_CODES,
  PAYMENT_GATEWAY_PROVIDERS,
  PAYMENT_METHODS,
  PAYMENT_OPS_QUEUES,
  formatBasisPointsPercent,
  PAYMENT_STATES,
  RECEIPT_DISPOSITIONS,
  type RefundChannel,
  type RefundRefusalReason,
  type RefundResponse,
  type RefundState,
  type RefundView,
  type GatewayConversionPolicy,
  type PaymentMethod,
  type PaymentReceiptView,
  type PaymentState,
  type PaymentSummaryResponse,
  type PaymentDetailResponse,
  type PaymentAttentionResponse,
  type PaymentGatewayProvider,
  type PaymentOpsQueue,
  type ReceiptDisposition,
  type ReportRange,
  type PaymentSituation,
  type PaymentMoneySignal,
  type PaymentCustomerGuidance,
  type PaymentOperatorAction,
  type PaymentSituationView,
  type GatewayRateAuthority,
  type GatewayRateProvenance,
  paymentTrackingCode,
} from '@nexa/contracts';
import {
  ApiError,
  completeRefund,
  failRefund,
  fetchOrder,
  fetchPayment,
  fetchPaymentAttention,
  fetchPaymentReceipts,
  fetchPaymentReceiptBytes,
  fetchPayments,
  fetchRefunds,
  reconcilePayment,
  reinquirePayment,
  requestRefund,
} from '../api/client';
import { formatDecimalText, formatMoneyText, formatTimestamp, splitBytes } from '../format';
import { useSubmissionKey } from '../submission-key';
import { mayRequest, queryState, staleAfterError } from '../view-state';
import { t, type WebKey } from '../i18n/web.fa';
import { setQueries, setQuery, useLinkHandler, type Route } from '../router';
import { ListSearchBox, appliedListSearch } from '../ui/list-search';
import { CustomerIdentityLink } from '../ui/customer-identity';
import { messageFor } from './settings';
import { PaymentTimelineCard } from './payment-timeline';
import { ChipGroup } from './commerce-parts';
import {
  Disclosure,
  Badge,
  Banner,
  Button,
  Card,
  ChipDivider,
  CopyButton,
  Copyable,
  CursorPager,
  DataTable,
  Empty,
  Field,
  FilterChip,
  FilterChips,
  Input,
  KV,
  Ltr,
  Money,
  PageHead,
  StateSwitch,
  TwoColumn,
  useToast,
  useUnsavedChanges,
  type Column,
  type Tone,
  Num,
} from '../ui/kit';
import {
  PAYMENT_METHOD_LABELS as METHOD_LABELS,
  PAYMENT_STATE_LABELS as STATE_LABELS,
  PAYMENT_STATE_TONES as STATE_TONES,
} from '../payment-labels';

// Review N8: the vocabulary moved to `payment-labels.ts`; these names stay importable from
// here under their old spelling, so a workstream that reads them from this page still builds.
export { STATE_LABELS, STATE_TONES, METHOD_LABELS };

/**
 * Payments — the money, and where it came from.
 *
 * The one write here is a REFUND. Card-to-card review — approve, reject, or credit to the
 * wallet — is performed in Telegram only (Payment File 02 §10, D3), and this page shows
 * what it decided and never offers to decide it. There is no create, no fail, no cancel
 * and no retry, and each absence is deliberate rather than unfinished. A payment is
 * created by a CUSTOMER choosing how to pay; `payments.retry` is a frozen permission for
 * a gateway that does not ship; and a retry button with nothing behind it is the legacy
 * silent-success pattern.
 *
 * **PAID means the money arrived and nothing else.** Nothing on this page says a
 * service was created, is being prepared or is on its way, because nothing in this
 * release does any of that. The banner at the bottom of the detail says so in words,
 * which is what `planned.tsx` argues for: an operator who confirms a payment and sees
 * no service needs to know that is the design rather than a failure.
 *
 * `UNKNOWN` is rendered as what it is — an ABSENCE of an outcome. `payment.ts` leaves
 * it non-terminal precisely so reconciliation is legal, and the banner tells an operator
 * that it is neither a success nor a failure until somebody establishes which.
 */

/** Package FX: how a gateway invoice's provider figure was derived from the payable. */
const CONVERSION_POLICY_LABELS: Readonly<Record<GatewayConversionPolicy, WebKey>> = {
  SAME_UNIT: 'web.fx_policy_same_unit',
  FIXED_RATE: 'web.fx_policy_fixed_rate',
  CENTRAL_FX: 'web.fx_policy_central_fx',
};

const REFUND_STATE_LABELS: Readonly<Record<RefundState, WebKey>> = {
  REQUESTED: 'web.refund_state_requested',
  AWAITING_EXTERNAL: 'web.refund_state_awaiting',
  COMPLETED: 'web.refund_state_completed',
  FAILED: 'web.refund_state_failed',
};

/*
 * `AWAITING_EXTERNAL` is `warn` and `FAILED` is neutral, which is the opposite of the
 * payment table's instinct and is correct here. A refund awaiting an external transfer
 * is money somebody still owes and a thing an operator must act on; a FAILED refund is
 * a decision that was cleanly abandoned and released its amount, which is not an
 * error — it is the honest alternative to deleting the row.
 */
const REFUND_STATE_TONES: Readonly<Record<RefundState, Tone>> = {
  REQUESTED: 'warn',
  AWAITING_EXTERNAL: 'warn',
  COMPLETED: 'ok',
  FAILED: 'neutral',
};

/**
 * Roadmap E3 (`docs/refund-audit.md`): why a payment cannot be refunded AT ALL, in the
 * server's own words (`refusalReason`), each with what exists instead. Total over the
 * contract's reasons. There is no control behind any of them: where no domain operation
 * exists, the page says so rather than offering one.
 */
const REFUND_REFUSAL_TEXT: Readonly<Record<RefundRefusalReason, WebKey>> = {
  PAYMENT_NOT_SETTLED: 'web.refund_refusal_not_settled',
  CHANNEL_UNSUPPORTED: 'web.refund_refusal_channel_unsupported',
  TOPUP_CREDITED_TO_WALLET: 'web.refund_refusal_topup',
  CURRENCY_MISMATCH: 'web.refund_refusal_currency',
  DELIVERY_IN_PROGRESS: 'web.refund_refusal_delivery',
};

const REFUND_CHANNEL_LABELS: Readonly<Record<RefundChannel, WebKey>> = {
  WALLET_CREDIT: 'web.refund_channel_wallet',
  EXTERNAL_MANUAL: 'web.refund_channel_manual',
  PROVIDER: 'web.refund_channel_provider',
};

/**
 * A refund refusal, naming P3's delivery reason when — and only when — the SERVER named
 * it. `REFUND_NOT_PERMITTED` carries its reason as a detail; any other reason keeps the
 * server's own message, which names what to change.
 */
function refundMessageFor(error: unknown): string {
  if (
    error instanceof ApiError &&
    error.code === COMMERCE_ERROR_CODES.REFUND_NOT_PERMITTED &&
    error.details?.['reason'] === 'DELIVERY_IN_PROGRESS'
  ) {
    return t('web.refund_delivery_in_progress');
  }
  return messageFor(error);
}

/**
 * Digits only, as a decimal STRING of minor units.
 *
 * Never parsed to a number: JSON has no bigint and a `number` is the float the money
 * model refuses, silently, above 2^53. Anything that is not digits collapses to `'0'`,
 * which the button below reads as "nothing to submit" — the server's own schema is what
 * refuses a malformed amount, and this only stops the form offering to send one.
 */
function digitsOf(value: string): string {
  const trimmed = value.trim();
  return /^[0-9]{1,19}$/u.test(trimmed) ? trimmed.replace(/^0+(?=[0-9])/u, '') : '0';
}

function StateBadge({ value }: { value: PaymentState }) {
  return (
    <Badge tone={STATE_TONES[value]} dot>
      {t(STATE_LABELS[value])}
    </Badge>
  );
}

/**
 * How a card-to-card receipt left review (WP10 follow-up §5), derived by the server.
 *
 * The point is the credited one: a receipt credited to the wallet is FAILED by state, and a
 * state badge alone reads exactly like a rejection. `ok` for the credit because money DID
 * reach the customer; the state badge beside it still says the order was not paid by it.
 */
const DISPOSITION_LABELS: Readonly<Record<ReceiptDisposition, WebKey>> = {
  APPROVED: 'web.payment_disposition_approved',
  REJECTED: 'web.payment_disposition_rejected',
  CREDITED_TO_WALLET: 'web.payment_disposition_credited',
};

const DISPOSITION_TONES: Readonly<Record<ReceiptDisposition, Tone>> = {
  APPROVED: 'ok',
  REJECTED: 'danger',
  CREDITED_TO_WALLET: 'ok',
};

function DispositionBadge({ value }: { value: ReceiptDisposition | null }) {
  if (value === null) return <Dash />;
  return (
    <Badge tone={DISPOSITION_TONES[value]} outline>
      {t(DISPOSITION_LABELS[value])}
    </Badge>
  );
}

/**
 * A TonPays Telegram payment whose receipt the provider acknowledged in time
 * (`docs/tonpays-telegram-gateway-audit.md` §9.6): still PENDING, its deadline moved to the
 * end of the 24-hour review. Neither paid nor failed — the badge says only that.
 */
function inProviderReview(row: Pick<PaymentSummaryResponse, 'state' | 'providerReviewUntil'>) {
  return row.state === 'PENDING' && row.providerReviewUntil !== null;
}

function Dash() {
  return <span className="faint">—</span>;
}

/**
 * Who paid, as Telegram knows them: the numeric id, and the username when they have one
 * (Payment File 02 §21). The id is the identity; a username is chosen by the person it
 * names, so it is shown beside the id and never instead of it.
 */
export function TelegramIdentity({
  telegramUserId,
  username,
}: {
  telegramUserId: string | null;
  username: string | null;
}) {
  if (telegramUserId === null) return <Dash />;
  return (
    <span className="nowrap">
      <Ltr>{telegramUserId}</Ltr>
      {username !== null && (
        <>
          {' '}
          <span className="muted small">
            <Ltr>{`@${username}`}</Ltr>
          </span>
        </>
      )}
    </span>
  );
}

/** The route a payment was offered through, by name, or a dash for a wallet settlement. */
const GATEWAY_LABELS: Readonly<Record<PaymentGatewayProvider, WebKey>> = {
  MANUAL_TRANSFER: 'web.payment_gateway_provider_manual_transfer',
  TONPAYS: 'web.payment_gateway_provider_tonpays',
  TONPAYS_TELEGRAM: 'web.payment_gateway_provider_tonpays_telegram',
  TELEGRAM_STARS: 'web.payment_gateway_provider_telegram_stars',
  NOWPAYMENTS: 'web.payment_gateway_provider_nowpayments',
  CENTRALPAY: 'web.payment_gateway_provider_centralpay',
};

function gatewayLabel(provider: PaymentGatewayProvider): string {
  return t(GATEWAY_LABELS[provider]);
}

function GatewayName({ provider }: { provider: string | null }) {
  if (provider === null) return <Dash />;
  if (provider === 'MANUAL_TRANSFER')
    return <>{t('web.payment_gateway_provider_manual_transfer')}</>;
  if (provider === 'TONPAYS') return <>{t('web.payment_gateway_provider_tonpays')}</>;
  if (provider === 'TONPAYS_TELEGRAM') {
    return <>{t('web.payment_gateway_provider_tonpays_telegram')}</>;
  }
  if (provider === 'TELEGRAM_STARS') {
    return <>{t('web.payment_gateway_provider_telegram_stars')}</>;
  }
  if (provider === 'NOWPAYMENTS') return <>{t('web.payment_gateway_provider_nowpayments')}</>;
  if (provider === 'CENTRALPAY') return <>{t('web.payment_gateway_provider_centralpay')}</>;
  return <Ltr>{provider}</Ltr>;
}

// ---------------------------------------------------------------------------
// The situation guide (roadmap E1, `docs/payments-under-review-ux.md`)
// ---------------------------------------------------------------------------

/*
 * Each map is TOTAL over its contract enum, so a situation added to the contract without
 * words here is a compile error rather than a blank cell. The page renders the SERVER's
 * classification (`payment.situation`) and never classifies: no state, receipt or provider
 * status is read here to decide what a payment means.
 */
const SITUATION_LABELS: Readonly<Record<PaymentSituation, WebKey>> = {
  AWAITING_PAYMENT: 'web.payment_situation_awaiting_payment',
  INVOICE_NOT_ISSUED: 'web.payment_situation_invoice_not_issued',
  CUSTOMER_SIGNALLED: 'web.payment_situation_customer_signalled',
  RECEIPT_UNDER_REVIEW: 'web.payment_situation_receipt_under_review',
  PROVIDER_REVIEW: 'web.payment_situation_provider_review',
  OUTCOME_UNKNOWN: 'web.payment_situation_outcome_unknown',
  MISMATCH: 'web.payment_situation_mismatch',
  PARTIAL: 'web.payment_situation_partial',
  LATE_COMPLETION: 'web.payment_situation_late_completion',
  CONFIRMED: 'web.payment_situation_confirmed',
  REFUND_IN_PROGRESS: 'web.payment_situation_refund_in_progress',
  REFUNDED: 'web.payment_situation_refunded',
  CREDITED_TO_WALLET: 'web.payment_situation_credited_to_wallet',
  REJECTED: 'web.payment_situation_rejected',
  FAILED: 'web.payment_situation_failed',
  EXPIRED: 'web.payment_situation_expired',
  CANCELLED: 'web.payment_situation_cancelled',
};

const SITUATION_WHAT: Readonly<Record<PaymentSituation, WebKey>> = {
  AWAITING_PAYMENT: 'web.payment_situation_what_awaiting_payment',
  INVOICE_NOT_ISSUED: 'web.payment_situation_what_invoice_not_issued',
  CUSTOMER_SIGNALLED: 'web.payment_situation_what_customer_signalled',
  RECEIPT_UNDER_REVIEW: 'web.payment_situation_what_receipt_under_review',
  PROVIDER_REVIEW: 'web.payment_situation_what_provider_review',
  OUTCOME_UNKNOWN: 'web.payment_situation_what_outcome_unknown',
  MISMATCH: 'web.payment_situation_what_mismatch',
  PARTIAL: 'web.payment_situation_what_partial',
  LATE_COMPLETION: 'web.payment_situation_what_late_completion',
  CONFIRMED: 'web.payment_situation_what_confirmed',
  REFUND_IN_PROGRESS: 'web.payment_situation_what_refund_in_progress',
  REFUNDED: 'web.payment_situation_what_refunded',
  CREDITED_TO_WALLET: 'web.payment_situation_what_credited_to_wallet',
  REJECTED: 'web.payment_situation_what_rejected',
  FAILED: 'web.payment_situation_what_failed',
  EXPIRED: 'web.payment_situation_what_expired',
  CANCELLED: 'web.payment_situation_what_cancelled',
};

const SITUATION_SAFE: Readonly<Record<PaymentSituation, WebKey>> = {
  AWAITING_PAYMENT: 'web.payment_situation_safe_awaiting_payment',
  INVOICE_NOT_ISSUED: 'web.payment_situation_safe_invoice_not_issued',
  CUSTOMER_SIGNALLED: 'web.payment_situation_safe_customer_signalled',
  RECEIPT_UNDER_REVIEW: 'web.payment_situation_safe_receipt_under_review',
  PROVIDER_REVIEW: 'web.payment_situation_safe_provider_review',
  OUTCOME_UNKNOWN: 'web.payment_situation_safe_outcome_unknown',
  MISMATCH: 'web.payment_situation_safe_mismatch',
  PARTIAL: 'web.payment_situation_safe_partial',
  LATE_COMPLETION: 'web.payment_situation_safe_late_completion',
  CONFIRMED: 'web.payment_situation_safe_confirmed',
  REFUND_IN_PROGRESS: 'web.payment_situation_safe_refund_in_progress',
  REFUNDED: 'web.payment_situation_safe_refunded',
  CREDITED_TO_WALLET: 'web.payment_situation_safe_credited_to_wallet',
  REJECTED: 'web.payment_situation_safe_rejected',
  FAILED: 'web.payment_situation_safe_failed',
  EXPIRED: 'web.payment_situation_safe_expired',
  CANCELLED: 'web.payment_situation_safe_cancelled',
};

/*
 * The tone says how much attention, never which way the money went: every situation where
 * money MAY have moved is `warn`, not `danger` and not `ok` — the rule `STATE_TONES` states
 * for UNKNOWN.
 */
const SITUATION_TONES: Readonly<Record<PaymentSituation, Tone>> = {
  AWAITING_PAYMENT: 'neutral',
  INVOICE_NOT_ISSUED: 'neutral',
  CUSTOMER_SIGNALLED: 'info',
  RECEIPT_UNDER_REVIEW: 'warn',
  PROVIDER_REVIEW: 'info',
  OUTCOME_UNKNOWN: 'warn',
  MISMATCH: 'warn',
  PARTIAL: 'warn',
  LATE_COMPLETION: 'warn',
  CONFIRMED: 'ok',
  REFUND_IN_PROGRESS: 'warn',
  REFUNDED: 'neutral',
  CREDITED_TO_WALLET: 'ok',
  REJECTED: 'danger',
  FAILED: 'danger',
  EXPIRED: 'neutral',
  CANCELLED: 'neutral',
};

const MONEY_LABELS: Readonly<Record<PaymentMoneySignal, WebKey>> = {
  NOT_YET: 'web.payment_money_not_yet',
  NO: 'web.payment_money_no',
  CLAIMED: 'web.payment_money_claimed',
  POSSIBLY: 'web.payment_money_possibly',
  PARTIALLY: 'web.payment_money_partially',
  AT_PROVIDER: 'web.payment_money_at_provider',
  YES: 'web.payment_money_yes',
  TO_WALLET: 'web.payment_money_to_wallet',
  RETURNING: 'web.payment_money_returning',
  RETURNED: 'web.payment_money_returned',
};

const CUSTOMER_GUIDANCE_LABELS: Readonly<Record<PaymentCustomerGuidance, WebKey>> = {
  PAY_WITHIN_WINDOW: 'web.payment_customer_guidance_pay_within_window',
  SEND_RECEIPT: 'web.payment_customer_guidance_send_receipt',
  START_AGAIN: 'web.payment_customer_guidance_start_again',
  WAIT_DO_NOT_PAY_AGAIN: 'web.payment_customer_guidance_wait_do_not_pay_again',
  MAY_PAY_AGAIN: 'web.payment_customer_guidance_may_pay_again',
  NOTHING: 'web.payment_customer_guidance_nothing',
};

const OPERATOR_ACTION_LABELS: Readonly<Record<PaymentOperatorAction, WebKey>> = {
  REVIEW_RECEIPT_IN_TELEGRAM: 'web.payment_operator_action_review_receipt_in_telegram',
  ASK_PROVIDER_AGAIN: 'web.payment_operator_action_ask_provider_again',
  RECONCILE: 'web.payment_operator_action_reconcile',
  VERIFY_AT_PROVIDER: 'web.payment_operator_action_verify_at_provider',
  MANUAL_WALLET_ADJUSTMENT: 'web.payment_operator_action_manual_wallet_adjustment',
  ISSUE_REFUND: 'web.payment_operator_action_issue_refund',
  SETTLE_REFUND: 'web.payment_operator_action_settle_refund',
};

/** The server's situation, as a badge; a dash for a response from before it existed. */
export function SituationBadge({ value }: { value: PaymentSituationView | null }) {
  if (value === null) return <Dash />;
  return (
    <Badge tone={SITUATION_TONES[value.situation]} outline={!value.needsAction}>
      {t(SITUATION_LABELS[value.situation])}
    </Badge>
  );
}

/**
 * The guidance card: what happened, whether money probably moved, what the customer should
 * do, which EXISTING operator actions apply, and what is safe. Every line is the server's
 * classification rendered through a total map; the controls themselves stay on the cards
 * that hold the evidence (reconcile, refunds), each still gated by its own permission.
 */
export function SituationCard({ value }: { value: PaymentSituationView | null }) {
  if (value === null) return null;
  const situation: PaymentSituation = value.situation;
  return (
    <Card
      title={t('web.payment_situation_card')}
      {...(value.needsAction
        ? {
            actions: (
              <Badge tone="warn" dot>
                {t('web.payment_situation_needs_action')}
              </Badge>
            ),
          }
        : {})}
    >
      <KV
        items={[
          [
            t('web.payment_situation_what'),
            <span key="s">
              <SituationBadge value={value} /> {t(SITUATION_WHAT[situation])}
            </span>,
          ],
          [t('web.payment_situation_money'), t(MONEY_LABELS[value.money])],
          [t('web.payment_situation_customer'), t(CUSTOMER_GUIDANCE_LABELS[value.customer])],
          [
            t('web.payment_situation_actions'),
            value.actions.length === 0 ? (
              <span key="a" className="muted small">
                {t('web.payment_situation_no_action')}
              </span>
            ) : (
              <ul key="a" className="plain">
                {value.actions.map((action) => (
                  <li key={action}>{t(OPERATOR_ACTION_LABELS[action])}</li>
                ))}
              </ul>
            ),
          ],
          [t('web.payment_situation_safe'), t(SITUATION_SAFE[situation])],
        ]}
      />
      <p className="muted small">{t('web.payment_situation_state_note')}</p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Money and rate provenance (roadmap E4, E5 — `docs/payment-fees-fx.md`)
// ---------------------------------------------------------------------------

/**
 * The payment's money as the server computed it (`paymentAmountsOf`): every figure is a
 * decimal string the page renders with its currency and never adds, subtracts or derives a
 * percentage from. Merchant net is named as not recorded, because no record holds it.
 */
export function AmountsCard({ value }: { value: PaymentDetailResponse['amounts'] }) {
  if (value === null) return null;
  const money = (key: string, amountMinor: string) => (
    <Money key={key} value={{ amountMinor, currency: value.currency }} />
  );
  return (
    <Card title={t('web.payment_amounts')} hint={t('web.payment_amounts_hint')}>
      <KV
        items={[
          [t('web.payment_amounts_principal'), money('p', value.principal)],
          // The rate the fee was snapshotted at (WP18), shown as stored — never recomputed.
          ...(value.customerFeeBasisPoints === null
            ? []
            : ([
                [
                  t('web.payment_customer_fee_rate'),
                  <Num
                    key="b"
                    value={`${formatBasisPointsPercent(value.customerFeeBasisPoints)}%`}
                  />,
                ],
              ] as [ReactNode, ReactNode][])),
          [t('web.payment_customer_fee_amount'), money('f', value.customerFee)],
          // What the customer was ASKED to pay, in every state; `received` is what arrived.
          [t('web.payment_customer_fee_payable'), money('c', value.payable)],
          [t('web.payment_amounts_received'), money('r', value.received)],
          [t('web.payment_amounts_wallet_credit'), money('w', value.walletCredit)],
          [t('web.payment_amounts_wallet_debit'), money('d', value.walletDebit)],
          [
            t('web.payment_amounts_merchant_net'),
            <span key="n" className="muted small">
              {t('web.payment_amounts_merchant_net_not_recorded')}
            </span>,
          ],
        ]}
      />
      {value.customerFeeBasisPoints !== null && (
        <p className="muted small">{t('web.payment_customer_fee_hint')}</p>
      )}
    </Card>
  );
}

const RATE_AUTHORITY_LABELS: Readonly<Record<GatewayRateAuthority, WebKey>> = {
  NONE: 'web.payment_rate_authority_none',
  OPERATOR: 'web.payment_rate_authority_operator',
  MARKET: 'web.payment_rate_authority_market',
};

/**
 * Which authority priced a gateway attempt, at what rate and when (E5), from the attempt's
 * own frozen snapshot — never today's rate. A missing rate is said, not borrowed.
 */
export function RateProvenanceCard({ value }: { value: GatewayRateProvenance | null }) {
  if (value === null) return null;
  const when = (iso: string | null, key: string) =>
    iso === null ? <Dash key={key} /> : <span key={key}>{formatTimestamp(iso)}</span>;
  return (
    <Card title={t('web.payment_rate_provenance')} hint={t('web.payment_rate_provenance_hint')}>
      <KV
        items={[
          [t('web.payment_rate_authority'), t(RATE_AUTHORITY_LABELS[value.authority])],
          ...(value.authority === 'NONE'
            ? []
            : ([
                [
                  t('web.payment_rate_value'),
                  value.rate === null ? (
                    <span key="v" className="muted small">
                      {t('web.payment_rate_missing')}
                    </span>
                  ) : (
                    <Num key="v" value={formatDecimalText(value.rate)} />
                  ),
                ],
              ] as [ReactNode, ReactNode][])),
          ...(value.authority === 'MARKET'
            ? ([
                [
                  t('web.payment_rate_source'),
                  value.source === null ? <Dash key="s" /> : <Ltr key="s">{value.source}</Ltr>,
                ],
                [t('web.payment_rate_quoted_at'), when(value.quotedAt, 'q')],
                [t('web.payment_rate_fetched_at'), when(value.fetchedAt, 'g')],
                [
                  t('web.payment_rate_quote_state'),
                  value.quoteState === null ? (
                    <Dash key="st" />
                  ) : (
                    <Ltr key="st">{value.quoteState}</Ltr>
                  ),
                ],
                [
                  t('web.payment_rate_quote_id'),
                  value.quoteId === null ? (
                    <Dash key="id" />
                  ) : (
                    <Copyable key="id" value={value.quoteId} />
                  ),
                ],
              ] as [ReactNode, ReactNode][])
            : []),
          [t('web.payment_rate_frozen_at'), formatTimestamp(value.frozenAt)],
        ]}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/**
 * The chips, attention first (roadmap E2): `NEEDS_ACTION` — everything a person must act on,
 * oldest first — leads, then the facets in the contract's own order. A display order only;
 * every queue is the server's predicate.
 */
const QUEUE_ORDER: readonly PaymentOpsQueue[] = [
  'NEEDS_ACTION',
  ...PAYMENT_OPS_QUEUES.filter((one) => one !== 'NEEDS_ACTION'),
];

const QUEUE_LABELS: Readonly<Record<PaymentOpsQueue, WebKey>> = {
  PENDING: 'web.payment_ops_queue_pending',
  UNKNOWN: 'web.payment_ops_queue_unknown',
  NEEDS_RECONCILIATION: 'web.payment_ops_queue_needs_reconciliation',
  MISMATCH: 'web.payment_ops_queue_mismatch',
  PARTIAL: 'web.payment_ops_queue_partial',
  LATE_COMPLETION: 'web.payment_ops_queue_late_completion',
  PROVIDER_ERROR: 'web.payment_ops_queue_provider_error',
  REFUND_RELATED: 'web.payment_ops_queue_refund_related',
  NEEDS_ACTION: 'web.payment_ops_queue_needs_action',
};

const QUEUE_HINTS: Readonly<Record<PaymentOpsQueue, WebKey>> = {
  PENDING: 'web.payment_ops_queue_hint_pending',
  UNKNOWN: 'web.payment_ops_queue_hint_unknown',
  NEEDS_RECONCILIATION: 'web.payment_ops_queue_hint_needs_reconciliation',
  MISMATCH: 'web.payment_ops_queue_hint_mismatch',
  PARTIAL: 'web.payment_ops_queue_hint_partial',
  LATE_COMPLETION: 'web.payment_ops_queue_hint_late_completion',
  PROVIDER_ERROR: 'web.payment_ops_queue_hint_provider_error',
  REFUND_RELATED: 'web.payment_ops_queue_hint_refund_related',
  NEEDS_ACTION: 'web.payment_ops_queue_hint_needs_action',
};

/** The created-at presets the workspace offers; the server resolves each in the tenant calendar. */
const RANGE_LABELS: readonly (readonly [ReportRange, WebKey])[] = [
  ['TODAY', 'web.payment_ops_range_today'],
  ['LAST_7_DAYS', 'web.payment_ops_range_7d'],
  ['LAST_30_DAYS', 'web.payment_ops_range_30d'],
  ['THIS_MONTH', 'web.payment_ops_range_month'],
];
const RANGES: readonly ReportRange[] = RANGE_LABELS.map(([one]) => one);

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

type QueueCounts = PaymentAttentionResponse['totals'];

/**
 * The queue counts a chip shows: the selected route's row, or the totals. A real server
 * count (the chip's rule), from the same predicate the list filters by. A route the server
 * returned no row for has nothing in any queue.
 */
export function queueCountsFor(
  attention: PaymentAttentionResponse | undefined,
  gateway: PaymentGatewayProvider | null,
): QueueCounts | null {
  if (attention === undefined) return null;
  if (gateway === null) return attention.totals;
  const row = attention.byGateway.find((one) => one.gatewayProvider === gateway);
  if (row !== undefined) return row.counts;
  return Object.fromEntries(PAYMENT_OPS_QUEUES.map((queue) => [queue, 0])) as QueueCounts;
}

/** What the gateway side last said, compactly, for a queue row. */
function SignalCell({ row }: { row: PaymentSummaryResponse }) {
  const signal = row.gatewaySignal;
  if (signal === null) return <Dash />;
  const paid = signal.providerPaid === null ? '' : ` · paid=${String(signal.providerPaid)}`;
  return (
    <span className="small">
      {signal.creationState !== 'CREATED' && (
        <>
          <Badge tone={signal.creationState === 'CREATING' ? 'info' : 'warn'}>
            {t('web.payment_ops_signal_create')}{' '}
            <Ltr>
              {signal.creationState}
              {signal.creationErrorCode === null ? '' : ` · ${signal.creationErrorCode}`}
            </Ltr>
          </Badge>{' '}
        </>
      )}
      <Ltr>{`${signal.providerStatus ?? '—'}${paid}`}</Ltr>
      {signal.lastInquiryErrorCode !== null && (
        <>
          {' '}
          <Badge tone="danger">
            {t('web.payment_ops_signal_inquiry_error')} <Ltr>{signal.lastInquiryErrorCode}</Ltr>
          </Badge>
        </>
      )}
      {signal.lateCompletionObservedAt !== null && (
        <>
          {' '}
          <Badge tone="warn">{t('web.payment_ops_queue_late_completion')}</Badge>
        </>
      )}
    </span>
  );
}

/**
 * "Ask the provider again" from a queue row: the SAME command the detail's reconcile card
 * sends (`payments.reconcile`, a database write that brings the next inquiry forward), with
 * an idempotency key held per submission. It decides nothing; the answer is evidence for
 * the reconciliation on the payment's own page.
 */
function ReinquireButton({ paymentId }: { paymentId: string }) {
  const notify = useToast();
  const queries = useQueryClient();
  const asking = useSubmissionKey();
  const reinquire = useMutation({
    mutationFn: () =>
      reinquirePayment({ paymentId, idempotencyKey: asking.current({ id: paymentId }) }),
    onSuccess: (response) => {
      asking.settle();
      notify({
        tone: 'ok',
        message: t(
          response.requested ? 'web.payment_reinquire_done' : 'web.payment_reinquire_recent',
        ),
      });
      void queries.invalidateQueries({ queryKey: ['payments'] });
      void queries.invalidateQueries({ queryKey: ['payment-attention'] });
      void queries.invalidateQueries({ queryKey: ['payment-timeline', paymentId] });
    },
    onError: (error) => {
      asking.settleOn(error);
      notify({ tone: 'danger', message: messageFor(error) });
    },
  });
  return (
    <Button size="sm" disabled={reinquire.isPending} onClick={() => reinquire.mutate()}>
      {t('web.payment_reinquire')}
    </Button>
  );
}

/**
 * The Payment Operations Center (program §10): every payment, every route, with queues for
 * what needs attention. Reached at `/payments`: this list was already the cross-provider
 * one, and a second page would be a second list.
 *
 * A queue is a facet of what has been RECORDED about a payment, never a state: the state
 * column still says where the payment is. The chip counts are the server's, over the same
 * predicate the list filters by. The only command on this page is "ask again" on an
 * UNKNOWN gateway payment (`payments.reconcile`); reconciling and refunding stay on the
 * payment's own page, beside the evidence they rest on. There is no "mark as paid".
 */
export function PaymentsPage({
  route,
  denied,
  mayReconcile = false,
}: {
  route: Route;
  denied: boolean;
  /** `payments.reconcile`: draws the queue rows' "ask again". The server charges it itself. */
  mayReconcile?: boolean;
}) {
  const onLink = useLinkHandler();
  const cursor = route.query.get('cursor');
  const state = route.query.get('state');
  const method = route.query.get('method');
  const disposition = route.query.get('disposition');
  const queue = oneOf(route.query.get('queue'), PAYMENT_OPS_QUEUES);
  const gateway = oneOf(route.query.get('gateway'), PAYMENT_GATEWAY_PROVIDERS);
  const range = oneOf(route.query.get('range'), RANGES);
  /*
   * ONE search box (spec §10), in the URL as `q`: a Telegram id, a reference or bank
   * reference, a gateway's own order / invoice / payment id, a payment / order / customer
   * id, or an `@username`.
   */
  const appliedSearch = appliedListSearch(route);

  const payments = useQuery({
    queryKey: [
      'payments',
      cursor,
      state,
      method,
      disposition,
      appliedSearch,
      queue,
      gateway,
      range,
    ],
    queryFn: () =>
      fetchPayments({
        ...(cursor === null ? {} : { cursor }),
        ...(state === null ? {} : { state: state as PaymentState }),
        ...(method === null ? {} : { method: method as PaymentMethod }),
        ...(disposition === null ? {} : { disposition: disposition as ReceiptDisposition }),
        ...(appliedSearch === '' ? {} : { q: appliedSearch }),
        ...(queue === null ? {} : { queue }),
        ...(gateway === null ? {} : { gateway }),
        ...(range === null ? {} : { range }),
      }),
    enabled: !denied,
  });
  const attention = useQuery({
    queryKey: ['payment-attention', range],
    queryFn: () => fetchPaymentAttention(range === null ? {} : { range }),
    enabled: !denied,
  });
  const counts = queueCountsFor(attention.data, gateway);

  const columns: readonly Column<PaymentSummaryResponse>[] = [
    {
      /*
       * The payment's own id (§21), shortened on the list and copyable whole, because it
       * is what the audit log, the ledger and a support conversation name.
       */
      key: 'id',
      header: t('web.payment_id'),
      render: (row) => <Copyable value={row.id} display={row.id.slice(0, 8)} />,
    },
    {
      key: 'reference',
      header: t('web.payment_reference'),
      render: (row) => (
        <a href={`/payments/${encodeURIComponent(row.id)}`} onClick={onLink} className="strong">
          <Ltr>{paymentTrackingCode(row.reference)}</Ltr>
        </a>
      ),
    },
    {
      key: 'state',
      header: t('web.payment_state'),
      render: (row) => (
        <>
          <StateBadge value={row.state} />
          {inProviderReview(row) && (
            <>
              {' '}
              <Badge tone="info">{t('web.payment_provider_review_badge')}</Badge>
            </>
          )}
        </>
      ),
    },
    {
      // Roadmap E1: the server's situation, beside the state and never instead of it.
      key: 'situation',
      header: t('web.payment_situation_column'),
      render: (row) => <SituationBadge value={row.situation} />,
    },
    {
      /*
       * How the receipt left review, beside the state rather than instead of it: the state
       * is the payment's, this is the receipt's (WP10 follow-up §5).
       */
      key: 'disposition',
      header: t('web.payment_disposition'),
      render: (row) => <DispositionBadge value={row.receiptDisposition} />,
    },
    {
      key: 'method',
      header: t('web.payment_method'),
      render: (row) => t(METHOD_LABELS[row.method]),
    },
    {
      key: 'gateway',
      header: t('web.payment_gateway'),
      render: (row) => <GatewayName provider={row.gatewayProvider} />,
    },
    {
      // What the gateway last said (program §10): the provider's word, never Nexa's state.
      key: 'signal',
      header: t('web.payment_ops_signal'),
      wrap: true,
      render: (row) => <SignalCell row={row} />,
    },
    {
      key: 'amount',
      header: t('web.payment_amount'),
      align: 'end',
      render: (row) => <Money value={{ amountMinor: row.amount, currency: row.currency }} />,
    },
    {
      // Who paid, by their Telegram numeric id (spec §10), as the link.
      key: 'customer',
      header: t('web.payment_customer'),
      render: (row) => (
        <CustomerIdentityLink
          customerId={row.customerId}
          telegramUserId={row.customerTelegramUserId}
          username={row.customerUsername}
          onLink={onLink}
        />
      ),
    },
    {
      key: 'order',
      header: t('web.payment_order'),
      // No order means a WALLET TOP-UP, and saying so is the point.
      render: (row) =>
        row.orderId === null ? (
          <span className="muted small">{t('web.payment_topup')}</span>
        ) : (
          <a href={`/orders/${encodeURIComponent(row.orderId)}`} onClick={onLink}>
            <Ltr>{row.orderId.slice(0, 8)}</Ltr>
          </a>
        ),
    },
    {
      // The customer's own claim: not a state and not evidence.
      key: 'signalled',
      header: t('web.payment_customer_signalled'),
      render: (row) =>
        row.customerSignalledAt === null ? (
          <Dash />
        ) : (
          <span className="nowrap">{formatTimestamp(row.customerSignalledAt)}</span>
        ),
    },
    {
      key: 'external',
      header: t('web.payment_external_reference'),
      render: (row) =>
        row.externalReference === null ? <Dash /> : <Ltr>{row.externalReference}</Ltr>,
    },
    {
      key: 'created',
      header: t('web.payment_created_at'),
      render: (row) => <span className="nowrap">{formatTimestamp(row.createdAt)}</span>,
    },
    {
      key: 'updated',
      header: t('web.payment_updated_at'),
      render: (row) => <span className="nowrap">{formatTimestamp(row.updatedAt)}</span>,
    },
    {
      key: 'actions',
      header: t('web.payment_ops_actions'),
      render: (row) => (
        <span className="nowrap">
          {mayReconcile && row.state === 'UNKNOWN' && row.method === 'GATEWAY' && (
            <>
              <ReinquireButton paymentId={row.id} />{' '}
            </>
          )}
          <a href={`/payments/${encodeURIComponent(row.id)}`} onClick={onLink}>
            {t('web.payment_ops_open')}
          </a>
        </span>
      ),
    },
  ];

  // Hidden while the list cannot answer: a control that mints a new query key is
  // a fresh request against a question the server has just refused.
  const toolbarHidden = !mayRequest(payments, denied);

  return (
    <>
      <PageHead title={t('web.payment_ops_title')} subtitle={t('web.payment_ops_intro')} />

      <Card className="ca-list">
        <ListSearchBox
          route={route}
          id="payments-search"
          // FIX-01: typing or pasting searches by itself, debounced, as on /users.
          autoApply
          hint={t('web.payments_search_hint')}
          hidden={toolbarHidden}
          // A new search starts at the first page: this list keeps its cursor in the URL.
          resetKeys={['cursor']}
        />

        <div hidden={toolbarHidden}>
          <FilterChips label={t('web.payment_ops_queue')}>
            <FilterChip
              pressed={queue === null}
              onClick={() =>
                setQueries(route, [
                  ['queue', null],
                  ['cursor', null],
                ])
              }
            >
              {t('web.payment_ops_queue_all')}
            </FilterChip>
            {QUEUE_ORDER.map((one) => (
              <FilterChip
                key={one}
                pressed={queue === one}
                {...(counts === null ? {} : { count: counts[one] })}
                onClick={() =>
                  setQueries(route, [
                    ['queue', one],
                    ['cursor', null],
                  ])
                }
              >
                {t(QUEUE_LABELS[one])}
              </FilterChip>
            ))}
          </FilterChips>
          {/* The counts' own failure, said beside the chips rather than drawn over the list —
              including a refresh that failed behind counts still on screen. */}
          {(queryState(attention) === 'error' || staleAfterError(attention)) && (
            <p className="muted small">{t('web.payment_ops_counts_error')}</p>
          )}
          {queue !== null && <p className="muted small">{t(QUEUE_HINTS[queue])}</p>}
        </div>

        <div className="filter-row" hidden={toolbarHidden}>
          <ChipGroup
            label={t('web.payment_gateway')}
            value={gateway ?? 'ALL'}
            onChange={(next) =>
              setQueries(route, [
                ['gateway', next === 'ALL' ? null : next],
                ['cursor', null],
              ])
            }
            items={[
              { id: 'ALL', label: t('web.payment_ops_gateway_all') },
              ...PAYMENT_GATEWAY_PROVIDERS.map((one) => ({ id: one, label: gatewayLabel(one) })),
            ]}
          />
          <ChipDivider />
          <ChipGroup
            label={t('web.payment_ops_range')}
            value={range ?? 'ALL'}
            onChange={(next) =>
              setQueries(route, [
                ['range', next === 'ALL' ? null : next],
                ['cursor', null],
              ])
            }
            items={[
              { id: 'ALL', label: t('web.payment_ops_range_all') },
              ...RANGE_LABELS.map(([id, label]) => ({ id, label: t(label) })),
            ]}
          />
        </div>

        <div className="filter-row" hidden={toolbarHidden}>
          <ChipGroup
            label={t('web.payment_state')}
            value={state ?? 'ALL'}
            onChange={(next) =>
              setQueries(route, [
                ['state', next === 'ALL' ? null : next],
                ['cursor', null],
              ])
            }
            items={[
              { id: 'ALL', label: t('web.payments_filter_all') },
              ...PAYMENT_STATES.map((one) => ({ id: one, label: t(STATE_LABELS[one]) })),
            ]}
          />
          <ChipDivider />
          <ChipGroup
            label={t('web.payment_method')}
            value={method ?? 'ALL'}
            onChange={(next) =>
              setQueries(route, [
                ['method', next === 'ALL' ? null : next],
                ['cursor', null],
              ])
            }
            items={[
              { id: 'ALL', label: t('web.payments_filter_all') },
              ...PAYMENT_METHODS.map((one) => ({ id: one, label: t(METHOD_LABELS[one]) })),
            ]}
          />
          <ChipDivider />
          <ChipGroup
            label={t('web.payment_disposition')}
            value={disposition ?? 'ALL'}
            onChange={(next) =>
              setQueries(route, [
                ['disposition', next === 'ALL' ? null : next],
                ['cursor', null],
              ])
            }
            items={[
              { id: 'ALL', label: t('web.payments_filter_all') },
              ...RECEIPT_DISPOSITIONS.map((one) => ({
                id: one,
                label: t(DISPOSITION_LABELS[one]),
              })),
            ]}
          />
        </div>
        <p className="muted small ca-list-note" hidden={toolbarHidden}>
          {t('web.payment_ops_no_force_paid')}
        </p>

        <StateSwitch query={payments} denied={denied}>
          {payments.data === undefined ? null : payments.data.payments.length === 0 ? (
            <Empty title={t('web.payments_empty')} />
          ) : (
            <>
              <DataTable
                caption={t('web.payment_ops_title')}
                columns={columns}
                rows={payments.data.payments}
                rowKey={(row) => row.id}
                dense
                sticky
              />
              {/* An ascending keyset (created_at, id) with the cursor in the URL: default
                  labels, and Previous returns to the first page. */}
              <CursorPager
                shown={payments.data.payments.length}
                hasPrevious={cursor !== null}
                hasNext={payments.data.nextCursor !== null}
                onPrevious={() => setQuery(route, 'cursor', null)}
                onNext={() => setQuery(route, 'cursor', payments.data?.nextCursor ?? null)}
              />
            </>
          )}
        </StateSwitch>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

/**
 * What the customer SENT, and a way to look at it.
 *
 * A receipt is a claim with a file attached. Nothing here confirms a payment — the
 * confirm form below is the only thing that does, and it charges `receipts.review`
 * while this card charges `receipts.view`.
 *
 * The bytes are read through the API rather than from Telegram: the bot token stays in
 * the API process, and the file id a receipt stores is useless without it. The API
 * serves them as `application/octet-stream` with `nosniff` and `attachment`, so the
 * type shown here is decided from what the RECORD says it is and never from the
 * response — a customer's «receipt» that is really an SVG cannot become a script on
 * this origin.
 */
function ReceiptsCard({ paymentId }: { paymentId: string }) {
  const receipts = useQuery({
    queryKey: ['payment-receipts', paymentId],
    queryFn: () => fetchPaymentReceipts(paymentId),
  });
  const rows = receipts.data?.receipts ?? [];

  return (
    <Card title={t('web.payment_receipts')}>
      <StateSwitch
        query={receipts}
        isEmpty={rows.length === 0}
        empty={<Empty variant="compact" title={t('web.payment_receipts_empty')} />}
      >
        <p className="muted small">{t('web.payment_receipts_note')}</p>
        <div className="receipt-list">
          {rows.map((receipt) => (
            <ReceiptRow key={receipt.id} paymentId={paymentId} receipt={receipt} />
          ))}
        </div>
      </StateSwitch>
    </Card>
  );
}

/** One receipt: what it is, when it arrived, and the control that fetches its bytes. */
function ReceiptRow({ paymentId, receipt }: { paymentId: string; receipt: PaymentReceiptView }) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  /*
   * An object URL is a document-lifetime handle, so it is revoked when this row goes
   * away or replaces it. Without this, every open leaks the file until the tab closes.
   */
  useEffect(
    () => () => {
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    },
    [objectUrl],
  );

  /*
   * From the RECORD, never from the response, and for a PHOTO from `kind` ALONE.
   *
   * A photo carries no mime type: Telegram re-encodes it and declares none, so
   * `receiptFileOf` stores null rather than fabricating one. Requiring `image/` here
   * therefore made every real photo a download, and the fixture claiming `image/jpeg`
   * was the only thing that said otherwise.
   *
   * Safe without one because the ELEMENT decides: an `<img>` decodes an image or shows
   * nothing, and a script inside an SVG does not run when the SVG is an `<img>` source.
   * A DOCUMENT is a download whatever it claims to be.
   */
  const renderable = receipt.kind === 'PHOTO';
  /*
   * The Blob carries the record's type when the record has one and NOTHING otherwise —
   * never a type this code invented. An untyped blob in an `<img>` is sniffed by the
   * browser, which is the one place sniffing an image is what should happen.
   */
  const photoType =
    receipt.mimeType !== null && receipt.mimeType.startsWith('image/') ? receipt.mimeType : '';

  const load = useMutation({
    mutationFn: () => fetchPaymentReceiptBytes(paymentId, receipt.id),
    onSuccess: (blob) => {
      setFailed(false);
      setObjectUrl(
        URL.createObjectURL(
          new Blob([blob], {
            type: renderable ? photoType : 'application/octet-stream',
          }),
        ),
      );
    },
    onError: () => setFailed(true),
  });

  const size = receipt.fileSize === null ? null : splitBytes(BigInt(receipt.fileSize));

  return (
    <div className="receipt">
      <KV
        items={[
          [
            t('web.payment_receipt_kind'),
            t(
              receipt.kind === 'PHOTO'
                ? 'web.payment_receipt_kind_photo'
                : 'web.payment_receipt_kind_document',
            ),
          ],
          [
            t('web.payment_receipt_file'),
            receipt.fileName === null ? <Dash key="f" /> : receipt.fileName,
          ],
          [
            t('web.payment_receipt_size'),
            size === null ? <Dash key="s" /> : `${size.value} ${t(size.unit)}`,
          ],
          [t('web.payment_receipt_sent_at'), formatTimestamp(receipt.createdAt)],
        ]}
      />
      <div className="btn-group">
        <Button
          size="sm"
          icon={renderable ? 'eye' : 'download'}
          disabled={load.isPending}
          onClick={() => load.mutate()}
        >
          {t(renderable ? 'web.payment_receipt_view' : 'web.payment_receipt_download')}
        </Button>
      </div>
      {failed && (
        <Banner tone="warn" title={t('web.payment_receipt_failed')}>
          {t('web.payment_receipt_failed_hint')}
        </Banner>
      )}
      {objectUrl !== null &&
        (renderable ? (
          <img className="receipt-image" src={objectUrl} alt={t('web.payment_receipt_alt')} />
        ) : (
          <div className="btn-group">
            {/* The file the operator asked for, named as the customer sent it. */}
            <a className="btn sm" href={objectUrl} download={receipt.fileName ?? receipt.id}>
              {t('web.payment_receipt_save')}
            </a>
          </div>
        ))}
    </div>
  );
}

/**
 * Money going back, and how much of this payment is left to give back.
 *
 * `refundableMinor` is the SERVER's figure, rendered rather than recomputed. This tab
 * holds the rows it was handed and could subtract them, and the number it produced
 * would be a second opinion about money — the one an operator acts on if the two ever
 * disagreed. The server derives it inside a transaction under a lock on the payment,
 * which is also why a stale form here is refused rather than honoured.
 *
 * Two permissions, and they are not the same decision: `refunds.view` reads the history,
 * `refunds.issue` moves money. A reader who may see a refund does not get to make one.
 *
 * A wallet-funded refund arrives COMPLETED, because the ledger IS the wallet and its
 * credit committed in the same transaction. A manual transfer arrives
 * AWAITING_EXTERNAL and STAYS there until an operator says the money left — this
 * installation has no bank API, and a screen that reported otherwise would be the
 * silent success the whole lifecycle exists to refuse.
 */
function RefundsCard({
  paymentId,
  orderId,
  mayIssue,
  mayViewOrders,
}: {
  paymentId: string;
  /** The order this payment settled, or null for a top-up. */
  orderId: string | null;
  mayIssue: boolean;
  /** `orders.view`: whether the order's own state may be read to say it is REFUNDED. */
  mayViewOrders: boolean;
}) {
  const onLink = useLinkHandler();
  const notify = useToast();
  const queries = useQueryClient();
  const request = useSubmissionKey();
  const completion = useSubmissionKey();
  const abandonment = useSubmissionKey();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  /** Which AWAITING_EXTERNAL refund the operator is answering, and with what. */
  const [answering, setAnswering] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [externalReference, setExternalReference] = useState('');

  const refunds = useQuery({
    queryKey: ['refunds', paymentId],
    queryFn: () => fetchRefunds(paymentId),
  });
  const data = refunds.data;
  const rows = data?.refunds ?? [];

  /*
   * The ORDER, read rather than inferred (WP10 P3).
   *
   * A refund whose completed total reaches the payment moves the order PAID -> REFUNDED in
   * the same transaction. Whether that happened is the order's own state, and this reads
   * it — summing the rows above to decide it would be this tab's second opinion about
   * money, and it would be wrong for an order the automatic lane refunded. Without
   * `orders.view` nothing is said about the order at all.
   */
  const order = useQuery({
    queryKey: ['order', orderId],
    queryFn: () => fetchOrder(orderId ?? ''),
    enabled: mayViewOrders && orderId !== null,
  });
  const orderRefunded = order.data?.order.state === 'REFUNDED';

  const refresh = (response: RefundResponse) => {
    void response;
    void queries.invalidateQueries({ queryKey: ['refunds', paymentId] });
    /*
     * The WALLET too, and not only on the wallet channel.
     *
     * A wallet refund appends a ledger entry in the same transaction, so a balance
     * rendered from a cached query would be behind by exactly the amount just returned.
     * Invalidating unconditionally is cheaper than deciding per channel and cannot be
     * wrong in the direction that matters.
     */
    void queries.invalidateQueries({ queryKey: ['wallet'] });
    /*
     * And the ORDER: the refund that completes the payment moves it to REFUNDED in the
     * same transaction (WP10 P3), so a cached order would still say PAID.
     */
    void queries.invalidateQueries({ queryKey: ['order'] });
    void queries.invalidateQueries({ queryKey: ['orders'] });
    /*
     * And the payment's HISTORY, drawn on this same page: the refund just recorded is a
     * row in it, and a cached timeline would omit what the operator just did.
     */
    void queries.invalidateQueries({ queryKey: ['payment-timeline', paymentId] });
  };

  /*
   * After ANY error from the three refund commands. A refusal means the figures here were
   * stale, and a 5xx or a lost response may have committed, so the ledger is read again,
   * and so is the history beside it: a refund that committed behind a 5xx is a row there
   * too, and the refund card would otherwise show one the history omits (Codex review of
   * #81).
   */
  const rereadAfterError = () => {
    void queries.invalidateQueries({ queryKey: ['refunds', paymentId] });
    void queries.invalidateQueries({ queryKey: ['payment-timeline', paymentId] });
  };

  const issue = useMutation({
    mutationFn: () =>
      requestRefund({
        paymentId,
        // Bound to the amount AND the reason, so an edited figure is a new command
        // rather than a replay the store refuses as a payload mismatch.
        idempotencyKey: request.current({ paymentId, amount, reason }),
        amountMinor: digitsOf(amount),
        reason: reason.trim(),
      }),
    onSuccess: (response) => {
      request.settle();
      notify({ tone: 'ok', message: t('web.refund_requested') });
      setAmount('');
      setReason('');
      refresh(response);
    },
    /*
     * A 5xx may have committed. A fresh key on the retry would be a SECOND refund of
     * somebody's money — the one failure mode on this card that cannot be undone.
     */
    onError: (error) => {
      request.settleOn(error);
      /*
       * A refusal means the figures on this card were stale — the delivery started, or
       * another operator refunded — so they are re-read, and `refundable` becomes the
       * server's answer again rather than the one the form was drawn from.
       */
      rereadAfterError();
    },
  });

  const complete = useMutation({
    mutationFn: () => {
      if (answering === null) throw new Error('no refund is being answered');
      return completeRefund({
        refundId: answering,
        idempotencyKey: completion.current({ answering, note, externalReference }),
        note: note.trim(),
        externalReference: externalReference.trim() === '' ? null : externalReference.trim(),
      });
    },
    onSuccess: (response) => {
      completion.settle();
      notify({ tone: 'ok', message: t('web.refund_completed') });
      setAnswering(null);
      setNote('');
      setExternalReference('');
      refresh(response);
    },
    // A 5xx or a lost response may have committed, as on `issue` above.
    onError: (error) => {
      completion.settleOn(error);
      rereadAfterError();
    },
  });

  const abandon = useMutation({
    mutationFn: () => {
      if (answering === null) throw new Error('no refund is being answered');
      return failRefund({
        refundId: answering,
        idempotencyKey: abandonment.current({ answering, note }),
        note: note.trim(),
      });
    },
    onSuccess: (response) => {
      abandonment.settle();
      notify({ tone: 'ok', message: t('web.refund_failed_done') });
      setAnswering(null);
      setNote('');
      setExternalReference('');
      refresh(response);
    },
    onError: (error) => {
      abandonment.settleOn(error);
      rereadAfterError();
    },
  });

  const currency = data?.currency ?? 'IRT';
  const remaining = data === undefined ? 0n : BigInt(data.refundableMinor);
  const awaiting = rows.filter((row) => row.state === 'AWAITING_EXTERNAL');
  /*
   * Whether each form is ON SCREEN, decided once and used both to draw it and to
   * guard it (Codex review on PR #125). A refusal re-reads the ledger, and the
   * answer can take a form away — `refundable: false`, or the refund being answered
   * no longer AWAITING_EXTERNAL — while its typed strings stay in state. Guarded on
   * the strings alone, the page then asked "discard your changes?" about a form the
   * operator could no longer see. The strings are kept, not cleared: if the form
   * comes back, so does what was typed, and the guard with it.
   */
  const issueFormShown = data !== undefined && data.refundable && remaining > 0n && mayIssue;
  const answerFormShown =
    mayIssue && answering !== null && awaiting.some((row) => row.id === answering);

  // A typed refund or answer is lost by navigating away; the guard asks first.
  useUnsavedChanges(
    (issueFormShown && (amount.trim() !== '' || reason.trim() !== '')) ||
      (answerFormShown && (note.trim() !== '' || externalReference.trim() !== '')),
  );

  const columns: readonly Column<RefundView>[] = [
    {
      key: 'amount',
      header: t('web.refund_amount'),
      render: (row) => <Money value={{ amountMinor: row.amountMinor, currency: row.currency }} />,
    },
    {
      key: 'state',
      header: t('web.refund_state'),
      render: (row) => (
        <Badge tone={REFUND_STATE_TONES[row.state]} dot>
          {t(REFUND_STATE_LABELS[row.state])}
        </Badge>
      ),
    },
    {
      key: 'channel',
      header: t('web.refund_channel'),
      render: (row) => t(REFUND_CHANNEL_LABELS[row.channel]),
    },
    { key: 'reason', header: t('web.refund_reason'), wrap: true, render: (row) => row.reason },
    {
      key: 'requested',
      header: t('web.refund_requested_by'),
      render: (row) =>
        row.requestedByAdminId === null ? <Dash /> : <Copyable value={row.requestedByAdminId} />,
    },
    {
      key: 'completed',
      header: t('web.refund_completed_by'),
      render: (row) =>
        // A SENTENCE for the one state where the absence is the point: nobody has said
        // the money left yet, which is a different fact from a missing value.
        row.state === 'AWAITING_EXTERNAL' ? (
          <span className="muted small">{t('web.refund_awaiting_hint')}</span>
        ) : row.completedByAdminId === null ? (
          <Dash />
        ) : (
          <Copyable value={row.completedByAdminId} />
        ),
    },
    {
      key: 'createdAt',
      header: t('web.refund_created_at'),
      render: (row) => <span className="nowrap">{formatTimestamp(row.createdAt)}</span>,
    },
    {
      key: 'completedAt',
      header: t('web.refund_completed_at'),
      render: (row) => (row.completedAt === null ? <Dash /> : formatTimestamp(row.completedAt)),
    },
    {
      key: 'externalReference',
      header: t('web.refund_external_reference'),
      render: (row) =>
        row.externalReference === null ? <Dash /> : <Ltr>{row.externalReference}</Ltr>,
    },
  ];

  return (
    <Card title={t('web.refunds')}>
      <StateSwitch query={refunds}>
        {data === undefined ? null : (
          <>
            <KV
              inline
              items={[
                [
                  t('web.refund_paid'),
                  <Money key="p" value={{ amountMinor: data.paidMinor, currency }} />,
                ],
                [
                  t('web.refund_consumed'),
                  <Money key="c" value={{ amountMinor: data.consumedMinor, currency }} />,
                ],
                [
                  t('web.refund_remaining'),
                  <Money key="r" value={{ amountMinor: data.refundableMinor, currency }} />,
                ],
              ]}
            />

            {/*
              NOT refundable at all is a different statement from nothing left, and the
              two get different sentences. A payment that never settled has no money to
              return; a GATEWAY payment has no channel in this release, and a screen
              that offered a button for it would promise a reversal nobody can perform.
            */}
            {!data.refundable && (
              <Banner tone="info">
                {t(
                  data.refusalReason === null
                    ? 'web.refund_unavailable'
                    : REFUND_REFUSAL_TEXT[data.refusalReason],
                )}
              </Banner>
            )}

            {/*
              What a full refund did and did NOT do (WP10 P3). The order's state is the
              server's; the sentence about the service is the design — a refund never
              suspends or terminates one, and the operator's own service action is the
              way to do either. Linked to the order, which is where its service is shown.
            */}
            {orderRefunded && orderId !== null && (
              <Banner tone="info" title={t('web.refund_order_refunded_title')}>
                <p>{t('web.refund_order_refunded_body')}</p>
                <a href={`/orders/${encodeURIComponent(orderId)}`} onClick={onLink}>
                  {t('web.refund_order_link')}
                </a>
              </Banner>
            )}

            {rows.length === 0 ? (
              <Empty variant="compact" title={t('web.refunds_empty')} />
            ) : (
              <DataTable
                columns={columns}
                rows={rows}
                rowKey={(row) => row.id}
                caption={t('web.refunds')}
                dense
              />
            )}

            {data.refundable && remaining > 0n && (
              <div className="ca-decision-part">
                <h3 className="ca-subhead">{t('web.refund_request_title')}</h3>
                <p className="muted small">{t('web.refund_request_hint')}</p>
                {mayIssue ? (
                  <>
                    <div className="form-grid">
                      <Field label={t('web.refund_amount_minor')} htmlFor="refund-amount">
                        <span className="ca-inline-control">
                          <Input
                            id="refund-amount"
                            size="sm"
                            dir="ltr"
                            value={amount}
                            inputMode="numeric"
                            maxLength={19}
                            onChange={(event) => setAmount(event.target.value)}
                          />
                          {/* The server's own remaining figure, not one computed here. */}
                          <Button size="sm" onClick={() => setAmount(data.refundableMinor)}>
                            {t('web.refund_amount_all')}
                          </Button>
                        </span>
                      </Field>
                      <Field label={t('web.refund_reason')} htmlFor="refund-reason">
                        <Input
                          id="refund-reason"
                          size="sm"
                          value={reason}
                          maxLength={500}
                          onChange={(event) => setReason(event.target.value)}
                        />
                      </Field>
                    </div>
                    <div className="form-actions">
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={
                          issue.isPending || digitsOf(amount) === '0' || reason.trim().length < 3
                        }
                        onClick={() => issue.mutate()}
                      >
                        {t('web.refund_request')}
                      </Button>
                    </div>
                  </>
                ) : (
                  // No disabled button: a disabled control and this sentence make the
                  // same claim, and only one of them names the permission.
                  <Banner tone="info">{t('web.refund_denied')}</Banner>
                )}
              </div>
            )}

            {/*
              OUTSIDE the form, on purpose. A refusal re-reads the ledger, and for
              DELIVERY_IN_PROGRESS the server then answers `refundable: false` — which
              hides the form. A banner inside it would vanish with it, taking the one
              sentence that said why.
            */}
            {issue.error !== null && <Banner tone="danger">{refundMessageFor(issue.error)}</Banner>}

            {/*
              The manual channel's second step, and the reason `AWAITING_EXTERNAL`
              exists. An operator says the money left, or says it never will — and
              saying the second RELEASES the amount back to the refundable balance
              rather than deleting the evidence, which is the over-refund achieved by
              destroying the record.
            */}
            {mayIssue && awaiting.length > 0 && (
              <div className="ca-decision-part ca-decision-approve">
                <h3 className="ca-subhead">{t('web.refund_answer_title')}</h3>
                <p className="muted small">{t('web.refund_answer_hint')}</p>
                <Field label={t('web.refund_answer_which')} htmlFor="refund-answering">
                  <select
                    id="refund-answering"
                    value={answering ?? ''}
                    onChange={(event) =>
                      setAnswering(event.target.value === '' ? null : event.target.value)
                    }
                  >
                    <option value="">{t('web.refund_answer_none')}</option>
                    {awaiting.map((row) => (
                      <option key={row.id} value={row.id}>
                        {`${formatMoneyText({ amountMinor: row.amountMinor, currency: row.currency })} — ${row.id}`}
                      </option>
                    ))}
                  </select>
                </Field>
                {answerFormShown && (
                  <>
                    <div className="form-grid">
                      <Field label={t('web.refund_answer_note')} htmlFor="refund-note">
                        <Input
                          id="refund-note"
                          size="sm"
                          value={note}
                          maxLength={500}
                          onChange={(event) => setNote(event.target.value)}
                        />
                      </Field>
                      <Field
                        label={t('web.refund_external_reference')}
                        htmlFor="refund-external-reference"
                      >
                        <Input
                          id="refund-external-reference"
                          size="sm"
                          dir="ltr"
                          value={externalReference}
                          maxLength={140}
                          onChange={(event) => setExternalReference(event.target.value)}
                        />
                      </Field>
                    </div>
                    <div className="form-actions">
                      <button
                        type="button"
                        className="btn primary sm"
                        /*
                         * Either answer in flight disables BOTH, for the reason the
                         * confirm/reject pair carries: the two commands race one row
                         * with different keys, and the operator gets whichever the
                         * database serves second. Neither can be undone.
                         */
                        disabled={complete.isPending || abandon.isPending || note.trim().length < 3}
                        onClick={() => complete.mutate()}
                      >
                        {t('web.refund_complete')}
                      </button>
                      <button
                        type="button"
                        className="btn danger sm"
                        disabled={complete.isPending || abandon.isPending || note.trim().length < 3}
                        onClick={() => abandon.mutate()}
                      >
                        {t('web.refund_abandon')}
                      </button>
                    </div>
                    {complete.error !== null && (
                      <Banner tone="danger">{refundMessageFor(complete.error)}</Banner>
                    )}
                    {abandon.error !== null && (
                      <Banner tone="danger">{messageFor(abandon.error)}</Banner>
                    )}
                  </>
                )}
              </div>
            )}
          </>
        )}
      </StateSwitch>
    </Card>
  );
}

export function PaymentDetailPage({
  id,
  mayViewReceipts,
  mayViewRefunds,
  mayIssueRefunds,
  mayViewOrders = false,
  mayViewWallet = false,
  mayViewAudit = false,
  mayReconcile = false,
  denied,
}: {
  id: string;
  /** `receipts.view`: reading evidence. Deciding it is Telegram's (Payment File 02 §10). */
  mayViewReceipts: boolean;
  /** `refunds.view`. Reading a refund history is not the same right as making one. */
  mayViewRefunds: boolean;
  /** `refunds.issue`. The CRITICAL half: it moves money. */
  mayIssueRefunds: boolean;
  /**
   * `orders.view`, for the one sentence the refund card says about the ORDER after a
   * full refund. Optional and false by default: without it the card says nothing about
   * an order it may not read.
   */
  mayViewOrders?: boolean;
  /**
   * `users.view`, the key the history's wallet section sits behind. Never used to draw or
   * hide anything here — the server decides what is withheld — only to make a change in it
   * a new question for the history card.
   */
  mayViewWallet?: boolean;
  /**
   * `audit.view` (`orders.view` is `mayViewOrders`): the history's AUDIT and ORDER sections
   * are decided by the server; these only make a change in either a new question for it.
   */
  mayViewAudit?: boolean;
  /**
   * `payments.reconcile`: resolving an `UNKNOWN` gateway payment from the provider's
   * recorded answer. The server charges it itself; this only decides whether the controls
   * are drawn, and without it the card names the permission instead.
   */
  mayReconcile?: boolean;
  denied: boolean;
}) {
  const onLink = useLinkHandler();
  const timelineSections = [
    mayViewReceipts ? 'receipts' : '',
    mayViewRefunds ? 'refunds' : '',
    mayViewWallet ? 'wallet' : '',
    mayViewOrders ? 'order' : '',
    mayViewAudit ? 'audit' : '',
  ].join(',');
  const payment = useQuery({
    queryKey: ['payment', id],
    queryFn: () => fetchPayment(id),
    enabled: !denied,
  });
  const row = payment.data?.payment;

  return (
    <>
      {row === undefined ? (
        <PageHead title={t('web.payment_detail')} />
      ) : (
        <PageHead
          title={
            <span className="ca-title-id">
              <Ltr>{paymentTrackingCode(row.reference)}</Ltr>
              <CopyButton value={paymentTrackingCode(row.reference)} />
            </span>
          }
          badge={<StateBadge value={row.state} />}
          subtitle={t(METHOD_LABELS[row.method])}
        />
      )}

      <StateSwitch query={payment} denied={denied}>
        {row === undefined ? null : (
          <>
            {row.state === 'UNKNOWN' && (
              <Banner tone="warn">{t('web.payment_unknown_banner')}</Banner>
            )}
            {inProviderReview(row) && row.providerReviewUntil !== null && (
              <Banner tone="info">
                {t('web.payment_provider_review_banner')}{' '}
                <strong>{formatTimestamp(row.providerReviewUntil)}</strong>
              </Banner>
            )}
            <TwoColumn
              main={
                <>
                  <SituationCard value={row.situation} />
                  <Card title={t('web.payment_detail')}>
                    <KV
                      items={[
                        [t('web.payment_id'), <Copyable key="id" value={row.id} />],
                        [
                          t('web.payment_disposition'),
                          <DispositionBadge key="d" value={row.receiptDisposition} />,
                        ],
                        [
                          t('web.payment_gateway'),
                          <GatewayName key="g" provider={row.gatewayProvider} />,
                        ],
                        [
                          t('web.payment_amount'),
                          <Money
                            key="a"
                            value={{ amountMinor: row.amount, currency: row.currency }}
                          />,
                        ],
                        [
                          t('web.payment_customer'),
                          <a
                            key="c"
                            href={`/users/${encodeURIComponent(row.customerId)}`}
                            onClick={onLink}
                          >
                            <Ltr>{row.customerId}</Ltr>
                          </a>,
                        ],
                        [
                          t('web.payment_telegram'),
                          <TelegramIdentity
                            key="tg"
                            telegramUserId={row.customerTelegramUserId}
                            username={row.customerUsername}
                          />,
                        ],
                        [
                          t('web.payment_order'),
                          row.orderId === null ? (
                            // A top-up, named rather than dashed. See the list column.
                            <span key="o" className="muted small">
                              {t('web.payment_topup')}
                            </span>
                          ) : (
                            <a
                              key="o"
                              href={`/orders/${encodeURIComponent(row.orderId)}`}
                              onClick={onLink}
                            >
                              <Ltr>{row.orderId}</Ltr>
                            </a>
                          ),
                        ],
                        [
                          t('web.payment_external_reference'),
                          row.externalReference === null ? (
                            <Dash key="x" />
                          ) : (
                            <Copyable key="x" value={row.externalReference} />
                          ),
                        ],
                        [t('web.payment_created_at'), formatTimestamp(row.createdAt)],
                        [t('web.payment_updated_at'), formatTimestamp(row.updatedAt)],
                        [
                          t('web.payment_expires_at'),
                          row.expiresAt === null ? (
                            <Dash key="e" />
                          ) : (
                            formatTimestamp(row.expiresAt)
                          ),
                        ],
                        [
                          t('web.payment_customer_signalled'),
                          row.customerSignalledAt === null ? (
                            // A SENTENCE, not a dash. "The customer has said nothing" is the
                            // answer here rather than a missing value, and it is the half of
                            // the picture a reviewer weighs before opening their bank.
                            <span key="cs" className="muted small">
                              {t('web.payment_customer_signalled_none')}
                            </span>
                          ) : (
                            formatTimestamp(row.customerSignalledAt)
                          ),
                        ],
                      ]}
                    />
                    {row.customerSignalledAt !== null && (
                      <p className="muted small">{t('web.payment_customer_signalled_hint')}</p>
                    )}
                  </Card>
                  {/*
              What a confirmation RESTS on, and who made it.
              `UNK-PR-010` records the legacy receipt review as storing neither the
              reviewer nor the time, which is why "was this approved by a human" is
              unanswerable there. Both are columns here, and both are shown.
            */}
                  <Card title={t('web.payment_evidence_kind')}>
                    <KV
                      items={[
                        [
                          t('web.payment_evidence_kind'),
                          row.evidenceKind === null ? <Dash key="k" /> : row.evidenceKind,
                        ],
                        [
                          t('web.payment_evidence_note'),
                          row.evidenceNote === null ? <Dash key="n" /> : row.evidenceNote,
                        ],
                        [
                          t('web.payment_reviewer'),
                          row.confirmedByAdminId === null ? (
                            <Dash key="w" />
                          ) : (
                            <Copyable key="w" value={row.confirmedByAdminId} />
                          ),
                        ],
                        [
                          t('web.payment_confirmed_at'),
                          row.confirmedAt === null ? (
                            <Dash key="t" />
                          ) : (
                            formatTimestamp(row.confirmedAt)
                          ),
                        ],
                      ]}
                    />
                  </Card>
                  {/*
              How it ended WITHOUT money, when it did.
              Its own card rather than three more rows in the evidence one, because
              the two are mutually exclusive by constraint — `payments_confirmed_check`
              and `payments_resolved_check` are both equalities — and a screen showing
              both sets side by side invites reading a rejection as an approval.
            */}
                  {row.resolvedAt !== null && (
                    <Card title={t('web.payment_resolution')}>
                      <KV
                        items={[
                          [t('web.payment_resolved_at'), formatTimestamp(row.resolvedAt)],
                          [
                            t('web.payment_resolver'),
                            row.resolvedByAdminId === null ? (
                              // Null is the ANSWER, not a missing value: nobody decided an
                              // expiry and a withdrawal is the customer's own.
                              <Dash key="rw" />
                            ) : (
                              <Copyable key="rw" value={row.resolvedByAdminId} />
                            ),
                          ],
                          [
                            t('web.payment_resolution_note'),
                            row.resolutionNote === null ? <Dash key="rn" /> : row.resolutionNote,
                          ],
                        ]}
                      />
                    </Card>
                  )}
                  {/*
              The receipt's credit-to-wallet disposition, when that is how it was decided
              (Payment File 02 §12, D2). READ-ONLY: it was decided in Telegram, and this
              page shows what, by whom and when — never a control to make or undo one.
              The amount is the reviewer's, which may differ from the payment's own; that
              difference is the reason the disposition exists.
            */}
                  {row.receiptCredit !== null && (
                    <Card title={t('web.payment_receipt_credit')}>
                      <KV
                        items={[
                          [
                            t('web.payment_receipt_credit_amount'),
                            <Money
                              key="ca"
                              value={{
                                amountMinor: row.receiptCredit.amountMinor,
                                currency: row.receiptCredit.currency,
                              }}
                            />,
                          ],
                          [
                            t('web.payment_receipt_credit_admin'),
                            <Copyable key="cw" value={row.receiptCredit.decidedByAdminId} />,
                          ],
                          [
                            t('web.payment_receipt_credit_at'),
                            formatTimestamp(row.receiptCredit.decidedAt),
                          ],
                          [
                            t('web.payment_receipt_credit_note'),
                            row.receiptCredit.note === null ? (
                              <Dash key="cn" />
                            ) : (
                              row.receiptCredit.note
                            ),
                          ],
                        ]}
                      />
                      <p className="muted small">{t('web.payment_receipt_credit_hint')}</p>
                    </Card>
                  )}
                  {/*
                    The payment's money, the gateway fee (WP18) included, as the server
                    computed it: ONE card, so the fee is never shown twice (review of PR #247).
                  */}
                  <AmountsCard value={row.amounts} />
                  <RateProvenanceCard value={row.gatewayInvoice?.rateProvenance ?? null} />
                  {/*
              The external gateway's side of this payment (WP11A): the provider's ids,
              what its INQUIRY last said, what its webhook last hinted and how the
              attempt ended. The provider's amounts are metadata only — the payment's own
              amount above is what Nexa charged — and no payment link is shown.
            */}
                  {row.gatewayInvoice !== null && (
                    <Card
                      title={t('web.payment_gateway_invoice')}
                      hint={t('web.payment_gateway_invoice_hint')}
                    >
                      <Disclosure size="sm" summary={t('web.payment_tech_details')}>
                        <KV
                          items={[
                            [
                              t('web.payment_gateway_invoice_order_id'),
                              <Copyable key="po" value={row.gatewayInvoice.providerOrderId} />,
                            ],
                            [
                              t('web.payment_gateway_invoice_id'),
                              row.gatewayInvoice.providerInvoiceId === null ? (
                                <Dash key="pi" />
                              ) : (
                                <Copyable key="pi" value={row.gatewayInvoice.providerInvoiceId} />
                              ),
                            ],
                            /*
                             * The provider's own id for the CHARGE (Telegram Stars'
                             * `telegram_payment_charge_id`): what an operator reconciles or refunds by,
                             * so it is shown and copyable (Codex review of #85). Absent for a route
                             * that has none, rather than a dash that suggests one is missing.
                             */
                            ...(row.gatewayInvoice.providerChargeId === null
                              ? []
                              : [
                                  [
                                    t('web.payment_gateway_charge_id'),
                                    <Copyable
                                      key="pc"
                                      value={row.gatewayInvoice.providerChargeId}
                                    />,
                                  ] as [ReactNode, ReactNode],
                                ]),
                            /*
                             * NOWPayments: the provider payment a verified IPN (or the invoice's
                             * payment list) last named — what the next status read follows, and
                             * what an operator looks up in the NOWPayments dashboard.
                             */
                            ...(row.gatewayInvoice.hintedPaymentId === null
                              ? []
                              : [
                                  [
                                    t('web.payment_gateway_provider_payment_id'),
                                    <Copyable
                                      key="pp"
                                      value={row.gatewayInvoice.hintedPaymentId}
                                    />,
                                  ] as [ReactNode, ReactNode],
                                ]),
                            /*
                             * CentralPay: the integer the gateway knows this customer by —
                             * what an operator matches against CentralPay's own records.
                             */
                            ...(row.gatewayInvoice.providerUserId === null
                              ? []
                              : [
                                  [
                                    t('web.payment_gateway_provider_user_id'),
                                    <Copyable key="pu" value={row.gatewayInvoice.providerUserId} />,
                                  ] as [ReactNode, ReactNode],
                                ]),
                            [
                              t('web.payment_gateway_invoice_creation'),
                              <Ltr key="cs">
                                {row.gatewayInvoice.creationState}
                                {row.gatewayInvoice.creationErrorCode === null
                                  ? ''
                                  : ` · ${row.gatewayInvoice.creationErrorCode}`}
                              </Ltr>,
                            ],
                            [
                              t('web.payment_gateway_invoice_status'),
                              <Ltr key="st">
                                {row.gatewayInvoice.providerStatus ?? '—'}
                                {row.gatewayInvoice.providerPaid === null
                                  ? ''
                                  : ` · paid=${String(row.gatewayInvoice.providerPaid)}`}
                              </Ltr>,
                            ],
                            [
                              t('web.payment_gateway_invoice_last_inquiry'),
                              row.gatewayInvoice.lastInquiryAt === null ? (
                                <Dash key="li" />
                              ) : (
                                <span key="li">
                                  {formatTimestamp(row.gatewayInvoice.lastInquiryAt)}
                                  {row.gatewayInvoice.lastInquiryErrorCode === null ? null : (
                                    <>
                                      {' '}
                                      <Ltr>{row.gatewayInvoice.lastInquiryErrorCode}</Ltr>
                                    </>
                                  )}
                                </span>
                              ),
                            ],
                            [
                              t('web.payment_gateway_invoice_webhook'),
                              <span key="wh">
                                <Ltr>{row.gatewayInvoice.webhookStatusHint ?? '—'}</Ltr>
                                {` · ${String(row.gatewayInvoice.webhookCount)}`}
                              </span>,
                            ],
                            [
                              t('web.payment_gateway_invoice_amounts'),
                              <Ltr key="am">
                                {`${row.gatewayInvoice.sentAmount} / ${row.gatewayInvoice.requestAmount ?? '—'} / ${row.gatewayInvoice.finalAmount ?? '—'} / ${row.gatewayInvoice.creditAmount ?? '—'} ${row.gatewayInvoice.providerUnit}`}
                              </Ltr>,
                            ],
                            /*
                             * Package FX: how the provider figure was derived, and — for the central
                             * rate — the snapshot it was derived from: the quote, its source and
                             * times, the ratio and the effective figure per unit. Read from the
                             * invoice row, never recomputed from today's rate.
                             */
                            [
                              t('web.payment_gateway_invoice_policy'),
                              t(CONVERSION_POLICY_LABELS[row.gatewayInvoice.conversionPolicy]),
                            ],
                            ...(row.gatewayInvoice.fx === null
                              ? []
                              : [
                                  [
                                    t('web.payment_gateway_invoice_fx'),
                                    <Ltr key="fx">
                                      {`${row.gatewayInvoice.fx.rate} ${row.gatewayInvoice.fx.quoteCurrency}/${row.gatewayInvoice.fx.baseAsset} · ${row.gatewayInvoice.fx.source} · ${row.gatewayInvoice.fx.quoteState} · ${formatTimestamp(row.gatewayInvoice.fx.fetchedAt)} · ×${row.gatewayInvoice.fx.unitRatio} → ${row.gatewayInvoice.fx.effectiveRate} ${row.gatewayInvoice.fx.quoteCurrency}/${row.gatewayInvoice.providerUnit} · v${String(row.gatewayInvoice.fx.policyVersion)}`}
                                    </Ltr>,
                                  ] as [ReactNode, ReactNode],
                                ]),
                            [
                              t('web.payment_gateway_invoice_outcome'),
                              <Ltr key="oc">{row.gatewayInvoice.outcome ?? '—'}</Ltr>,
                            ],
                            [
                              t('web.payment_gateway_invoice_late'),
                              row.gatewayInvoice.lateCompletionObservedAt === null ? (
                                <Dash key="lt" />
                              ) : (
                                <Badge key="lt" tone="warn">
                                  {formatTimestamp(row.gatewayInvoice.lateCompletionObservedAt)}
                                </Badge>
                              ),
                            ],
                            ...reviewFacts(row),
                            ...cardTransferFacts(row.gatewayInvoice),
                          ]}
                        />
                      </Disclosure>
                    </Card>
                  )}
                </>
              }
              side={
                <>
                  {/*
              An UNKNOWN gateway payment (TonPays Telegram §9.6.4): resolved from the
              provider's RECORDED answer, never from the operator's choice.
            */}
                  {row.state === 'UNKNOWN' && row.method === 'GATEWAY' && (
                    <ReconcileCard payment={row} mayReconcile={mayReconcile} />
                  )}
                  {/*
              Card-to-card review is Telegram's alone (Payment File 02 §10, D3): approve,
              reject and credit-to-wallet are decided there, and this page shows what was
              decided and offers none of them. A PENDING transfer says where to go
              rather than drawing a control the server has no route for.
            */}
                  {row.state === 'PENDING' && row.method === 'MANUAL_TRANSFER' && (
                    <Card title={t('web.payment_confirm_title')}>
                      <p className="muted">{t('web.payment_review_in_telegram')}</p>
                    </Card>
                  )}
                  {/*
              WHERE the customer was told to send it.
              Its own card because it is neither the payment nor the evidence: it is
              what the instructions SAID, frozen when the reference was issued, so it
              still answers "which account should this have arrived in" after the
              account has been renamed, edited or disabled. That is the reconciliation
              question, and until this card existed no operator screen could answer it.

              Absent for a wallet settlement and for a manual transfer issued before
              5A — both of which genuinely have no destination, which is why the card
              is hidden rather than filled with dashes.

              Four digits, never sixteen. `paymentDestinationViewSchema` is what stops
              the rest reaching this bundle at all.
            */}
                  {row.destination !== null && (
                    <Card title={t('web.payment_destination')}>
                      <KV
                        items={[
                          [t('web.payment_destination_label'), row.destination.label],
                          [t('web.payment_destination_bank'), row.destination.bankName],
                          [t('web.payment_destination_holder'), row.destination.holderName],
                          [
                            t('web.payment_destination_card'),
                            <Ltr key="dc">{`\u2022\u2022\u2022\u2022 ${row.destination.cardLast4}`}</Ltr>,
                          ],
                          [
                            t('web.payment_destination_sheba'),
                            t(
                              row.destination.hasIban
                                ? 'web.payment_destination_sheba_given'
                                : 'web.payment_destination_sheba_absent',
                            ),
                          ],
                          [
                            t('web.payment_destination_account'),
                            <Copyable key="da" value={row.destination.accountId} />,
                          ],
                        ]}
                      />
                    </Card>
                  )}
                  {/*
              The top-up gift this payment promised (Payment File 02 §17, D5): the
              percentage SNAPSHOTTED from its route when it was created. Null for anything
              that is not a top-up, which is why the card is absent rather than dashed.
            */}
                  {row.topupCashbackPercent !== null && (
                    <Card title={t('web.payment_topup_gift')}>
                      <p className="strong">
                        <Num value={`${String(row.topupCashbackPercent)}%`} />
                      </p>
                      <p className="muted small">{t('web.payment_topup_gift_hint')}</p>
                    </Card>
                  )}
                  {/*
              What the customer sent, when they sent anything.
              Its own card and its own permission: `receipts.view` reads the evidence,
              `receipts.review` decides. A reader who may see a payment does not
              automatically get to open a customer's bank screenshot.
            */}
                  {mayViewReceipts && <ReceiptsCard paymentId={id} />}
                </>
              }
            />
            {/*
              Money going BACK, under its own two permissions.
              Placed after the evidence and before the decision forms, because that is
              the order an operator reads in: what arrived, what was sent back, and only
              then what is left to decide. Hidden entirely without `refunds.view` — a
              refund history is financial evidence about a customer.
            */}
            {mayViewRefunds && (
              <RefundsCard
                paymentId={id}
                orderId={row.orderId}
                mayIssue={mayIssueRefunds}
                mayViewOrders={mayViewOrders}
              />
            )}
            {/*
              What has happened to this payment, in order (WP17). Read-only, and its own
              request: the server decides which sections this viewer may see and names the
              ones it withheld, so the card never guesses from the permissions it was given.
              It is handed the state this page read, and reads whichever side is older again
              when the two disagree.
            */}
            <PaymentTimelineCard
              paymentId={id}
              paymentState={row.state}
              signalled={row.customerSignalledAt !== null}
              sections={timelineSections}
            />
            <Card tone="muted">
              <p className="muted small">{t('web.payment_not_settled_here')}</p>
            </Card>
          </>
        )}
      </StateSwitch>
    </>
  );
}

type PaymentDetail = PaymentDetailResponse;
type GatewayInvoiceDetail = NonNullable<PaymentDetail['gatewayInvoice']>;

/** When the provider's review opened and when it ends (§9.6). Absent for any other payment. */
function reviewFacts(row: PaymentDetail): [string, ReactNode][] {
  if (row.providerReviewStartedAt === null || row.providerReviewUntil === null) return [];
  return [
    [
      t('web.payment_provider_review_window'),
      <span key="rw">
        {formatTimestamp(row.providerReviewStartedAt)}
        {' → '}
        {formatTimestamp(row.providerReviewUntil)}
      </span>,
    ],
  ];
}

/**
 * A card-transfer attempt's two lanes (TonPays Telegram §10): which card is current — its
 * sequence and when it arrived, never its number — the last card change, and what happened
 * to each receipt. States and codes only: the receipt itself never reaches this page.
 */
function cardTransferFacts(invoice: GatewayInvoiceDetail): [string, ReactNode][] {
  if (invoice.cardSeq === null && invoice.receiptSubmissions.length === 0) return [];
  const change = invoice.latestCardChange;
  return [
    [
      t('web.payment_gateway_card'),
      invoice.cardSeq === null ? (
        <Dash key="cs" />
      ) : (
        <span key="cs">
          <Ltr>{`#${String(invoice.cardSeq)}`}</Ltr>
          {invoice.cardReceivedAt === null ? null : ` · ${formatTimestamp(invoice.cardReceivedAt)}`}
          {invoice.cardChangeExhausted === true ? (
            <>
              {' '}
              <Badge tone="neutral">{t('web.payment_gateway_card_change_exhausted')}</Badge>
            </>
          ) : null}
        </span>
      ),
    ],
    [
      t('web.payment_gateway_card_change'),
      change === null ? (
        <Dash key="cc" />
      ) : (
        <Ltr key="cc">
          {`${change.state}${change.errorCode === null ? '' : ` · ${change.errorCode}`} · ${formatTimestamp(change.requestedAt)}`}
        </Ltr>
      ),
    ],
    [
      t('web.payment_gateway_receipts'),
      invoice.receiptSubmissions.length === 0 ? (
        <Dash key="rs" />
      ) : (
        <span key="rs">
          {invoice.receiptSubmissions.map((one) => (
            <div key={one.id}>
              <Ltr>
                {`${one.state}${one.errorCode === null ? '' : ` · ${one.errorCode}`}${one.providerStatus === null ? '' : ` · ${one.providerStatus}`} · ${formatTimestamp(one.createdAt)}`}
              </Ltr>
              {one.openedReview ? (
                <>
                  {' '}
                  <Badge tone="info">{t('web.payment_gateway_receipt_opened_review')}</Badge>
                </>
              ) : null}
            </div>
          ))}
        </span>
      ),
    ],
  ];
}

/**
 * Resolving an `UNKNOWN` gateway payment (TonPays Telegram audit §9.6.4).
 *
 * The provider's RECORDED answer is shown first because it is the only thing that can
 * decide: the server refuses CONFIRMED without a recorded `completed` + `paid`, and FAILED
 * without a recorded `rejected`/`expired`/`canceled`. "Ask again" writes a request for the
 * worker's next inquiry and decides nothing. Both commands carry an idempotency key bound
 * to what was submitted, kept across a 5xx so a retry is a replay and never a second move.
 */
function ReconcileCard({
  payment,
  mayReconcile,
}: {
  payment: PaymentDetail;
  mayReconcile: boolean;
}) {
  const notify = useToast();
  const queries = useQueryClient();
  const decision = useSubmissionKey();
  const asking = useSubmissionKey();
  const [note, setNote] = useState('');
  const invoice = payment.gatewayInvoice;

  const refresh = () => {
    void queries.invalidateQueries({ queryKey: ['payment', payment.id] });
    void queries.invalidateQueries({ queryKey: ['payments'] });
    void queries.invalidateQueries({ queryKey: ['payment-timeline', payment.id] });
    void queries.invalidateQueries({ queryKey: ['order'] });
    void queries.invalidateQueries({ queryKey: ['wallet'] });
  };

  const reconcile = useMutation({
    mutationFn: (to: 'CONFIRMED' | 'FAILED') =>
      reconcilePayment({
        paymentId: payment.id,
        idempotencyKey: decision.current({ id: payment.id, to, note }),
        to,
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      }),
    onSuccess: () => {
      decision.settle();
      notify({ tone: 'ok', message: t('web.payment_reconcile_done') });
      setNote('');
      refresh();
    },
    onError: (error) => {
      decision.settleOn(error);
      refresh();
    },
  });

  const reinquire = useMutation({
    mutationFn: () =>
      reinquirePayment({
        paymentId: payment.id,
        idempotencyKey: asking.current({ id: payment.id }),
      }),
    onSuccess: (response) => {
      asking.settle();
      notify({
        tone: 'ok',
        message: t(
          response.requested ? 'web.payment_reinquire_done' : 'web.payment_reinquire_recent',
        ),
      });
      refresh();
    },
    onError: (error) => {
      asking.settleOn(error);
    },
  });

  useUnsavedChanges(mayReconcile && note.trim() !== '');
  const busy = reconcile.isPending || reinquire.isPending;

  return (
    <Card title={t('web.payment_reconcile_title')} hint={t('web.payment_reconcile_hint')}>
      <KV
        items={[
          [
            t('web.payment_reconcile_evidence'),
            invoice === null ? (
              <Dash key="ev" />
            ) : (
              <Ltr key="ev">
                {`${invoice.providerStatus ?? '—'} · paid=${invoice.providerPaid === null ? '—' : String(invoice.providerPaid)}`}
              </Ltr>
            ),
          ],
          [
            t('web.payment_gateway_invoice_last_inquiry'),
            invoice?.lastInquiryAt == null ? (
              <Dash key="li" />
            ) : (
              <span key="li">{formatTimestamp(invoice.lastInquiryAt)}</span>
            ),
          ],
        ]}
      />
      {mayReconcile ? (
        <>
          <Field label={t('web.payment_reconcile_note')} htmlFor="reconcile-note">
            <Input
              id="reconcile-note"
              size="sm"
              value={note}
              maxLength={500}
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
          <div className="form-actions">
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => reconcile.mutate('CONFIRMED')}
            >
              {t('web.payment_reconcile_confirm')}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => reconcile.mutate('FAILED')}>
              {t('web.payment_reconcile_fail')}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => reinquire.mutate()}>
              {t('web.payment_reinquire')}
            </Button>
          </div>
          {reconcile.error !== null && <Banner tone="danger">{messageFor(reconcile.error)}</Banner>}
          {reinquire.error !== null && <Banner tone="danger">{messageFor(reinquire.error)}</Banner>}
        </>
      ) : (
        <Banner tone="info">{t('web.payment_reconcile_denied')}</Banner>
      )}
    </Card>
  );
}

/** Re-exported so the shell can read a query's state without importing the page's guts. */
export { queryState };
