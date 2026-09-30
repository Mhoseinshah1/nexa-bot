import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BULK_ITEM_STATES,
  BULK_NOTE_MAX_LENGTH,
  TRAFFIC_GB_PATTERN,
  type BulkGrant,
  type BulkItemState,
  type BulkOperationKind,
  type BulkOperationResponseItem,
  type BulkOperationState,
  type BulkPreview,
  type BulkSkipReason,
  type CustomerNotificationState,
} from '@nexa/contracts';
import {
  ApiError,
  cancelBulkOperation,
  steerBulkOperation,
  createBulkOperation,
  fetchAudienceOptions,
  fetchBulkItems,
  fetchBulkOperation,
  fetchBulkOperations,
  previewBulkOperation,
} from '../api/client';
import { formatNumber, formatTimestamp, formatTrafficGbText } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { navigate, setQuery, useLinkHandler, type Route } from '../router';
import { useSubmissionKey } from '../submission-key';
import {
  Badge,
  Banner,
  Card,
  CursorPager,
  DataTable,
  Empty,
  Field,
  KV,
  Money,
  PageHead,
  StateSwitch,
  Button,
  ConfirmDialog,
  Progress,
  StatCard,
  TwoColumn,
  useToast,
  useUnsavedChanges,
  type Column,
  type Tone,
} from '../ui/kit';
import { Icon } from '../ui/icons';
import { CheckField } from './editor-layout';
import { messageFor } from './settings';
import {
  AudienceBuilder,
  EMPTY_AUDIENCE,
  audienceMessage,
  describeAudience,
  type AudienceDraft,
} from './audience-builder';

/**
 * «عملیات گروهی» — safe mass actions (round N, B2): a mass wallet credit (Mirza's
 * `👥 شارژ همگانی`, with the count, total liability and confirmation Mirza does not have) and
 * a mass traffic or time grant on existing services. Every step ADR-0010 asks for: preview,
 * exact count, total liability for money, a typed confirmation and a reason, then progress
 * and a per-item record. Charged by the server on `users.wallet.mass` / `services.mass.grant`.
 */

const KIND_LABELS: Readonly<Record<BulkOperationKind, WebKey>> = {
  WALLET_CREDIT: 'web.bulk_kind_wallet',
  SERVICE_TRAFFIC: 'web.bulk_kind_traffic',
  SERVICE_TIME: 'web.bulk_kind_time',
};
const STATE_LABELS: Readonly<Record<BulkOperationState, WebKey>> = {
  RUNNING: 'web.bulk_state_running',
  PAUSED: 'web.bulk_state_paused',
  COMPLETED: 'web.bulk_state_completed',
  CANCELLED: 'web.bulk_state_cancelled',
};
const STATE_TONES: Readonly<Record<BulkOperationState, Tone>> = {
  RUNNING: 'warn',
  PAUSED: 'warn',
  COMPLETED: 'ok',
  CANCELLED: 'neutral',
};
/** An operation's state, with a moving dot while it runs. */
function BulkStateBadge({ state }: { state: BulkOperationState }) {
  return (
    <Badge tone={STATE_TONES[state]} dot pulse={state === 'RUNNING'}>
      {t(STATE_LABELS[state])}
    </Badge>
  );
}

const ITEM_LABELS: Readonly<Record<BulkItemState, WebKey>> = {
  PENDING: 'web.bulk_item_pending',
  CREDITED: 'web.bulk_item_credited',
  PLANNED: 'web.bulk_item_planned',
  SUCCEEDED: 'web.bulk_item_succeeded',
  FAILED: 'web.bulk_item_failed',
  SKIPPED: 'web.bulk_item_skipped',
  CANCELLED: 'web.bulk_item_cancelled',
};
/** How often a RUNNING operation's detail and its items are read again. */
export const BULK_LIVE_REFRESH_MS = 5_000;

const NOTICE_LABELS: Readonly<Record<CustomerNotificationState, WebKey>> = {
  PENDING: 'web.bulk_notice_pending',
  DELIVERED: 'web.bulk_notice_delivered',
  UNCONFIRMED: 'web.bulk_notice_unconfirmed',
  FAILED: 'web.bulk_notice_failed',
  SUPERSEDED: 'web.bulk_notice_superseded',
};

const SKIP_LABELS: Readonly<Record<BulkSkipReason, WebKey>> = {
  CUSTOMER_BLOCKED: 'web.bulk_skip_blocked',
  CURRENCY_CHANGED: 'web.bulk_skip_currency',
  SERVICE_NOT_ELIGIBLE: 'web.bulk_skip_state',
  SERVICE_NOT_OWNED: 'web.bulk_skip_owner',
  PANEL_NOT_OPERABLE: 'web.bulk_skip_panel',
  ACTION_IN_PROGRESS: 'web.bulk_skip_in_progress',
  UNLIMITED: 'web.bulk_skip_unlimited',
  LIMIT_EXCEEDED: 'web.bulk_skip_limit',
  REFUND_REQUESTED: 'web.bulk_skip_refund',
  TERMINATION_PENDING: 'web.bulk_skip_termination',
};

export function bulkMessage(error: unknown): string {
  const audience = audienceMessage(error);
  if (audience !== null) return audience;
  if (error instanceof ApiError) {
    const known: Record<string, WebKey> = {
      'bulk.liability_mismatch': 'web.bulk_error_liability',
      'bulk.confirmation_required': 'web.bulk_error_confirmation',
      'bulk.currency_unsupported': 'web.bulk_error_currency',
      'bulk.amount_invalid': 'web.bulk_error_amount',
      'bulk.state_conflict': 'web.bulk_error_state',
    };
    const key = known[error.code];
    if (key !== undefined) return t(key);
  }
  return messageFor(error);
}

function grantText(row: BulkOperationResponseItem) {
  if (row.amount !== null) return <Money value={row.amount} />;
  if (row.trafficBytes !== null) return formatTrafficGbText(BigInt(row.trafficBytes));
  return row.durationDays === null
    ? '—'
    : `${formatNumber(row.durationDays)} ${t('web.bulk_days')}`;
}

export function BulkOperationsPage({
  route,
  denied,
  mayRun,
}: {
  route: Route;
  denied: boolean;
  mayRun: boolean;
}) {
  const onLink = useLinkHandler();
  const cursor = route.query.get('cursor');
  const list = useQuery({
    queryKey: ['bulk-operations', cursor],
    queryFn: () => fetchBulkOperations(cursor === null ? {} : { cursor }),
    enabled: !denied,
  });
  const columns: readonly Column<BulkOperationResponseItem>[] = [
    {
      key: 'kind',
      header: t('web.bulk_kind'),
      render: (row) => (
        <a
          href={`/bulk-operations/${encodeURIComponent(row.id)}`}
          onClick={onLink}
          className="strong"
        >
          {t(KIND_LABELS[row.kind])}
        </a>
      ),
    },
    { key: 'grant', header: t('web.bulk_grant'), render: grantText },
    {
      key: 'state',
      header: t('web.bulk_state'),
      render: (row) => <BulkStateBadge state={row.state} />,
    },
    {
      key: 'items',
      header: t('web.bulk_items'),
      align: 'end',
      render: (row) => <span className="num">{formatNumber(row.itemCount)}</span>,
    },
    {
      key: 'progress',
      header: t('web.bulk_progress'),
      render: (row) => (
        <span className="cb-progress-cell">
          <Progress
            value={row.progressPercent}
            max={100}
            label={t('web.bulk_progress')}
            tone={row.state === 'COMPLETED' ? 'ok' : 'info'}
          />
          <span className="num small">{`${formatNumber(row.progressPercent)}%`}</span>
        </span>
      ),
    },
    {
      key: 'created',
      header: t('web.bulk_created'),
      render: (row) => <span className="nowrap muted small">{formatTimestamp(row.createdAt)}</span>,
    },
  ];
  return (
    <>
      <PageHead
        title={t('web.bulk_page_title')}
        subtitle={t('web.bulk_page_intro')}
        maturity="now"
        actions={
          mayRun ? (
            <a className="btn primary" href="/bulk-operations/new" onClick={onLink}>
              <Icon name="plus" />
              {t('web.bulk_new')}
            </a>
          ) : undefined
        }
      />
      <Card>
        <StateSwitch query={list} denied={denied}>
          {list.data === undefined ? null : list.data.operations.length === 0 ? (
            <Empty title={t('web.bulk_empty')} icon="grid" />
          ) : (
            <>
              <DataTable
                caption={t('web.bulk_page_title')}
                columns={columns}
                rows={list.data.operations}
                rowKey={(row) => row.id}
                dense
              />
              <CursorPager
                shown={list.data.operations.length}
                hasPrevious={cursor !== null}
                hasNext={list.data.nextCursor !== null}
                onPrevious={() => setQuery(route, 'cursor', null)}
                onNext={() => setQuery(route, 'cursor', list.data?.nextCursor ?? null)}
              />
            </>
          )}
        </StateSwitch>
      </Card>
    </>
  );
}

/** The new mass operation: what to give, to whom, a preview, and the destructive confirmation. */
export function BulkOperationNewPage({
  mayWallet,
  mayGrant,
}: {
  mayWallet: boolean;
  mayGrant: boolean;
}) {
  const options = useQuery({ queryKey: ['audience-options'], queryFn: fetchAudienceOptions });
  const client = useQueryClient();
  const toast = useToast();
  const submission = useSubmissionKey();
  const [kind, setKind] = useState<BulkOperationKind>(
    mayWallet ? 'WALLET_CREDIT' : 'SERVICE_TRAFFIC',
  );
  const [amount, setAmount] = useState('');
  const [traffic, setTraffic] = useState('');
  const [days, setDays] = useState('');
  const [audience, setAudience] = useState<AudienceDraft>(EMPTY_AUDIENCE);
  const [notify, setNotify] = useState(true);
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<BulkPreview | null>(null);
  const [typed, setTyped] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  /** The final question, asked in a dialog once everything above is filled in. */
  const [asking, setAsking] = useState(false);
  const dirty =
    amount !== '' ||
    traffic !== '' ||
    days !== '' ||
    note !== '' ||
    JSON.stringify(audience) !== JSON.stringify(EMPTY_AUDIENCE);
  useUnsavedChanges(dirty);

  const currency = options.data?.currency ?? 'IRT';
  const grant = (): BulkGrant | null => {
    if (kind === 'WALLET_CREDIT') {
      return /^[1-9]\d{0,17}$/u.test(amount)
        ? { kind, amountMinor: amount, currency: currency as never }
        : null;
    }
    if (kind === 'SERVICE_TRAFFIC') {
      return TRAFFIC_GB_PATTERN.test(traffic) ? { kind, trafficGb: traffic } : null;
    }
    const value = Number(days);
    return Number.isInteger(value) && value > 0 ? { kind, durationDays: value } : null;
  };
  const reset = () => {
    setPreview(null);
    setTyped('');
    setConfirmed(false);
  };
  const load = useMutation({
    mutationFn: () => {
      const g = grant();
      if (g === null) throw new Error('grant');
      return previewBulkOperation({ grant: g, definition: audience });
    },
    onSuccess: (response) => {
      setPreview(response.preview);
      setTyped('');
      setConfirmed(false);
    },
  });
  const execute = useMutation({
    mutationFn: () => {
      const g = grant();
      if (g === null || preview === null) throw new Error('preview');
      const input = {
        grant: g,
        definition: audience,
        notify,
        note,
        expectedDefinitionHash: preview.definitionHash,
        expectedCount: preview.count,
        expectedFingerprint: preview.fingerprint,
        expectedTotalMinor: preview.totalLiability?.amountMinor ?? null,
        typedCount: Number(typed),
        notBefore: null,
      };
      return createBulkOperation({ ...input, idempotencyKey: submission.current(input) });
    },
    onSuccess: (response) => {
      submission.settle();
      toast({ tone: 'ok', message: t('web.bulk_started') });
      void client.invalidateQueries({ queryKey: ['bulk-operations'] });
      // Started: the form's work is done, so leaving it is not leaving unsaved work.
      navigate(`/bulk-operations/${encodeURIComponent(response.operation.id)}`, { force: true });
    },
    onError: (error) => {
      submission.settleOn(error);
      reset();
    },
  });
  const ready =
    preview !== null &&
    preview.count > 0 &&
    confirmed &&
    typed.trim() === String(preview.count) &&
    note.trim() !== '';

  if (!mayWallet && !mayGrant) {
    return (
      <Card>
        <Banner tone="info">{t('web.no_permission')}</Banner>
      </Card>
    );
  }

  return (
    <>
      <PageHead title={t('web.bulk_new')} subtitle={t('web.bulk_page_intro')} />
      <Card title={t('web.bulk_what')}>
        <div className="form-grid">
          <Field label={t('web.bulk_kind')} htmlFor="bulk-kind">
            <select
              id="bulk-kind"
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as BulkOperationKind);
                reset();
              }}
            >
              {mayWallet && <option value="WALLET_CREDIT">{t('web.bulk_kind_wallet')}</option>}
              {mayGrant && <option value="SERVICE_TRAFFIC">{t('web.bulk_kind_traffic')}</option>}
              {mayGrant && <option value="SERVICE_TIME">{t('web.bulk_kind_time')}</option>}
            </select>
          </Field>
          {kind === 'WALLET_CREDIT' && (
            <Field
              label={t('web.bulk_amount')}
              htmlFor="bulk-amount"
              hint={t('web.bulk_amount_hint')}
            >
              <input
                id="bulk-amount"
                inputMode="numeric"
                value={amount}
                onChange={(event) => {
                  setAmount(event.target.value.trim());
                  reset();
                }}
              />
            </Field>
          )}
          {kind === 'SERVICE_TRAFFIC' && (
            <Field
              label={t('web.bulk_traffic')}
              htmlFor="bulk-traffic"
              hint={t('web.bulk_traffic_hint')}
            >
              <input
                id="bulk-traffic"
                inputMode="decimal"
                value={traffic}
                onChange={(event) => {
                  setTraffic(event.target.value.trim());
                  reset();
                }}
              />
            </Field>
          )}
          {kind === 'SERVICE_TIME' && (
            <Field label={t('web.bulk_days_label')} htmlFor="bulk-days">
              <input
                id="bulk-days"
                inputMode="numeric"
                value={days}
                onChange={(event) => {
                  setDays(event.target.value.trim());
                  reset();
                }}
              />
            </Field>
          )}
        </div>
        {kind !== 'WALLET_CREDIT' && <p className="muted small">{t('web.bulk_grant_hint')}</p>}
        <CheckField
          id="bulk-notify"
          label={t('web.bulk_notify')}
          checked={notify}
          onChange={setNotify}
        />
      </Card>
      <Card title={t('web.bulk_audience')}>
        <AudienceBuilder
          value={audience}
          onChange={(next) => {
            setAudience(next);
            reset();
          }}
        />
      </Card>
      <Card title={t('web.bulk_preview')} hint={t('web.bulk_preview_hint')}>
        <div className="form-actions">
          <Button
            icon="users"
            disabled={grant() === null || load.isPending}
            onClick={() => load.mutate()}
          >
            {t('web.bulk_preview_button')}
          </Button>
        </div>
        {load.error !== null && <Banner tone="danger">{bulkMessage(load.error)}</Banner>}
        {preview !== null && (
          <>
            <div className="stat-grid cb-stat-row">
              <StatCard
                label={
                  preview.kind === 'WALLET_CREDIT'
                    ? t('web.bulk_count_customers')
                    : t('web.bulk_count_services')
                }
                value={formatNumber(preview.count)}
              />
              <StatCard
                label={t('web.bulk_count_distinct')}
                value={formatNumber(preview.customers)}
              />
              {preview.totalLiability !== null && (
                <StatCard
                  label={t('web.bulk_liability')}
                  value={<Money value={preview.totalLiability} />}
                  tone="warn"
                />
              )}
              <StatCard
                label={t('web.bc_as_of')}
                value={<span className="cb-stat-note">{formatTimestamp(preview.asOf)}</span>}
              />
            </div>
            <DataTable
              caption={t('web.bulk_sample')}
              columns={[
                {
                  key: 'who',
                  header: t('web.bc_customer'),
                  render: (row) => row.firstName ?? row.username ?? row.customerId.slice(0, 8),
                },
                {
                  key: 'service',
                  header: t('web.bulk_service'),
                  render: (row) => row.serviceLabel ?? '—',
                },
              ]}
              rows={preview.sample}
              rowKey={(row) => row.serviceId ?? row.customerId}
              dense
            />
            {preview.count === 0 ? (
              <Banner tone="info">{t('web.aud_error_empty')}</Banner>
            ) : (
              <div className="bulk-danger stack-sm">
                <Banner tone="danger">{t('web.bulk_danger')}</Banner>
                <div className="form-grid">
                  <Field label={t('web.bulk_reason')} htmlFor="bulk-note">
                    <input
                      id="bulk-note"
                      value={note}
                      maxLength={BULK_NOTE_MAX_LENGTH}
                      onChange={(event) => setNote(event.target.value)}
                    />
                  </Field>
                  <Field label={t('web.bulk_typed')} htmlFor="bulk-typed">
                    <input
                      id="bulk-typed"
                      inputMode="numeric"
                      value={typed}
                      onChange={(event) => setTyped(event.target.value)}
                    />
                  </Field>
                </div>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={() => setConfirmed(!confirmed)}
                  />{' '}
                  {t('web.bulk_confirm_check')}
                </label>
                <div className="form-actions">
                  <Button
                    variant="danger-solid"
                    icon="zap"
                    disabled={!ready || execute.isPending}
                    onClick={() => setAsking(true)}
                  >
                    {t('web.bulk_execute')}
                  </Button>
                </div>
                {asking && (
                  <ConfirmDialog
                    title={t(KIND_LABELS[kind])}
                    question={t('web.cb_bulk_run_question').replace(
                      '{count}',
                      formatNumber(preview.count),
                    )}
                    detail={t('web.bulk_danger')}
                    confirmLabel={t('web.cb_bulk_run_yes')}
                    cancelLabel={t('web.cb_cancel')}
                    onConfirm={() => {
                      setAsking(false);
                      execute.mutate();
                    }}
                    onCancel={() => setAsking(false)}
                  />
                )}
              </div>
            )}
          </>
        )}
        {execute.error !== null && <Banner tone="danger">{bulkMessage(execute.error)}</Banner>}
      </Card>
    </>
  );
}

export function BulkOperationDetailPage({
  id,
  denied,
  mayWallet,
  mayGrant,
}: {
  id: string;
  denied: boolean;
  mayWallet: boolean;
  mayGrant: boolean;
}) {
  const client = useQueryClient();
  const detail = useQuery({
    queryKey: ['bulk-operation', id],
    queryFn: () => fetchBulkOperation(id),
    enabled: !denied,
    refetchInterval: (query) =>
      query.state.data?.operation.state === 'RUNNING' ? BULK_LIVE_REFRESH_MS : false,
  });
  const operationState = detail.data?.operation.state;
  const [cancelAsked, setCancelAsked] = useState(false);
  const cancel = useMutation({
    mutationFn: () => cancelBulkOperation(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['bulk-operation', id] }),
  });
  // Round N close (§B): pause claims nothing new; resume continues from exactly there.
  const steer = useMutation({
    mutationFn: (action: 'pause' | 'resume') => steerBulkOperation(id, action),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['bulk-operation', id] }),
  });
  const [state, setState] = useState<BulkItemState | ''>('');
  const [trail, setTrail] = useState<string[]>([]);
  const cursor = trail[trail.length - 1];
  const items = useQuery({
    queryKey: ['bulk-items', id, state, cursor],
    queryFn: () =>
      fetchBulkItems(id, {
        ...(state === '' ? {} : { state }),
        ...(cursor === undefined ? {} : { cursor }),
      }),
    enabled: !denied,
    // Refreshed WITH the detail while running, and once more when the operation leaves a
    // state, so the item page never stays at what it was before it finished (Codex R7).
    refetchInterval: operationState === 'RUNNING' ? BULK_LIVE_REFRESH_MS : false,
  });
  const seenState = useRef(operationState);
  useEffect(() => {
    if (seenState.current !== undefined && seenState.current !== operationState) {
      void client.invalidateQueries({ queryKey: ['bulk-items', id] });
    }
    seenState.current = operationState;
  }, [operationState, client, id]);
  const op = detail.data?.operation;
  const mayCancel = op !== undefined && (op.kind === 'WALLET_CREDIT' ? mayWallet : mayGrant);
  return (
    <StateSwitch query={detail} denied={denied}>
      {op === undefined ? null : (
        <>
          <PageHead
            title={t(KIND_LABELS[op.kind])}
            badge={<BulkStateBadge state={op.state} />}
            subtitle={
              <span className="cb-meta">
                <span>{grantText(op)}</span>
                <span>{formatTimestamp(op.createdAt)}</span>
              </span>
            }
          />
          <div className="stat-grid cb-stat-row">
            <StatCard label={t('web.bulk_items')} value={formatNumber(op.itemCount)} />
            <StatCard
              label={t('web.bulk_item_succeeded')}
              value={formatNumber(op.counts.succeeded)}
            />
            <StatCard
              label={t('web.bulk_item_credited')}
              value={formatNumber(op.counts.credited)}
            />
            <StatCard
              label={t('web.bulk_item_failed')}
              value={formatNumber(op.counts.failed)}
              {...(op.counts.failed > 0 ? { tone: 'alert' as const } : {})}
            />
            {op.totalLiability !== null && (
              <StatCard
                label={t('web.bulk_liability')}
                value={<Money value={op.totalLiability} />}
              />
            )}
          </div>
          <TwoColumn
            main={
              <Card title={t('web.bulk_report')}>
                <div className="cb-progress-line">
                  <Progress
                    value={op.progressPercent}
                    max={100}
                    label={t('web.bulk_progress')}
                    tone={op.state === 'COMPLETED' ? 'ok' : 'info'}
                    size="lg"
                  />
                  <span className="num">{`${formatNumber(op.progressPercent)}%`}</span>
                </div>
                <KV
                  items={[
                    [t('web.bulk_state'), t(STATE_LABELS[op.state])],
                    [t('web.bulk_grant'), grantText(op)],
                    [t('web.bulk_items'), formatNumber(op.itemCount)],
                    ...(op.totalLiability === null
                      ? []
                      : ([
                          [t('web.bulk_liability'), <Money key="l" value={op.totalLiability} />],
                          [
                            t('web.bulk_credited_total'),
                            op.creditedTotal === null ? (
                              '—'
                            ) : (
                              <Money key="c" value={op.creditedTotal} />
                            ),
                          ],
                        ] as [string, ReactNode | string][])),
                    [t('web.bulk_item_pending'), formatNumber(op.counts.pending)],
                    [t('web.bulk_item_credited'), formatNumber(op.counts.credited)],
                    [t('web.bulk_item_planned'), formatNumber(op.counts.planned)],
                    [
                      t('web.bulk_awaiting_reconciliation'),
                      formatNumber(op.counts.awaitingReconciliation),
                    ],
                    [t('web.bulk_item_succeeded'), formatNumber(op.counts.succeeded)],
                    [t('web.bulk_item_failed'), formatNumber(op.counts.failed)],
                    [t('web.bulk_item_skipped'), formatNumber(op.counts.skipped)],
                    [t('web.bulk_item_cancelled'), formatNumber(op.counts.cancelled)],
                    [t('web.bulk_notified'), formatNumber(op.counts.notified)],
                    [t('web.bulk_notice_queued'), formatNumber(op.counts.notificationQueued)],
                    [t('web.bulk_progress'), `${formatNumber(op.progressPercent)}%`],
                  ]}
                />
              </Card>
            }
            side={
              <>
                <Card title={t('web.bc_summary')}>
                  <KV
                    items={[
                      [t('web.bulk_reason'), op.note],
                      [t('web.bc_created_by'), op.createdBy?.username ?? '—'],
                      [t('web.bulk_created'), formatTimestamp(op.createdAt)],
                      [
                        t('web.bulk_not_before'),
                        op.notBefore === null ? '—' : formatTimestamp(op.notBefore),
                      ],
                      [t('web.bc_as_of'), formatTimestamp(op.audienceAsOf)],
                    ]}
                  />
                  <h3>{t('web.bc_filters')}</h3>
                  {op.frozenAudienceId !== null && (
                    <p className="muted small">{t('web.bulk_frozen_audience')}</p>
                  )}
                  <ul className="small">
                    {describeAudience(op.audience).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </Card>
                <Card title={t('web.cb_steering')} tone="danger">
                  <p className="muted small">{t('web.bulk_cancel_note')}</p>
                  <p className="muted small">{t('web.bulk_pause_note')}</p>
                  {mayCancel && (op.state === 'RUNNING' || op.state === 'PAUSED') && (
                    <div className="form-actions">
                      {op.state === 'RUNNING' && (
                        <Button
                          size="sm"
                          icon="pause"
                          disabled={steer.isPending}
                          onClick={() => steer.mutate('pause')}
                        >
                          {t('web.bulk_pause')}
                        </Button>
                      )}
                      {op.state === 'PAUSED' && (
                        <Button
                          size="sm"
                          icon="play"
                          disabled={steer.isPending}
                          onClick={() => steer.mutate('resume')}
                        >
                          {t('web.bulk_resume')}
                        </Button>
                      )}
                      <Button size="sm" variant="danger" onClick={() => setCancelAsked(true)}>
                        {t('web.bulk_cancel')}
                      </Button>
                    </div>
                  )}
                  {cancel.error !== null && (
                    <Banner tone="danger">{bulkMessage(cancel.error)}</Banner>
                  )}
                  {steer.error !== null && (
                    <Banner tone="danger">{bulkMessage(steer.error)}</Banner>
                  )}
                </Card>
              </>
            }
          />
          {cancelAsked && (
            <ConfirmDialog
              title={t(KIND_LABELS[op.kind])}
              question={t('web.bulk_cancel_question')}
              confirmLabel={t('web.bc_cancel_confirm')}
              cancelLabel={t('web.bc_back')}
              onConfirm={() => {
                setCancelAsked(false);
                cancel.mutate();
              }}
              onCancel={() => setCancelAsked(false)}
            />
          )}
          <Card title={t('web.bulk_items')}>
            <div className="toolbar">
              <Field label={t('web.bulk_state')} htmlFor="bulk-item-state" compact>
                <select
                  id="bulk-item-state"
                  value={state}
                  onChange={(event) => {
                    setState(event.target.value as BulkItemState | '');
                    setTrail([]);
                  }}
                >
                  <option value="">{t('web.aud_any')}</option>
                  {BULK_ITEM_STATES.map((option) => (
                    <option key={option} value={option}>
                      {t(ITEM_LABELS[option])}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <StateSwitch query={items}>
              {items.data === undefined ? null : (
                <>
                  <DataTable
                    caption={t('web.bulk_items')}
                    columns={[
                      {
                        key: 'who',
                        header: t('web.bc_customer'),
                        render: (row) =>
                          row.firstName ?? row.username ?? row.customerId.slice(0, 8),
                      },
                      {
                        key: 'service',
                        header: t('web.bulk_service'),
                        render: (row) => row.serviceLabel ?? '—',
                      },
                      {
                        key: 'state',
                        header: t('web.bulk_state'),
                        render: (row) =>
                          row.state === 'PLANNED' && row.operationState === 'UNKNOWN'
                            ? t('web.bulk_awaiting_reconciliation')
                            : t(ITEM_LABELS[row.state]),
                      },
                      {
                        key: 'why',
                        header: t('web.bulk_why'),
                        render: (row) =>
                          row.skipReason !== null ? (
                            t(SKIP_LABELS[row.skipReason])
                          ) : row.failureKind !== null ? (
                            <code>{row.failureKind}</code>
                          ) : (
                            '—'
                          ),
                      },
                      {
                        key: 'notice',
                        header: t('web.bulk_notice'),
                        // The lane's own state: enqueued is not told (Codex R4).
                        render: (row) =>
                          row.notificationState === null
                            ? '—'
                            : t(NOTICE_LABELS[row.notificationState]),
                      },
                    ]}
                    rows={items.data.items}
                    rowKey={(row) => row.id}
                    dense
                  />
                  <CursorPager
                    shown={items.data.items.length}
                    hasPrevious={trail.length > 0}
                    hasNext={items.data.nextCursor !== null}
                    onPrevious={() => setTrail(trail.slice(0, -1))}
                    onNext={() =>
                      items.data?.nextCursor !== null && items.data?.nextCursor !== undefined
                        ? setTrail([...trail, items.data.nextCursor])
                        : undefined
                    }
                  />
                </>
              )}
            </StateSwitch>
          </Card>
        </>
      )}
    </StateSwitch>
  );
}
