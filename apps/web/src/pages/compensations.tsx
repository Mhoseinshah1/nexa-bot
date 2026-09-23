import { useQuery } from '@tanstack/react-query';
import { AUTOMATIC_REFUND_REASON, type CompensationView, type RefundState } from '@nexa/contracts';
import { fetchCompensations } from '../api/client';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { setQuery, useLinkHandler, type Route } from '../router';
import {
  Badge,
  Card,
  CursorPager,
  DataTable,
  Empty,
  Ltr,
  Money,
  PageHead,
  StateSwitch,
  type Column,
  type Tone,
} from '../ui/kit';
import { TelegramIdentity } from './payments';

/**
 * Compensations — the money this installation gave back on its own (Payment File 02 §13 and
 * §21, `docs/payments-file02-design.md` D7).
 *
 * Every row is a refund with reason `UNDELIVERABLE` on the wallet channel: a customer paid,
 * the order could not be delivered, and `RefundService.refundUndeliverable` returned the
 * principal once. The page READS that list and does nothing else. There is no action,
 * because a compensation is automatic and has no second step; and there is no timeline,
 * because §21 asks for current state — the payment and the order each have their own page,
 * one link away.
 *
 * The principal and the credited amount are both shown although they are equal for every
 * row the product writes: §21 asks for both, and a difference would be the thing an
 * operator needs to see.
 */

const STATE_LABELS: Readonly<Record<RefundState, WebKey>> = {
  REQUESTED: 'web.refund_state_requested',
  AWAITING_EXTERNAL: 'web.refund_state_awaiting',
  COMPLETED: 'web.refund_state_completed',
  FAILED: 'web.refund_state_failed',
};

const STATE_TONES: Readonly<Record<RefundState, Tone>> = {
  REQUESTED: 'warn',
  AWAITING_EXTERNAL: 'warn',
  COMPLETED: 'ok',
  FAILED: 'neutral',
};

/** The reason, in words when it is the one the product writes, and verbatim otherwise. */
function reasonOf(reason: string) {
  return reason === AUTOMATIC_REFUND_REASON ? (
    t('web.compensation_reason_undeliverable')
  ) : (
    <Ltr>{reason}</Ltr>
  );
}

export function CompensationsPage({ route, denied }: { route: Route; denied: boolean }) {
  const onLink = useLinkHandler();
  const cursor = route.query.get('cursor');

  const compensations = useQuery({
    queryKey: ['compensations', cursor],
    queryFn: () => fetchCompensations(cursor === null ? {} : { cursor }),
    enabled: !denied,
  });

  const columns: readonly Column<CompensationView>[] = [
    {
      key: 'payment',
      header: t('web.compensation_payment'),
      render: (row) => (
        <a href={`/payments/${encodeURIComponent(row.paymentId)}`} onClick={onLink}>
          <Ltr>{row.paymentId.slice(0, 8)}</Ltr>
        </a>
      ),
    },
    {
      key: 'order',
      header: t('web.compensation_order'),
      render: (row) =>
        row.orderId === null ? (
          <span className="faint">—</span>
        ) : (
          <a href={`/orders/${encodeURIComponent(row.orderId)}`} onClick={onLink}>
            <Ltr>{row.orderId.slice(0, 8)}</Ltr>
          </a>
        ),
    },
    {
      key: 'customer',
      header: t('web.compensation_customer'),
      render: (row) => (
        <span className="nowrap">
          <a href={`/users/${encodeURIComponent(row.customerId)}`} onClick={onLink}>
            <Ltr>{row.customerId.slice(0, 8)}</Ltr>
          </a>{' '}
          <TelegramIdentity
            telegramUserId={row.customerTelegramUserId}
            username={row.customerUsername}
          />
        </span>
      ),
    },
    {
      key: 'principal',
      header: t('web.compensation_principal'),
      render: (row) => (
        <Money value={{ amountMinor: row.principalMinor, currency: row.currency }} />
      ),
    },
    {
      key: 'credited',
      header: t('web.compensation_credited'),
      render: (row) => <Money value={{ amountMinor: row.creditedMinor, currency: row.currency }} />,
    },
    {
      key: 'reason',
      header: t('web.compensation_reason'),
      render: (row) => reasonOf(row.reason),
    },
    {
      key: 'state',
      header: t('web.compensation_state'),
      render: (row) => <Badge tone={STATE_TONES[row.state]}>{t(STATE_LABELS[row.state])}</Badge>,
    },
    {
      key: 'time',
      header: t('web.compensation_time'),
      render: (row) => (
        <span className="nowrap">{formatTimestamp(row.completedAt ?? row.createdAt)}</span>
      ),
    },
  ];

  return (
    <>
      <PageHead
        title={t('web.compensations_title')}
        subtitle={t('web.compensations_intro')}
        maturity="now"
      />
      <Card>
        <StateSwitch query={compensations} denied={denied}>
          {compensations.data === undefined ? null : compensations.data.compensations.length ===
            0 ? (
            <Empty title={t('web.compensations_empty')} />
          ) : (
            <>
              <DataTable
                caption={t('web.compensations_title')}
                columns={columns}
                rows={compensations.data.compensations}
                rowKey={(row) => row.refundId}
              />
              <CursorPager
                shown={compensations.data.compensations.length}
                hasPrevious={cursor !== null}
                hasNext={compensations.data.nextCursor !== null}
                onPrevious={() => setQuery(route, 'cursor', null)}
                onNext={() => setQuery(route, 'cursor', compensations.data?.nextCursor ?? null)}
              />
            </>
          )}
        </StateSwitch>
      </Card>
    </>
  );
}
