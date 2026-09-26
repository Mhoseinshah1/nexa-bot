import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  CustomerNotificationState,
  PaymentMethod,
  PaymentResolvedState,
  PaymentTimelineEntry,
  PaymentTimelineKind,
  PaymentTimelineSection,
  RefundChannel,
} from '@nexa/contracts';
import { fetchPaymentTimeline } from '../api/client';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { Banner, Card, Copyable, DataTable, Empty, Ltr, Money, StateSwitch } from '../ui/kit';

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
          {t(RESOLVED_LABELS[entry.state])} · {actor(entry.adminId)}
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

export function PaymentTimelineCard({ paymentId }: { paymentId: string }) {
  const timeline = useQuery({
    queryKey: ['payment-timeline', paymentId],
    queryFn: () => fetchPaymentTimeline(paymentId),
  });
  const data = timeline.data;

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
