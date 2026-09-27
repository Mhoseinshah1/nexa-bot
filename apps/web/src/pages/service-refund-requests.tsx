import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ServiceRefundRequestState, type ServiceRefundRequestView } from '@nexa/contracts';
import {
  approveServiceRefundRequest,
  fetchServiceRefundRequests,
  fetchServiceRefundRequestsForService,
  rejectServiceRefundRequest,
} from '../api/client';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { useLinkHandler } from '../router';
import { useSubmissionKey } from '../submission-key';
import {
  Badge,
  Banner,
  Card,
  DataTable,
  Empty,
  Field,
  Ltr,
  Money,
  StateSwitch,
  useToast,
  type Column,
  type Tone,
} from '../ui/kit';
import { messageFor } from './settings';

/**
 * Customers' service refund requests in the Web Admin (WP19, brief §2.10): the smallest
 * durable fallback for the Telegram review card. The request is a row whatever happened to
 * the card, and these two cards are where an operator finds it.
 *
 * Nothing here decides anything. The server charges `refunds.view` to read and
 * `refunds.issue` AND `services.terminate` to decide, re-decides eligibility and the bound
 * under the payment's lock, and credits the wallet only after the account is deleted. The
 * remaining figure on every row is the server's; the amount typed here is a proposal.
 */

const STATE_LABELS: Readonly<Record<ServiceRefundRequestState, WebKey>> = {
  OPEN: 'web.service_refund_state_open',
  EXECUTING: 'web.service_refund_state_executing',
  COMPLETED: 'web.service_refund_state_completed',
  REJECTED: 'web.service_refund_state_rejected',
  FAILED: 'web.service_refund_state_failed',
};

const STATE_TONES: Readonly<Record<ServiceRefundRequestState, Tone>> = {
  OPEN: 'warn',
  EXECUTING: 'info',
  COMPLETED: 'ok',
  REJECTED: 'neutral',
  FAILED: 'danger',
};

/** Digits only, as a decimal STRING of minor units — never a float. */
function digitsOf(value: string): string {
  const trimmed = value.trim();
  return /^[0-9]{1,19}$/u.test(trimmed) ? trimmed.replace(/^0+(?=[0-9])/u, '') : '0';
}

function columns(onLink: ReturnType<typeof useLinkHandler>, withService: boolean) {
  const all: Column<ServiceRefundRequestView>[] = [
    {
      key: 'state',
      header: t('web.refund_state'),
      render: (row) => <Badge tone={STATE_TONES[row.state]}>{t(STATE_LABELS[row.state])}</Badge>,
    },
    {
      key: 'service',
      header: t('web.service_refund_service'),
      render: (row) => (
        <a href={`/services/${encodeURIComponent(row.serviceId)}`} onClick={onLink}>
          <Ltr>{row.serviceUsername ?? row.serviceId}</Ltr>
        </a>
      ),
    },
    {
      key: 'customer',
      header: t('web.service_refund_customer'),
      render: (row) => (
        <Ltr>
          {row.customerTelegramUserId ?? '—'}
          {row.customerUsername === null ? '' : ` @${row.customerUsername}`}
        </Ltr>
      ),
    },
    { key: 'reason', header: t('web.service_refund_reason'), render: (row) => row.reason },
    {
      key: 'principal',
      header: t('web.service_refund_principal'),
      render: (row) => (
        <Money value={{ amountMinor: row.principalMinor, currency: row.currency }} />
      ),
    },
    {
      key: 'remaining',
      header: t('web.service_refund_remaining'),
      render: (row) => (
        <Money value={{ amountMinor: row.remainingMinor, currency: row.currency }} />
      ),
    },
    {
      key: 'approved',
      header: t('web.service_refund_approved'),
      render: (row) =>
        row.approvedAmountMinor === null ? (
          '—'
        ) : (
          <Money value={{ amountMinor: row.approvedAmountMinor, currency: row.currency }} />
        ),
    },
    {
      key: 'operation',
      header: t('web.service_refund_operation'),
      // The frozen token, as the Telegram admin screen shows it: one word for one fact.
      render: (row) => (row.operationState === null ? '—' : <Ltr>{row.operationState}</Ltr>),
    },
    {
      key: 'outcome',
      header: t('web.service_refund_outcome'),
      render: (row) =>
        row.rejectionReason ?? (row.failureKind === null ? '—' : <Ltr>{row.failureKind}</Ltr>),
    },
    {
      key: 'created',
      header: t('web.service_refund_created'),
      render: (row) => formatTimestamp(row.createdAt),
    },
  ];
  return withService ? all : all.filter((column) => column.key !== 'service');
}

/**
 * Every request that still wants an operator, following the server's ONE cursor until it
 * says there is no more. One stream, not one per state (Codex review of #83, round 6): three
 * scans read at three moments could each miss a request that moved between them, OPEN read
 * after it became EXECUTING and EXECUTING read before. Under one keyset on `(createdAt, id)`,
 * which no transition changes, each request is on exactly one page, in the state it had there.
 */
async function fetchEveryAttentionPage(): Promise<ServiceRefundRequestView[]> {
  const rows: ServiceRefundRequestView[] = [];
  let cursor: { at: string; id: string } | undefined;
  for (;;) {
    const page = await fetchServiceRefundRequests(
      cursor === undefined ? { attention: true } : { attention: true, cursor },
    );
    rows.push(...page.requests);
    if (page.nextCursor === null) return rows;
    cursor = page.nextCursor;
  }
}

/**
 * The requests that still want an operator, on the services list: undecided, executing or
 * failed. Read-only — each row links to its service, where the decision is.
 */
export function OpenServiceRefundRequestsCard() {
  const onLink = useLinkHandler();
  // The server filters to the states that want an operator BEFORE it limits: a page of the
  // newest requests of every state would hide an old undecided one behind a hundred newer
  // decided ones. And EVERY page, by the server's cursor: more than a page must not leave the
  // oldest — the longest-waiting — on no page at all. Already newest first, as the server sent it.
  const requests = useQuery({
    queryKey: ['service-refund-requests', 'attention'],
    queryFn: async () => ({ requests: await fetchEveryAttentionPage() }),
  });
  const rows = requests.data?.requests ?? [];
  return (
    <Card title={t('web.service_refunds_open')} hint={t('web.service_refunds_hint')}>
      <StateSwitch query={requests} denied={false}>
        {rows.length === 0 ? (
          <Empty title={t('web.service_refunds_empty')} />
        ) : (
          <DataTable
            caption={t('web.service_refunds_open')}
            columns={columns(onLink, true)}
            rows={rows}
            rowKey={(row) => row.id}
          />
        )}
      </StateSwitch>
    </Card>
  );
}

/** One service's requests, and the two decisions for the one that is OPEN. */
export function ServiceRefundRequestsCard({
  serviceId,
  mayDecide,
}: {
  serviceId: string;
  /** `refunds.issue` AND `services.terminate`. Drawing the form is a courtesy; the server decides. */
  mayDecide: boolean;
}) {
  const onLink = useLinkHandler();
  const requests = useQuery({
    queryKey: ['service-refund-requests', 'service', serviceId],
    queryFn: () => fetchServiceRefundRequestsForService(serviceId),
  });
  const rows = requests.data?.requests ?? [];
  const open = rows.find((row) => row.state === 'OPEN');
  return (
    <Card title={t('web.service_refunds')} hint={t('web.service_refunds_hint')}>
      <StateSwitch query={requests} denied={false}>
        {rows.length === 0 ? (
          <Empty title={t('web.service_refunds_empty')} />
        ) : (
          <DataTable
            caption={t('web.service_refunds')}
            columns={columns(onLink, false)}
            rows={rows}
            rowKey={(row) => row.id}
          />
        )}
        {open !== undefined &&
          (mayDecide ? (
            <DecisionForm key={open.id} request={open} serviceId={serviceId} />
          ) : (
            <Banner tone="info">{t('web.service_refund_denied')}</Banner>
          ))}
      </StateSwitch>
    </Card>
  );
}

function DecisionForm({
  request,
  serviceId,
}: {
  request: ServiceRefundRequestView;
  serviceId: string;
}) {
  const notify = useToast();
  const queries = useQueryClient();
  const approval = useSubmissionKey();
  const rejection = useSubmissionKey();
  const [amount, setAmount] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [reason, setReason] = useState('');

  const refresh = () => {
    void queries.invalidateQueries({ queryKey: ['service-refund-requests'] });
    // The approval planned a deletion: the service's own operations moved too.
    void queries.invalidateQueries({ queryKey: ['service', serviceId] });
    void queries.invalidateQueries({ queryKey: ['service-operations', serviceId] });
  };

  const approve = useMutation({
    mutationFn: () =>
      approveServiceRefundRequest({
        requestId: request.id,
        idempotencyKey: approval.current({ request: request.id, amount: digitsOf(amount) }),
        amountMinor: digitsOf(amount),
      }),
    onSuccess: () => {
      approval.settle();
      notify({ tone: 'ok', message: t('web.service_refund_approved_toast') });
      refresh();
    },
    // A 5xx may have committed: the retry keeps its key rather than approving twice.
    onError: (error) => {
      approval.settleOn(error);
      refresh();
    },
  });

  const reject = useMutation({
    mutationFn: () =>
      rejectServiceRefundRequest({
        requestId: request.id,
        idempotencyKey: rejection.current({ request: request.id, reason: reason.trim() }),
        reason: reason.trim(),
      }),
    onSuccess: () => {
      rejection.settle();
      notify({ tone: 'ok', message: t('web.service_refund_rejected_toast') });
      refresh();
    },
    onError: (error) => {
      rejection.settleOn(error);
      refresh();
    },
  });

  const busy = approve.isPending || reject.isPending;
  return (
    <>
      <Field label={t('web.service_refund_amount')} htmlFor="service-refund-amount">
        <input
          id="service-refund-amount"
          value={amount}
          inputMode="numeric"
          maxLength={19}
          onChange={(event) => setAmount(event.target.value)}
        />
      </Field>
      <label className="check">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />{' '}
        {t('web.service_refund_confirm')}
      </label>
      <div className="toolbar">
        <button
          type="button"
          className="btn danger sm"
          disabled={busy || !confirmed || digitsOf(amount) === '0'}
          onClick={() => approve.mutate()}
        >
          {t('web.service_refund_approve')}
        </button>
      </div>
      <Field label={t('web.service_refund_reject_reason')} htmlFor="service-refund-reject">
        <input
          id="service-refund-reject"
          value={reason}
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
      <div className="toolbar">
        <button
          type="button"
          className="btn sm"
          disabled={busy || reason.trim().length === 0}
          onClick={() => reject.mutate()}
        >
          {t('web.service_refund_reject')}
        </button>
      </div>
      {approve.error !== null && <Banner tone="danger">{messageFor(approve.error)}</Banner>}
      {reject.error !== null && <Banner tone="danger">{messageFor(reject.error)}</Banner>}
    </>
  );
}
