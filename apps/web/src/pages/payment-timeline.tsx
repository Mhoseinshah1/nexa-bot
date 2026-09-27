import { useEffect, useRef, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
import { fetchPaymentTimeline } from '../api/client';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { Banner, Card, Copyable, DataTable, Empty, Ltr, Money, StateSwitch } from '../ui/kit';
import { pollUnlessFinalWhile } from '../polling';

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
};

const SECTION_LABELS: Readonly<Record<PaymentTimelineSection, WebKey>> = {
  RECEIPTS: 'web.payment_timeline_withheld_receipts',
  REFUNDS: 'web.payment_timeline_withheld_refunds',
  WALLET: 'web.payment_timeline_withheld_wallet',
};

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
          <Ltr>{entry.evidenceKind}</Ltr> · {actor(entry.adminId)}
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
   * never a loop.
   *
   * The customer's transfer signal is the same kind of fact: set once, frozen afterwards
   * (migration 0058), and it leaves the payment PENDING (Codex review of #81). So the side
   * that has not seen it is the older one too.
   */
  const reconciled = useRef<string | null>(null);
  useEffect(() => {
    if (data === undefined) return;
    const recorded = timelineTerminalState(data);
    if (recorded === null) return;
    const recordedSignal = timelineRecordsSignal(data);
    const detailOpen = paymentState === 'PENDING' || paymentState === 'UNKNOWN';
    const detailOlder = (detailOpen && recorded !== 'OPEN') || (!signalled && recordedSignal);
    const timelineOlder =
      (!detailOpen && recorded !== paymentState) || (signalled && !recordedSignal);
    if (!detailOlder && !timelineOlder) return;
    const pair = `${paymentState}:${String(signalled)}:${recorded}:${String(recordedSignal)}`;
    if (reconciled.current === pair) return;
    reconciled.current = pair;
    if (detailOlder) void queries.invalidateQueries({ queryKey: ['payment', paymentId] });
    if (timelineOlder) {
      void queries.invalidateQueries({ queryKey: ['payment-timeline', paymentId] });
    }
  }, [data, paymentState, signalled, paymentId, queries]);

  return (
    <Card title={t('web.payment_timeline')} hint={t('web.payment_timeline_hint')}>
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
              <Empty title={t('web.payment_timeline_empty')} />
            ) : (
              <DataTable<Row>
                caption={t('web.payment_timeline')}
                rows={data.entries.map((entry, index) => ({ index, entry }))}
                rowKey={(row) => String(row.index)}
                columns={[
                  {
                    key: 'at',
                    header: t('web.payment_timeline_at'),
                    render: (row) => formatTimestamp(row.entry.at),
                  },
                  {
                    key: 'kind',
                    header: t('web.payment_timeline_event'),
                    render: (row) => t(KIND_LABELS[row.entry.kind]),
                  },
                  {
                    key: 'detail',
                    header: t('web.payment_timeline_detail'),
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
