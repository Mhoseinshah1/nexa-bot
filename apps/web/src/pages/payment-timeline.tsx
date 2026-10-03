import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import type {
  CustomerNotificationState,
  PaymentMethod,
  PaymentResolvedState,
  PaymentState,
  PaymentTimelineResponse,
  PaymentTimelineEntry,
  PaymentTimelineKind,
  PaymentTimelineSection,
  RefundChannel,
} from '@nexa/contracts';
import { fetchPaymentReceipts, fetchPaymentTimeline } from '../api/client';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import {
  Banner,
  Button,
  Card,
  Copyable,
  DataTable,
  Empty,
  Ltr,
  Money,
  StateSwitch,
  type Tone,
} from '../ui/kit';
import { pollUnlessFinalWhile } from '../polling';
import { useLinkHandler } from '../router';
import { retryOf } from '../view-state';

/**
 * How often the history is read again while a notice it shows is still PENDING — the one
 * delivery state the notification lane will still change (Codex review of #81). Only
 * then: a history whose notices are all resolved is not polled at all.
 */
export const TIMELINE_UNSETTLED_POLL_MS = 15_000;

function hasUnsettledNotice(data: PaymentTimelineResponse): boolean {
  return data.entries.some(
    (entry) => entry.kind === 'CUSTOMER_NOTIFIED' && entry.deliveryState === 'PENDING',
  );
}

/**
 * Whether the history can still gain facts nobody on this page causes: a notice the lane
 * is still deciding, or a payment still OPEN, which a worker or another operator may
 * confirm, expire or reject at any moment (Codex review of #81). A decided payment with
 * its notices resolved is not polled; what this page does to it re-reads the history
 * itself.
 */
export function timelineStillMoving(data: PaymentTimelineResponse): boolean {
  return hasUnsettledNotice(data) || timelineTerminalState(data) === 'OPEN';
}

/**
 * A payment's history (WP17, `docs/wp17-payment-phase3-audit.md` D2).
 *
 * READ-ONLY, and nothing on it is a control. Every row is a fact another flow recorded;
 * the server assembled and ordered them, and this card renders them in the order given —
 * it does not sort, because the server's order carries a tie-break (a wallet settlement's
 * creation and confirmation share one instant) this card could only get wrong.
 *
 * What the viewer may not see is NAMED, never silently absent: the server returns the
 * sections it withheld, and the card says so above the table.
 */

const KIND_LABELS: Readonly<Record<PaymentTimelineKind, WebKey>> = {
  PAYMENT_CREATED: 'web.payment_timeline_created',
  CUSTOMER_SIGNALLED: 'web.payment_timeline_signalled',
  RECEIPT_SUBMITTED: 'web.payment_timeline_receipt',
  PAYMENT_CONFIRMED: 'web.payment_timeline_confirmed',
  PAYMENT_RESOLVED: 'web.payment_timeline_resolved',
  RECEIPT_CREDITED: 'web.payment_timeline_receipt_credited',
  WALLET_ENTRY: 'web.payment_timeline_wallet_entry',
  REFUND_REQUESTED: 'web.payment_timeline_refund_requested',
  REFUND_COMPLETED: 'web.payment_timeline_refund_completed',
  REFUND_CLOSED_FAILED: 'web.payment_timeline_refund_failed',
  CUSTOMER_NOTIFIED: 'web.payment_timeline_notified',
  GATEWAY_INVOICE_REQUESTED: 'web.payment_timeline_invoice_requested',
  GATEWAY_INVOICE_CREATED: 'web.payment_timeline_invoice_created',
  GATEWAY_WEBHOOK_HINT: 'web.payment_timeline_webhook',
  GATEWAY_INQUIRY: 'web.payment_timeline_inquiry',
  GATEWAY_REINQUIRE_REQUESTED: 'web.payment_timeline_reinquire',
  PROVIDER_REVIEW_OPENED: 'web.payment_timeline_review_opened',
  PAYMENT_OUTCOME_UNKNOWN: 'web.payment_timeline_outcome_unknown',
  GATEWAY_OUTCOME: 'web.payment_timeline_gateway_outcome',
  GATEWAY_LATE_COMPLETION: 'web.payment_timeline_late_completion',
  ORDER_SETTLED: 'web.payment_timeline_order_settled',
  ORDER_FULFILMENT: 'web.payment_timeline_order_fulfilment',
  ORDER_REFUNDED: 'web.payment_timeline_order_refunded',
  AUDIT_RECORDED: 'web.payment_timeline_audit',
};

/**
 * The dot beside each event: decoration beside the label, never instead of it.
 * Money arriving is ok, money going back or a payment ending unpaid is warn, and
 * everything the customer or the bot did is neutral information.
 */
const KIND_TONES: Readonly<Record<PaymentTimelineKind, Tone>> = {
  PAYMENT_CREATED: 'info',
  CUSTOMER_SIGNALLED: 'info',
  RECEIPT_SUBMITTED: 'info',
  PAYMENT_CONFIRMED: 'ok',
  PAYMENT_RESOLVED: 'warn',
  RECEIPT_CREDITED: 'ok',
  WALLET_ENTRY: 'violet',
  REFUND_REQUESTED: 'warn',
  REFUND_COMPLETED: 'violet',
  REFUND_CLOSED_FAILED: 'neutral',
  CUSTOMER_NOTIFIED: 'teal',
  GATEWAY_INVOICE_REQUESTED: 'info',
  GATEWAY_INVOICE_CREATED: 'info',
  GATEWAY_WEBHOOK_HINT: 'neutral',
  GATEWAY_INQUIRY: 'info',
  GATEWAY_REINQUIRE_REQUESTED: 'neutral',
  PROVIDER_REVIEW_OPENED: 'info',
  PAYMENT_OUTCOME_UNKNOWN: 'warn',
  GATEWAY_OUTCOME: 'neutral',
  GATEWAY_LATE_COMPLETION: 'warn',
  ORDER_SETTLED: 'ok',
  ORDER_FULFILMENT: 'violet',
  ORDER_REFUNDED: 'warn',
  AUDIT_RECORDED: 'neutral',
};

const SECTION_LABELS: Readonly<Record<PaymentTimelineSection, WebKey>> = {
  RECEIPTS: 'web.payment_timeline_withheld_receipts',
  REFUNDS: 'web.payment_timeline_withheld_refunds',
  WALLET: 'web.payment_timeline_withheld_wallet',
  ORDER: 'web.payment_timeline_withheld_order',
  AUDIT: 'web.payment_timeline_withheld_audit',
};

/** An order named by an entry: a link to it, the way the detail links one. */
function OrderLink({ orderId }: { orderId: string }) {
  const onLink = useLinkHandler();
  return (
    <a href={`/orders/${encodeURIComponent(orderId)}`} onClick={onLink}>
      <Ltr>{orderId.slice(0, 8)}</Ltr>
    </a>
  );
}

/** A provider's own status or code, as recorded: left-to-right, or a dash. */
function code(value: string | null): ReactNode {
  return <Ltr>{value ?? '—'}</Ltr>;
}

const DELIVERY_LABELS: Readonly<Record<CustomerNotificationState, WebKey>> = {
  PENDING: 'web.payment_timeline_delivery_pending',
  DELIVERED: 'web.payment_timeline_delivery_delivered',
  UNCONFIRMED: 'web.payment_timeline_delivery_unconfirmed',
  FAILED: 'web.payment_timeline_delivery_failed',
  SUPERSEDED: 'web.payment_timeline_delivery_superseded',
};

const RESOLVED_LABELS: Readonly<Record<PaymentResolvedState, WebKey>> = {
  FAILED: 'web.payment_state_failed',
  CANCELLED: 'web.payment_state_cancelled',
  EXPIRED: 'web.payment_state_expired',
};

const METHOD_LABELS: Readonly<Record<PaymentMethod, WebKey>> = {
  WALLET: 'web.payment_method_wallet',
  MANUAL_TRANSFER: 'web.payment_method_manual',
  GATEWAY: 'web.payment_method_gateway',
};

const CHANNEL_LABELS: Readonly<Record<RefundChannel, WebKey>> = {
  WALLET_CREDIT: 'web.refund_channel_wallet',
  EXTERNAL_MANUAL: 'web.refund_channel_manual',
  PROVIDER: 'web.refund_channel_provider',
};

/** The administrator behind an entry, or the system, said rather than dashed. */
function actor(adminId: string | null): ReactNode {
  return adminId === null ? (
    <span className="muted small">{t('web.payment_timeline_by_system')}</span>
  ) : (
    <Copyable value={adminId} />
  );
}

/** The one detail each kind carries. Codes stay codes, left-to-right, as on the detail. */
function detail(entry: PaymentTimelineEntry): ReactNode {
  switch (entry.kind) {
    case 'PAYMENT_CREATED':
      return (
        <>
          {t(METHOD_LABELS[entry.method])} ·{' '}
          <Money value={{ amountMinor: entry.amountMinor, currency: entry.currency }} />
        </>
      );
    case 'CUSTOMER_SIGNALLED':
      return null;
    case 'RECEIPT_SUBMITTED':
      return <Ltr>{entry.receiptKind}</Ltr>;
    case 'PAYMENT_CONFIRMED':
      return (
        <>
          <Ltr>{entry.evidenceKind}</Ltr> ·{' '}
          {/*
            A WALLET_DEBIT confirmation is the customer paying from their own balance
            (`settleFromWallet`), recorded with no administrator; it is said as the
            customer's, never the system's (Codex review of #81). A gateway callback with
            no administrator is still the system's.
          */}
          {entry.evidenceKind === 'WALLET_DEBIT' && entry.adminId === null ? (
            <span className="muted small">{t('web.payment_timeline_by_customer')}</span>
          ) : (
            actor(entry.adminId)
          )}
        </>
      );
    case 'PAYMENT_RESOLVED':
      return (
        <>
          {t(RESOLVED_LABELS[entry.state])} ·{' '}
          {/*
            A CANCELLED payment is always the customer's own act — they withdrew the
            transfer, or paid the order another way — and `payments_resolution_reviewer_check`
            refuses an administrator on one. So it is said as the customer's, never as
            the system's (Codex review of #81).
          */}
          {entry.state === 'CANCELLED' ? (
            <span className="muted small">{t('web.payment_timeline_by_customer')}</span>
          ) : (
            actor(entry.adminId)
          )}
        </>
      );
    case 'RECEIPT_CREDITED':
      return (
        <>
          <Money value={{ amountMinor: entry.amountMinor, currency: entry.currency }} /> ·{' '}
          {actor(entry.adminId)}
        </>
      );
    case 'WALLET_ENTRY':
      return (
        <>
          <Ltr>{`${entry.direction} ${entry.reason}`}</Ltr> ·{' '}
          <Money value={{ amountMinor: entry.amountMinor, currency: entry.currency }} />
        </>
      );
    case 'REFUND_REQUESTED':
      return (
        <>
          {t(CHANNEL_LABELS[entry.channel])} ·{' '}
          <Money value={{ amountMinor: entry.amountMinor, currency: entry.currency }} /> ·{' '}
          {actor(entry.adminId)}
        </>
      );
    case 'REFUND_COMPLETED':
      return (
        <>
          <Money value={{ amountMinor: entry.amountMinor, currency: entry.currency }} /> ·{' '}
          {actor(entry.adminId)}
        </>
      );
    case 'REFUND_CLOSED_FAILED':
      return <Money value={{ amountMinor: entry.amountMinor, currency: entry.currency }} />;
    case 'CUSTOMER_NOTIFIED':
      return (
        <>
          <Ltr>{entry.notificationKind}</Ltr> · {t(DELIVERY_LABELS[entry.deliveryState])}
          {entry.resolvedAt === null ? null : ` · ${formatTimestamp(entry.resolvedAt)}`}
        </>
      );
    case 'GATEWAY_INVOICE_REQUESTED':
      return (
        <>
          <Ltr>{entry.provider}</Ltr> · {code(entry.creationState)}
          {entry.errorCode === null ? null : <> · {code(entry.errorCode)}</>}
        </>
      );
    case 'GATEWAY_INVOICE_CREATED':
      return (
        <>
          <Ltr>{entry.provider}</Ltr>
          {entry.providerInvoiceId === null ? null : (
            <>
              {' · '}
              <Copyable value={entry.providerInvoiceId} />
            </>
          )}
        </>
      );
    case 'GATEWAY_WEBHOOK_HINT':
      return (
        <>
          {code(entry.statusHint)} · {t('web.payment_timeline_webhook_count')}{' '}
          <Ltr>{String(entry.webhookCount)}</Ltr>
        </>
      );
    case 'GATEWAY_INQUIRY':
      return (
        <>
          {code(entry.providerStatus)}
          {entry.providerPaid === null ? null : (
            <>
              {' · '}
              <Ltr>{`paid=${String(entry.providerPaid)}`}</Ltr>
            </>
          )}
          {entry.errorCode === null ? null : <> · {code(entry.errorCode)}</>}
        </>
      );
    case 'GATEWAY_REINQUIRE_REQUESTED':
      return null;
    case 'PROVIDER_REVIEW_OPENED':
      return (
        <>
          {t('web.payment_timeline_review_until')} {formatTimestamp(entry.until)}
        </>
      );
    case 'PAYMENT_OUTCOME_UNKNOWN':
      return entry.reason === null ? (
        <span className="muted small">{t('web.payment_timeline_review_lapsed')}</span>
      ) : (
        <>
          {t('web.payment_timeline_mismatch_reason')}: {code(entry.reason)}
          {entry.providerStatus === null ? null : <> · {code(entry.providerStatus)}</>}
        </>
      );
    case 'GATEWAY_OUTCOME':
      return code(entry.outcome);
    case 'GATEWAY_LATE_COMPLETION':
      return null;
    case 'ORDER_SETTLED':
    case 'ORDER_REFUNDED':
      return <OrderLink orderId={entry.orderId} />;
    case 'ORDER_FULFILMENT':
      return (
        <>
          <OrderLink orderId={entry.orderId} /> · {code(entry.operationType)} ·{' '}
          {code(entry.operationState)}
        </>
      );
    case 'AUDIT_RECORDED':
      return (
        <>
          {code(entry.action)} · {code(entry.result)} ·{' '}
          {entry.adminId === null ? code(entry.actorType) : actor(entry.adminId)}
        </>
      );
  }
}

interface Row {
  readonly index: number;
  readonly entry: PaymentTimelineEntry;
}

/**
 * The terminal state the timeline's own entries record, `'OPEN'` when they record none, or
 * `null` when a truncated history cannot say.
 */
export function timelineTerminalState(
  data: PaymentTimelineResponse,
): 'CONFIRMED' | PaymentResolvedState | 'OPEN' | null {
  if (data.truncated) return null;
  let state: 'CONFIRMED' | PaymentResolvedState | 'OPEN' = 'OPEN';
  for (const entry of data.entries) {
    if (entry.kind === 'PAYMENT_CONFIRMED') state = 'CONFIRMED';
    else if (entry.kind === 'PAYMENT_RESOLVED') state = entry.state;
  }
  return state;
}

/** Whether the timeline records the customer's transfer signal. */
export function timelineRecordsSignal(data: PaymentTimelineResponse): boolean {
  return data.entries.some((entry) => entry.kind === 'CUSTOMER_SIGNALLED');
}

export function PaymentTimelineCard({
  paymentId,
  paymentState,
  signalled = false,
  sections = '',
}: {
  paymentId: string;
  /** The state the page's detail request read. Compared, never displayed. */
  paymentState: PaymentState;
  /** Whether the detail request read a customer signal. Compared, never displayed. */
  signalled?: boolean;
  /**
   * The viewer's section permissions as they stand, in the cache identity (Codex review of
   * #81): the server decides what is withheld, so a revoked `receipts.view`, `refunds.view`
   * or `users.view` must be a NEW question to it, never an old answer kept on screen.
   */
  sections?: string;
}) {
  const queries = useQueryClient();
  const timeline = useQuery({
    queryKey: ['payment-timeline', paymentId, sections],
    queryFn: () => fetchPaymentTimeline(paymentId),
    refetchInterval: pollUnlessFinalWhile(TIMELINE_UNSETTLED_POLL_MS, timelineStillMoving),
  });
  const data = timeline.data;

  /*
   * The detail and this card are two requests, so a payment decided between them reaches
   * one and not the other: a detail still PENDING beside a history that has it confirmed
   * (Codex review of #81). A payment only ever leaves an open state, so the side that
   * still reads it open is the older read, and that one is read again. Once per pair of
   * disagreeing answers, so two answers that cannot converge cost one extra request each,
   * never a loop — unless that one request FAILED, in which case it was no answer at all
   * and is asked again a poll interval later (`readAgain`, below).
   *
   * The customer's transfer signal is the same kind of fact: set once, frozen afterwards
   * (migration 0058), and it leaves the payment PENDING (Codex review of #81). So the side
   * that has not seen it is the older one too.
   */
  /*
   * The receipts card's own answer, watched rather than fetched: `enabled: false` asks
   * nothing, so a viewer without `receipts.view` (whose page draws no such card) costs
   * no request, and an answer that lands after this card's history still re-runs the
   * comparison below.
   */
  const receiptsKey = ['payment-receipts', paymentId];
  const heldReceipts = useQuery({
    queryKey: receiptsKey,
    queryFn: () => fetchPaymentReceipts(paymentId),
    enabled: false,
  }).data;
  const reconciled = useRef(new Map<string, string>());
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  useEffect(
    () => () => {
      if (retryTimer.current !== null) clearTimeout(retryTimer.current);
    },
    [],
  );
  /*
   * Reads `key` again, once per disagreement `pair`. A read that fails — a 5xx that
   * outlasts its retries — does not count as the one read (Codex review of #81): the
   * marker is cleared and the comparison runs again a poll interval later, because the
   * disagreement may be one neither side will ever poll its way out of. A decided
   * payment's timeline stops polling, and focus refetching is off.
   */
  const readAgain = useCallback(
    (view: string, key: QueryKey, pair: string) => {
      if (reconciled.current.get(view) === pair) return;
      reconciled.current.set(view, pair);
      void queries.invalidateQueries({ queryKey: key }).then(() => {
        const failed = queries
          .getQueryCache()
          .findAll({ queryKey: key })
          .some((query) => query.state.status === 'error');
        if (!failed || reconciled.current.get(view) !== pair) return;
        reconciled.current.delete(view);
        if (retryTimer.current !== null) clearTimeout(retryTimer.current);
        retryTimer.current = setTimeout(() => {
          retryTimer.current = null;
          setRetryTick((tick) => tick + 1);
        }, TIMELINE_UNSETTLED_POLL_MS);
      });
    },
    [queries],
  );
  useEffect(() => {
    if (data === undefined) return;
    /*
     * A receipt the history names and the receipts card has not seen (Codex review of
     * #81): the card was read first and is not polled, so it is the older of the two.
     * Compared by id against what the card holds, so a page whose card already has
     * every receipt costs nothing.
     */
    if (heldReceipts !== undefined) {
      const held = new Set(heldReceipts.receipts.map((receipt) => receipt.id));
      const unseen = data.entries.flatMap((entry) =>
        entry.kind === 'RECEIPT_SUBMITTED' && !held.has(entry.receiptId) ? [entry.receiptId] : [],
      );
      if (unseen.length > 0) readAgain('receipts', receiptsKey, unseen.join(','));
    }
    const recorded = timelineTerminalState(data);
    if (recorded === null) return;
    const recordedSignal = timelineRecordsSignal(data);
    const detailOpen = paymentState === 'PENDING' || paymentState === 'UNKNOWN';
    const detailOlder = (detailOpen && recorded !== 'OPEN') || (!signalled && recordedSignal);
    const timelineOlder =
      (!detailOpen && recorded !== paymentState) || (signalled && !recordedSignal);
    const pair = `${paymentState}:${String(signalled)}:${recorded}:${String(recordedSignal)}`;
    if (detailOlder) readAgain('detail', ['payment', paymentId], pair);
    if (timelineOlder) readAgain('timeline', ['payment-timeline', paymentId], pair);
  }, [data, heldReceipts, paymentState, signalled, paymentId, readAgain, retryTick]);

  /*
   * An explicit refresh (Codex review of #81). A decided payment can still gain facts no
   * action on this page produces — an automatic refund of an undeliverable order, its
   * notice — and polling every decided payment for them would be the heavy polling the
   * brief refuses. So the card polls only while its payment or a notice is still moving,
   * and says how to ask again otherwise. Not drawn once the answer is final (a 403/404).
   */
  const refresh = retryOf(timeline);
  return (
    <Card
      title={t('web.payment_timeline')}
      hint={t('web.payment_timeline_hint')}
      actions={
        refresh === undefined ? undefined : (
          <Button size="sm" variant="ghost" icon="refresh" onClick={refresh}>
            {t('web.refresh')}
          </Button>
        )
      }
    >
      <StateSwitch query={timeline} denied={false}>
        {data === undefined ? null : (
          <>
            {data.withheld.length > 0 && (
              <Banner tone="info">
                {t('web.payment_timeline_withheld')}{' '}
                {data.withheld
                  .map((section) => t(SECTION_LABELS[section]))
                  .join(t('web.list_separator'))}
              </Banner>
            )}
            {data.truncated && <Banner tone="warn">{t('web.payment_timeline_truncated')}</Banner>}
            {data.entries.length === 0 ? (
              <Empty variant="compact" title={t('web.payment_timeline_empty')} />
            ) : (
              <DataTable<Row>
                caption={t('web.payment_timeline')}
                dense
                rows={data.entries.map((entry, index) => ({ index, entry }))}
                rowKey={(row) => String(row.index)}
                columns={[
                  {
                    key: 'at',
                    header: t('web.payment_timeline_at'),
                    render: (row) => (
                      <span className="nowrap faint">{formatTimestamp(row.entry.at)}</span>
                    ),
                  },
                  {
                    key: 'kind',
                    header: t('web.payment_timeline_event'),
                    render: (row) => (
                      <span className="ca-event">
                        <i className={`dot ${KIND_TONES[row.entry.kind]}`} aria-hidden="true" />
                        <span className="strong">{t(KIND_LABELS[row.entry.kind])}</span>
                      </span>
                    ),
                  },
                  {
                    key: 'detail',
                    header: t('web.payment_timeline_detail'),
                    wrap: true,
                    render: (row) => detail(row.entry),
                  },
                ]}
              />
            )}
          </>
        )}
      </StateSwitch>
    </Card>
  );
}
