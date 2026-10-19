import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { keepPageWhileTurning } from '../ui/paging';
import {
  LEGACY_CUTOVER_APPROVAL_KINDS,
  type LegacyCutoverApplyRunView,
  type LegacyCutoverApprovalKind,
  type LegacyCutoverApprovalView,
  type LegacyCutoverReadSetView,
} from '@nexa/contracts';
import {
  ApiError,
  approveLegacyCutover,
  fetchLegacyCutoverApplyRuns,
  fetchLegacyCutoverApprovals,
  fetchLegacyCutoverReadSets,
  revokeLegacyCutover,
} from '../api/client';
import { formatTimestamp } from '../format';
import { LegacyCode } from './code-name';
import { Modal } from '../ui/overlays';
import { Icon } from '../ui/icons';
import { LEGACY_IMPORT_RUN_STATUS_LABELS } from './mirza-labels';
import { t, type WebKey } from '../i18n/web.fa';
import { useSubmissionKey, type SubmissionKey } from '../submission-key';
import { queryState } from '../view-state';
import { messageFor } from './settings';
import {
  Badge,
  Banner,
  Card,
  CellMain,
  CursorPager,
  DataTable,
  Empty,
  Field,
  Input,
  Ltr,
  PageHead,
  RowActions,
  Select,
  StateSwitch,
  useToast,
  type Column,
} from '../ui/kit';
import { ErrorRef } from '../ui/technical-details';

/**
 * Mirza migration PR6 — the owner's cutover approval (owner constraint 3).
 *
 * The owner records, in the database, that ONE frozen legacy snapshot may be imported,
 * bound to seven exact values the operator's runbook produced: the source fingerprint, the
 * panel-map fingerprint, the three read-set fingerprints NEXA recorded for that source, the
 * freeze proof file's SHA-256 and the final dump's SHA-256. The import refuses without an
 * unrevoked approval matching every one; any changed value voids it. Nothing is imported
 * from here. Values are sent EXACTLY as typed — never trimmed — so a pasted space is a
 * refusal, not a silent fix. Fingerprints and digests only: no legacy row is shown.
 */

const KIND_LABELS: Readonly<Record<LegacyCutoverApprovalKind, WebKey>> = {
  CUTOVER: 'web.lco_kind_cutover',
  RERUN_OVER_PRIOR_IMPORT: 'web.lco_kind_rerun',
};

const FAULTS: Readonly<Record<string, WebKey>> = {
  'legacy_cutover.read_set_not_recorded': 'web.lco_fault_read_set',
  'legacy_cutover.read_set_evidence_mixed': 'web.lco_fault_mixed',
  'legacy_cutover.no_prior_import': 'web.lco_fault_no_prior',
  'legacy_cutover.already_approved': 'web.lco_fault_already',
  'legacy_cutover.already_revoked': 'web.lco_fault_revoked',
  'legacy_cutover.not_found': 'web.lco_fault_not_found',
  'legacy_cutover.scope_stopped': 'web.lco_fault_stopped',
};

export function legacyCutoverFault(error: unknown): string {
  if (error instanceof ApiError) {
    const key = FAULTS[error.code];
    if (key !== undefined) return t(key);
  }
  return messageFor(error);
}

const HEX = /^[0-9a-f]{64}$/u;

/** The seven bound values, in the runbook's order, with their labels. */
const FIELDS = [
  ['sourceFingerprint', 'web.lco_field_source'],
  ['panelMapFingerprint', 'web.lco_field_panel_map'],
  ['inventoryFingerprint', 'web.lco_field_inventory'],
  ['productsFingerprint', 'web.lco_field_products'],
  ['invoiceArchiveFingerprint', 'web.lco_field_invoice_archive'],
  ['freezeProofSha256', 'web.lco_field_freeze'],
  ['finalDumpSha256', 'web.lco_field_dump'],
] as const satisfies readonly (readonly [string, WebKey])[];

type FieldName = (typeof FIELDS)[number][0];

/** A cursor-paged list: the trail of `after` values, so every page is reachable. */
function usePaged<T>(key: string, fetch: (after?: string) => Promise<T>, enabled: boolean) {
  const [trail, setTrail] = useState<readonly string[]>([]);
  const after = trail[trail.length - 1];
  const query = useQuery(
    keepPageWhileTurning({
      queryKey: ['legacy-cutover', key, after ?? null],
      queryFn: () => fetch(after),
      enabled,
    }),
  );
  return { query, trail, setTrail };
}

export function LegacyCutoverPage({
  denied,
  mayApprove,
}: {
  /** `legacy.cutover.view` is not held. */
  denied: boolean;
  /** `legacy.cutover.approve` (CRITICAL). */
  mayApprove: boolean;
}) {
  /** W3: the owner's approval form opens in a dialog from the page head. */
  const [approving, setApproving] = useState(false);
  /** The dialog's submission key, held while the dialog mounts and unmounts. */
  const approveKey = useSubmissionKey();
  const approvals = usePaged('approvals', (after) => fetchLegacyCutoverApprovals(after), !denied);
  const readSets = usePaged('read-sets', (after) => fetchLegacyCutoverReadSets(after), !denied);
  const runs = usePaged('apply-runs', (after) => fetchLegacyCutoverApplyRuns(after), !denied);
  const approvalRows = approvals.query.data?.approvals ?? [];

  const approvalColumns: readonly Column<LegacyCutoverApprovalView>[] = [
    {
      key: 'kind',
      header: t('web.lco_col_kind'),
      render: (row) => (
        <CellMain
          primary={t(KIND_LABELS[row.kind])}
          secondary={<span className="muted small">{formatTimestamp(row.approvedAt)}</span>}
        />
      ),
    },
    {
      key: 'source',
      header: t('web.lco_field_source'),
      render: (row) => <Hash value={row.sourceFingerprint} />,
    },
    {
      key: 'state',
      header: t('web.lco_col_state'),
      render: (row) => (
        <>
          {row.revocation === null ? (
            <Badge tone="ok">{t('web.lco_state_active')}</Badge>
          ) : (
            <Badge tone="neutral">{t('web.lco_state_revoked')}</Badge>
          )}{' '}
          {row.synthetic && <Badge tone="warn">{t('web.lco_synthetic')}</Badge>}
        </>
      ),
    },
    {
      key: 'actions',
      header: t('web.lco_col_actions'),
      align: 'end',
      render: (row) =>
        mayApprove && row.revocation === null ? (
          <RowActions>
            <Revoke row={row} />
          </RowActions>
        ) : null,
    },
  ];

  const readSetColumns: readonly Column<LegacyCutoverReadSetView>[] = [
    {
      key: 'readSet',
      header: t('web.lco_col_read_set'),
      render: (row) => (
        <CellMain
          primary={<Ltr>{row.fingerprintVersion}</Ltr>}
          secondary={<span className="muted small">{formatTimestamp(row.recordedAt)}</span>}
        />
      ),
    },
    {
      key: 'fingerprint',
      header: t('web.lco_col_fingerprint'),
      render: (row) => <Hash value={row.readSetFingerprint} />,
    },
    {
      key: 'source',
      header: t('web.lco_field_source'),
      render: (row) => (
        <>
          <Hash value={row.sourceFingerprint} />{' '}
          {row.synthetic && <Badge tone="warn">{t('web.lco_synthetic')}</Badge>}
        </>
      ),
    },
  ];

  const runColumns: readonly Column<LegacyCutoverApplyRunView>[] = [
    {
      key: 'run',
      header: t('web.lco_col_run'),
      render: (row) => (
        <CellMain
          primary={<LegacyCode value={row.status} labels={LEGACY_IMPORT_RUN_STATUS_LABELS} />}
          secondary={<span className="muted small">{formatTimestamp(row.startedAt)}</span>}
        />
      ),
    },
    {
      key: 'source',
      header: t('web.lco_field_source'),
      render: (row) => <Hash value={row.sourceFingerprint} />,
    },
  ];

  return (
    <>
      <PageHead
        title={t('web.lco_title')}
        subtitle={t('web.lco_subtitle')}
        {...(mayApprove && !denied
          ? {
              actions: (
                <button type="button" className="btn primary" onClick={() => setApproving(true)}>
                  <Icon name="check" />
                  {t('web.lco_approve_title')}
                </button>
              ),
            }
          : {})}
      />
      <Modal
        open={mayApprove && !denied && approving}
        onClose={() => setApproving(false)}
        title={t('web.lco_approve_title')}
        size="lg"
      >
        <ApproveForm held={approveKey} onDone={() => setApproving(false)} />
      </Modal>
      <Banner tone="warn">{t('web.lco_banner')}</Banner>
      {/* The approvals are a card whose empty state sits inside it, as the demo draws it. */}
      <Card title={t('web.lco_approvals_title')}>
        <StateSwitch
          query={approvals.query}
          denied={denied}
          isEmpty={
            queryState(approvals.query) === 'ready' &&
            approvalRows.length === 0 &&
            approvals.trail.length === 0
          }
          empty={<Empty title={t('web.lco_empty')} hint={t('web.lco_empty_hint')} />}
        >
          <DataTable
            stack="labelled"
            columns={approvalColumns}
            rows={approvalRows}
            rowKey={(row) => row.id}
            caption={t('web.lco_approvals_title')}
          />
          <Pager
            paged={approvals}
            next={approvals.query.data?.nextCursor ?? null}
            shown={approvalRows.length}
          />
        </StateSwitch>
      </Card>
      {!denied && (
        <>
          <Card title={t('web.lco_read_sets_title')}>
            <DataTable
              stack="labelled"
              columns={readSetColumns}
              rows={readSets.query.data?.readSets ?? []}
              rowKey={(row) => row.id}
              caption={t('web.lco_read_sets_title')}
            />
            <Pager
              paged={readSets}
              next={readSets.query.data?.nextCursor ?? null}
              shown={readSets.query.data?.readSets.length ?? 0}
            />
          </Card>
          <Card title={t('web.lco_runs_title')}>
            <DataTable
              stack="labelled"
              columns={runColumns}
              rows={runs.query.data?.runs ?? []}
              rowKey={(row) => row.id}
              caption={t('web.lco_runs_title')}
            />
            <Pager
              paged={runs}
              next={runs.query.data?.nextCursor ?? null}
              shown={runs.query.data?.runs.length ?? 0}
            />
          </Card>
          {!mayApprove && <Banner tone="info">{t('web.lco_view_only')}</Banner>}
        </>
      )}
    </>
  );
}

/** A 64-digit fingerprint in a list: the demo's small code face, so two fit one row. */
function Hash({ value }: { value: string }) {
  return (
    <Ltr>
      <span className="lgr-hash">{value}</span>
    </Ltr>
  );
}

function Pager({
  paged,
  next,
  shown,
}: {
  paged: { trail: readonly string[]; setTrail: (t: readonly string[]) => void };
  next: string | null;
  shown: number;
}) {
  return (
    <CursorPager
      // Every list here is `id` ascending over uuid v7 ids: oldest first.
      order="oldest-first"
      shown={shown}
      hasPrevious={paged.trail.length > 0}
      hasNext={next !== null}
      onPrevious={() => paged.setTrail(paged.trail.slice(0, -1))}
      onNext={() => next !== null && paged.setTrail([...paged.trail, next])}
    />
  );
}

/**
 * Record an approval. Every value exactly as the runbook printed it. W3: drawn inside the
 * dialog the page head's "record owner approval" opens; a recorded approval closes it.
 */
export function ApproveForm({
  onDone,
  held,
}: {
  onDone?: () => void;
  /** The key, held by the page so a retry after a 5xx survives closing the dialog. */
  held?: SubmissionKey | undefined;
} = {}) {
  const queries = useQueryClient();
  const notify = useToast();
  const own = useSubmissionKey();
  const submission = held ?? own;
  const [kind, setKind] = useState<LegacyCutoverApprovalKind>('CUTOVER');
  const [values, setValues] = useState<Readonly<Record<FieldName, string>>>({
    sourceFingerprint: '',
    panelMapFingerprint: '',
    inventoryFingerprint: '',
    productsFingerprint: '',
    invoiceArchiveFingerprint: '',
    freezeProofSha256: '',
    finalDumpSha256: '',
  });
  const [prior, setPrior] = useState('');
  const [reason, setReason] = useState('');

  const approve = useMutation({
    mutationFn: () => {
      const body = {
        kind,
        ...values,
        priorSourceFingerprint: kind === 'RERUN_OVER_PRIOR_IMPORT' ? prior : null,
        reason: reason.trim(),
      };
      return approveLegacyCutover({ ...body, idempotencyKey: submission.current(body) });
    },
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.lco_saved') });
      void queries.invalidateQueries({ queryKey: ['legacy-cutover'] });
      onDone?.();
    },
    onError: (error: unknown) => {
      submission.settleOn(error);
    },
  });
  // Verbatim: a value with a stray space or a capital letter is NOT valid, and is not fixed.
  const allHex =
    FIELDS.every(([name]) => HEX.test(values[name])) &&
    (kind === 'CUTOVER' || (HEX.test(prior) && prior !== values.sourceFingerprint));
  const ready = allHex && reason.trim() !== '' && !approve.isPending;

  return (
    <div className="stack">
      <Banner tone="danger">{t('web.lco_approve_warning')}</Banner>
      <Field label={t('web.lco_col_kind')} htmlFor="lco-kind">
        <Select
          id="lco-kind"
          value={kind}
          onChange={(event) => setKind(event.target.value as LegacyCutoverApprovalKind)}
        >
          {LEGACY_CUTOVER_APPROVAL_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(KIND_LABELS[k])}
            </option>
          ))}
        </Select>
      </Field>
      {FIELDS.map(([name, label]) => (
        <Field key={name} label={t(label)} htmlFor={`lco-${name}`} hint={t('web.lco_hex_hint')}>
          <Input
            id={`lco-${name}`}
            dir="ltr"
            value={values[name]}
            maxLength={64}
            onChange={(event) => setValues({ ...values, [name]: event.target.value })}
          />
        </Field>
      ))}
      {kind === 'RERUN_OVER_PRIOR_IMPORT' && (
        <Field label={t('web.lco_field_prior')} htmlFor="lco-prior" hint={t('web.lco_prior_hint')}>
          <Input
            id="lco-prior"
            dir="ltr"
            value={prior}
            maxLength={64}
            onChange={(event) => setPrior(event.target.value)}
          />
        </Field>
      )}
      <Field label={t('web.lco_reason')} htmlFor="lco-reason">
        <Input
          id="lco-reason"
          value={reason}
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
      <div className="form-actions">
        <button
          type="button"
          className="btn primary sm"
          disabled={!ready}
          onClick={() => approve.mutate()}
        >
          {t('web.lco_approve')}
        </button>
      </div>
      {approve.error !== null && (
        <Banner tone="danger" role="alert">
          {legacyCutoverFault(approve.error)}
          <ErrorRef error={approve.error} />
        </Banner>
      )}
    </div>
  );
}

function Revoke({ row }: { row: LegacyCutoverApprovalView }) {
  const queries = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  const revoke = useMutation({
    mutationFn: () =>
      revokeLegacyCutover({
        id: row.id,
        idempotencyKey: submission.current({ id: row.id, reason: reason.trim() }),
        reason: reason.trim(),
      }),
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.lco_revoked') });
      setOpen(false);
      void queries.invalidateQueries({ queryKey: ['legacy-cutover'] });
    },
    onError: (error: unknown) => {
      submission.settleOn(error);
    },
  });
  /* W3: the row's "revoke" opens a dialog with the approval, the reason and the refusal. */
  return (
    <>
      <button type="button" className="btn ghost sm" onClick={() => setOpen(true)}>
        {t('web.lco_revoke')}
      </button>
      <Modal
        open={open}
        onClose={() => {
          setOpen(false);
          revoke.reset();
        }}
        title={t('web.lco_revoke')}
        danger
        foot={
          <>
            <button type="button" className="btn sm" onClick={() => setOpen(false)}>
              {t('web.money_cancel')}
            </button>
            <button
              type="button"
              className="btn danger sm"
              disabled={reason.trim() === '' || revoke.isPending}
              onClick={() => revoke.mutate()}
            >
              {t('web.lco_revoke')}
            </button>
          </>
        }
      >
        <div className="stack">
          <dl className="kv small">
            <dt>{t('web.lco_col_kind')}</dt>
            <dd>{t(KIND_LABELS[row.kind])}</dd>
            <dt>{t('web.lco_field_source')}</dt>
            <dd>
              <Ltr>{row.sourceFingerprint}</Ltr>
            </dd>
          </dl>
          <Field label={t('web.lco_reason')} htmlFor={`lco-revoke-${row.id}`}>
            <Input
              id={`lco-revoke-${row.id}`}
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          {revoke.error !== null && (
            <Banner tone="danger" role="alert">
              {legacyCutoverFault(revoke.error)}
              <ErrorRef error={revoke.error} />
            </Banner>
          )}
        </div>
      </Modal>
    </>
  );
}
