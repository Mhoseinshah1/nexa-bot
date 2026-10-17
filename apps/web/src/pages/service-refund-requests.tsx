import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { keepPageWhileTurning } from '../ui/paging';
import {
  OPERATION_STATES,
  PROVIDER_FAILURE_KINDS,
  isServiceRefundRejectionReason,
  type OperationState,
  type ProviderFailureKind,
  type ServiceRefundRequestState,
  type ServiceRefundRequestView,
} from '@nexa/contracts';
import {
  approveServiceRefundRequest,
  fetchServiceRefundRequests,
  fetchServiceRefundRequestsForService,
  rejectServiceRefundRequest,
} from '../api/client';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { useLinkHandler } from '../router';
import { useSubmissionKey, type SubmissionKey } from '../submission-key';
import {
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  CursorPager,
  DataTable,
  Empty,
  Field,
  Input,
  Ltr,
  Money,
  StateSwitch,
  useToast,
  useUnsavedChanges,
  type Column,
  type Tone,
} from '../ui/kit';
import { messageFor } from './settings';
import { Drawer } from '../ui/overlays';
import { useConfirmedClose } from '../ui/unsaved';
import { OPERATION_STATE_LABELS, OPERATION_STATE_TONES } from './services';
import { ErrorRef } from '../ui/technical-details';

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

/**
 * W5: what a FAILED request's `failureKind` means, in Persian. The server writes the
 * deletion operation's provider failure kind, its terminal state when it carried none, or
 * `RESERVATION_RELEASED` (the deletion succeeded but the refund's reservation had already
 * been released). A value this map does not know is shown as the raw key, never blank.
 */
export const REFUND_FAILURE_LABELS: Readonly<
  Record<ProviderFailureKind | 'RESERVATION_RELEASED', WebKey>
> = {
  AUTHENTICATION_FAILED: 'web.rr_fk_authentication_failed',
  AUTHENTICATION_REQUIRES_INTERACTION: 'web.rr_fk_authentication_requires_interaction',
  UNREACHABLE: 'web.rr_fk_unreachable',
  TIMEOUT: 'web.rr_fk_timeout',
  TLS_FAILED: 'web.rr_fk_tls_failed',
  BLOCKED_TARGET: 'web.rr_fk_blocked_target',
  RATE_LIMITED: 'web.rr_fk_rate_limited',
  MALFORMED_RESPONSE: 'web.rr_fk_malformed_response',
  PROVIDER_ERROR: 'web.rr_fk_provider_error',
  PROVIDER_REFUSED: 'web.rr_fk_provider_refused',
  UNSUPPORTED_CAPABILITY: 'web.rr_fk_unsupported_capability',
  RESERVATION_RELEASED: 'web.rr_fk_reservation_released',
};

/** The Persian name of a failure kind (or of an operation state), or `null` when unknown. */
export function refundFailureLabel(kind: string): string | null {
  if (
    (PROVIDER_FAILURE_KINDS as readonly string[]).includes(kind) ||
    kind === 'RESERVATION_RELEASED'
  ) {
    return t(REFUND_FAILURE_LABELS[kind as ProviderFailureKind | 'RESERVATION_RELEASED']);
  }
  if ((OPERATION_STATES as readonly string[]).includes(kind)) {
    return t(OPERATION_STATE_LABELS[kind as OperationState]);
  }
  return null;
}

/** A raw machine key as Persian text, the key kept in `title`; unknown → the raw key. */
function Named({ raw, name }: { raw: string; name: string | null }) {
  return name === null ? <Ltr>{raw}</Ltr> : <span title={raw}>{name}</span>;
}

/** Digits only, as a decimal STRING of minor units — never a float. */
function digitsOf(value: string): string {
  const trimmed = value.trim();
  return /^[0-9]{1,19}$/u.test(trimmed) ? trimmed.replace(/^0+(?=[0-9])/u, '') : '0';
}

function columns(
  onLink: ReturnType<typeof useLinkHandler>,
  withService: boolean,
  decide?: (row: ServiceRefundRequestView) => ReactNode,
) {
  const all: Column<ServiceRefundRequestView>[] = [
    {
      key: 'state',
      header: t('web.refund_state'),
      render: (row) => (
        <>
          <Badge tone={STATE_TONES[row.state]} dot>
            {t(STATE_LABELS[row.state])}
          </Badge>
          {/* W3: the OPEN request's two decisions, under its state badge. */}
          {row.state === 'OPEN' && decide !== undefined && decide(row)}
        </>
      ),
    },
    {
      key: 'service',
      header: t('web.service_refund_service'),
      render: (row) => (
        <a
          href={`/services/${encodeURIComponent(row.serviceId)}`}
          onClick={onLink}
          className="strong"
        >
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
    {
      key: 'reason',
      header: t('web.service_refund_reason'),
      wrap: true,
      // An operator's delete-and-refund (item 11) has no customer reason: it says whose it is.
      render: (row) => row.reason ?? t('web.service_refund_origin_operator'),
    },
    {
      key: 'principal',
      header: t('web.service_refund_principal'),
      align: 'end',
      render: (row) => (
        <Money value={{ amountMinor: row.principalMinor, currency: row.currency }} />
      ),
    },
    {
      key: 'remaining',
      header: t('web.service_refund_remaining'),
      align: 'end',
      render: (row) => (
        <Money value={{ amountMinor: row.remainingMinor, currency: row.currency }} />
      ),
    },
    {
      key: 'approved',
      header: t('web.service_refund_approved'),
      align: 'end',
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
      // W5: the operation state's Persian chip; the frozen token stays in `title`.
      render: (row) => {
        if (row.operationState === null) return '—';
        const known = (OPERATION_STATES as readonly string[]).includes(row.operationState)
          ? (row.operationState as OperationState)
          : null;
        return known === null ? (
          <Ltr>{row.operationState}</Ltr>
        ) : (
          <span title={row.operationState}>
            <Badge tone={OPERATION_STATE_TONES[known]}>{t(OPERATION_STATE_LABELS[known])}</Badge>
          </span>
        );
      },
    },
    {
      key: 'outcome',
      header: t('web.service_refund_outcome'),
      render: (row) =>
        row.rejectionReason ??
        (row.failureKind === null ? (
          '—'
        ) : (
          <Named raw={row.failureKind} name={refundFailureLabel(row.failureKind)} />
        )),
    },
    {
      key: 'created',
      header: t('web.service_refund_created'),
      render: (row) => <span className="nowrap">{formatTimestamp(row.createdAt)}</span>,
    },
  ];
  return withService ? all : all.filter((column) => column.key !== 'service');
}

/** The server's keyset position on `(createdAt, id)`: one page of the attention stream. */
type AttentionCursor = { readonly at: string; readonly id: string };

/**
 * The requests that still want an operator, on the services list: undecided, executing or
 * failed. Read-only — each row links to its service, where the decision is.
 *
 * ONE stream, not one per state (Codex review of #83, round 6): three scans read at three
 * moments could each miss a request that moved between them. Under one keyset on
 * `(createdAt, id)`, which no transition changes, each request is on exactly one page, in the
 * state it had there. The server filters to the states that want an operator BEFORE it
 * limits, so an old undecided request is never hidden behind a hundred newer decided ones.
 *
 * And a PAGE at a time, the operator moving through the trail (Codex review of #83, round 9).
 * FAILED is terminal and stays in the stream, so following the cursor to its end on every
 * visit loaded the installation's whole failure history — requests, rows and DOM growing
 * without bound. Nothing is lost by paging: the stream is newest first, and every page is
 * one "older" away.
 */
export function OpenServiceRefundRequestsCard() {
  const onLink = useLinkHandler();
  const [trail, setTrail] = useState<readonly AttentionCursor[]>([]);
  const cursor = trail[trail.length - 1];
  const requests = useQuery(
    keepPageWhileTurning({
      queryKey: ['service-refund-requests', 'attention', cursor ?? null],
      queryFn: () =>
        fetchServiceRefundRequests(
          cursor === undefined ? { attention: true } : { attention: true, cursor },
        ),
    }),
  );
  const rows = requests.data?.requests ?? [];
  const nextCursor = requests.data?.nextCursor ?? null;
  return (
    <Card title={t('web.service_refunds_open')} hint={t('web.service_refunds_hint')}>
      <StateSwitch query={requests} denied={false}>
        {rows.length === 0 && trail.length === 0 ? (
          <Empty variant="compact" title={t('web.service_refunds_empty')} />
        ) : (
          <>
            <DataTable
              caption={t('web.service_refunds_open')}
              columns={columns(onLink, true)}
              rows={rows}
              rowKey={(row) => row.id}
              dense
            />
            <CursorPager
              shown={rows.length}
              hasPrevious={trail.length > 0}
              hasNext={nextCursor !== null}
              onPrevious={() => setTrail(trail.slice(0, -1))}
              onNext={() => nextCursor !== null && setTrail([...trail, nextCursor])}
            />
          </>
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
          <Empty variant="compact" title={t('web.service_refunds_empty')} />
        ) : (
          <DataTable
            caption={t('web.service_refunds')}
            columns={columns(
              onLink,
              false,
              mayDecide
                ? (row) => <DecisionButtons key={row.id} request={row} serviceId={serviceId} />
                : undefined,
            )}
            rows={rows}
            rowKey={(row) => row.id}
            dense
          />
        )}
        {open !== undefined && !mayDecide && (
          <Banner tone="info">{t('web.service_refund_denied')}</Banner>
        )}
      </StateSwitch>
    </Card>
  );
}

/**
 * W3: «تأیید و حذف سرویس» and «رد درخواست» as two small buttons in the OPEN row, each opening
 * a drawer with the same fields, the same disabled-until-valid rule, the same toasts and the
 * same error banner. The draft lives here, so a closed drawer keeps nothing it did not ask
 * about: closing over a typed amount, a ticked box or a reason asks first; leaving the page
 * asks too (`useUnsavedChanges`).
 */
function DecisionButtons({
  request,
  serviceId,
}: {
  request: ServiceRefundRequestView;
  serviceId: string;
}) {
  const [drawer, setDrawer] = useState<'approve' | 'reject' | null>(null);
  /*
   * The keys live HERE, in the row that outlives the drawer: a key kept after an unanswered
   * failure (a 5xx that may have committed) must survive closing and reopening the drawer,
   * or the retry is a second decision rather than the replay of the first.
   */
  const approval = useSubmissionKey();
  const rejection = useSubmissionKey();
  return (
    <span className="wb-row-actions" role="group" aria-label={t('web.service_refund_decide')}>
      <Button size="sm" variant="danger" onClick={() => setDrawer('approve')}>
        {t('web.service_refund_approve')}
      </Button>
      <Button size="sm" onClick={() => setDrawer('reject')}>
        {t('web.service_refund_reject')}
      </Button>
      {drawer !== null && (
        <DecisionForm
          request={request}
          serviceId={serviceId}
          part={drawer}
          approval={approval}
          rejection={rejection}
          onClose={() => setDrawer(null)}
        />
      )}
    </span>
  );
}

function DecisionForm({
  request,
  serviceId,
  part,
  approval,
  rejection,
  onClose,
}: {
  request: ServiceRefundRequestView;
  serviceId: string;
  part: 'approve' | 'reject';
  approval: SubmissionKey;
  rejection: SubmissionKey;
  onClose: () => void;
}) {
  const notify = useToast();
  const queries = useQueryClient();
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
    // A retried key is answered with the request as it stands NOW (Codex review of #83,
    // round 7): say "deletion started" only while it is, never over a deletion that ended.
    onSuccess: ({ request: decided }) => {
      approval.settle();
      onClose();
      if (decided.state === 'COMPLETED') {
        notify({ tone: 'ok', message: t('web.service_refund_completed_toast') });
      } else if (decided.state === 'FAILED') {
        notify({ tone: 'danger', message: t('web.service_refund_failed_toast') });
      } else {
        notify({ tone: 'ok', message: t('web.service_refund_approved_toast') });
      }
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
      onClose();
      notify({ tone: 'ok', message: t('web.service_refund_rejected_toast') });
      refresh();
    },
    onError: (error) => {
      rejection.settleOn(error);
      refresh();
    },
  });

  const busy = approve.isPending || reject.isPending;
  const dirty = amount.trim() !== '' || reason.trim() !== '' || confirmed;
  // A typed amount or reason is lost by navigating away; the guard asks first.
  useUnsavedChanges(dirty);
  const { requestClose, dialog } = useConfirmedClose(dirty, onClose);
  return (
    <>
      <Drawer
        open
        onClose={requestClose}
        title={t(part === 'approve' ? 'web.service_refund_approve' : 'web.service_refund_reject')}
      >
        {part === 'approve' ? (
          <div className="stack-sm">
            <Field label={t('web.service_refund_amount')} htmlFor="service-refund-amount">
              <Input
                id="service-refund-amount"
                value={amount}
                inputMode="numeric"
                maxLength={19}
                onChange={(event) => setAmount(event.target.value)}
              />
            </Field>
            <Checkbox
              label={t('web.service_refund_confirm')}
              checked={confirmed}
              onChange={setConfirmed}
            />
            {approve.error !== null && (
              <Banner tone="danger">
                {messageFor(approve.error)}
                <ErrorRef error={approve.error} />
              </Banner>
            )}
            <div className="form-actions">
              <Button
                variant="danger"
                disabled={busy || !confirmed || digitsOf(amount) === '0'}
                onClick={() => approve.mutate()}
              >
                {t('web.service_refund_approve')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="stack-sm">
            <Field label={t('web.service_refund_reject_reason')} htmlFor="service-refund-reject">
              <Input
                id="service-refund-reject"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
            {reject.error !== null && (
              <Banner tone="danger">
                {messageFor(reject.error)}
                <ErrorRef error={reject.error} />
              </Banner>
            )}
            <div className="form-actions">
              <Button
                disabled={busy || !isServiceRefundRejectionReason(reason)}
                onClick={() => reject.mutate()}
              >
                {t('web.service_refund_reject')}
              </Button>
            </div>
          </div>
        )}
      </Drawer>
      {dialog}
    </>
  );
}
