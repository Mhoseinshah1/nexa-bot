import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LEGACY_SERVICE_ADOPTABLE_OUTCOMES,
  LEGACY_SERVICE_OUTCOMES,
  LEGACY_SERVICE_REOPENABLE_STATES,
  LEGACY_SERVICE_REVIEW_STATES,
  type LegacyServiceCandidateDetailResponse,
  type LegacyServiceCandidateView,
  type LegacyServiceOutcome,
  type LegacyServiceReviewDecision,
  type LegacyServiceReviewState,
} from '@nexa/contracts';
import {
  ApiError,
  approveLegacyServiceAdoption,
  decideLegacyService,
  fetchLegacyService,
  fetchLegacyServiceSummary,
  fetchLegacyServices,
  fetchPanels,
  reopenLegacyService,
} from '../api/client';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { useSubmissionKey } from '../submission-key';
import { queryState } from '../view-state';
import { messageFor } from './settings';
import { everyPage } from './extra-devices';
import {
  Badge,
  Banner,
  Card,
  CellMain,
  CursorPager,
  DataTable,
  Empty,
  Field,
  FilterBar,
  Input,
  Ltr,
  Num,
  PageHead,
  RowActions,
  Select,
  StateSwitch,
  useToast,
  type Column,
  type Tone,
} from '../ui/kit';
import { Drawer } from '../ui/overlays';

/**
 * Mirza migration PR5 — legacy service candidates (Area D; owner decision 8, 2026-10-07).
 *
 * Every live legacy (Mirza) invoice the importer considered as a service, with the ONE
 * outcome its latest run gave it and the evidence behind it. An invoice that was not adopted
 * stays archived history. The operator acknowledges, keeps as history, reopens, or APPROVES
 * an adoption — the only way an invoice with an empty `code_panel` is ever adopted. An
 * approval adopts nothing here: the page says so, and the next import run re-runs every
 * check against the inventory it walks and adopts through the one adoption path, with no
 * provider write, or refuses and says why. No personal data on this page: the legacy owner
 * and username are on the invoice archive's own page, behind its own permission.
 */

export const LEGACY_SERVICE_OUTCOME_LABELS: Readonly<Record<LegacyServiceOutcome, WebKey>> = {
  ADOPTED: 'web.lsr_outcome_adopted',
  ALREADY_ADOPTED: 'web.lsr_outcome_already_adopted',
  ADOPTION_ELIGIBLE: 'web.lsr_outcome_eligible',
  INVOICE_KEY_INVALID: 'web.lsr_outcome_key_invalid',
  TEST_INVOICE_SKIPPED: 'web.lsr_outcome_test_invoice',
  TEST_PANEL_SKIPPED: 'web.lsr_outcome_test_panel',
  INVALID_SOURCE_ROW: 'web.lsr_outcome_invalid_row',
  ORPHAN: 'web.lsr_outcome_orphan',
  CUSTOMER_NOT_IMPORTED: 'web.lsr_outcome_customer_not_imported',
  INVALID_USERNAME: 'web.lsr_outcome_invalid_username',
  INVENTORY_INCOMPLETE: 'web.lsr_outcome_inventory_incomplete',
  NO_PANEL: 'web.lsr_outcome_no_panel',
  PANEL_UNMAPPED: 'web.lsr_outcome_panel_unmapped',
  PROVIDER_MISSING: 'web.lsr_outcome_provider_missing',
  AMBIGUOUS_PANEL: 'web.lsr_outcome_ambiguous_panel',
  USERNAME_CASE_COLLISION: 'web.lsr_outcome_case_collision',
  AMBIGUOUS_OWNERSHIP: 'web.lsr_outcome_ambiguous_ownership',
  UNSUPPORTED_SHAPE: 'web.lsr_outcome_unsupported_shape',
  PRODUCT_UNRESOLVED: 'web.lsr_outcome_product_unresolved',
  SUBSCRIPTION_REF_BLOCKED: 'web.lsr_outcome_subscription_blocked',
  PROVIDER_READ_FAILED: 'web.lsr_outcome_read_failed',
  REVIEW_CLOSED: 'web.lsr_outcome_review_closed',
};

/** Why the candidate did not adopt, in a sentence (the outcome's explanation). */
export const LEGACY_SERVICE_OUTCOME_WHY: Readonly<Record<LegacyServiceOutcome, WebKey>> = {
  ADOPTED: 'web.lsr_why_adopted',
  ALREADY_ADOPTED: 'web.lsr_why_already_adopted',
  ADOPTION_ELIGIBLE: 'web.lsr_why_eligible',
  INVOICE_KEY_INVALID: 'web.lsr_why_key_invalid',
  TEST_INVOICE_SKIPPED: 'web.lsr_why_test_invoice',
  TEST_PANEL_SKIPPED: 'web.lsr_why_test_panel',
  INVALID_SOURCE_ROW: 'web.lsr_why_invalid_row',
  ORPHAN: 'web.lsr_why_orphan',
  CUSTOMER_NOT_IMPORTED: 'web.lsr_why_customer_not_imported',
  INVALID_USERNAME: 'web.lsr_why_invalid_username',
  INVENTORY_INCOMPLETE: 'web.lsr_why_inventory_incomplete',
  NO_PANEL: 'web.lsr_why_no_panel',
  PANEL_UNMAPPED: 'web.lsr_why_panel_unmapped',
  PROVIDER_MISSING: 'web.lsr_why_provider_missing',
  AMBIGUOUS_PANEL: 'web.lsr_why_ambiguous_panel',
  USERNAME_CASE_COLLISION: 'web.lsr_why_case_collision',
  AMBIGUOUS_OWNERSHIP: 'web.lsr_why_ambiguous_ownership',
  UNSUPPORTED_SHAPE: 'web.lsr_why_unsupported_shape',
  PRODUCT_UNRESOLVED: 'web.lsr_why_product_unresolved',
  SUBSCRIPTION_REF_BLOCKED: 'web.lsr_why_subscription_blocked',
  PROVIDER_READ_FAILED: 'web.lsr_why_read_failed',
  REVIEW_CLOSED: 'web.lsr_why_review_closed',
};

export const LEGACY_SERVICE_STATE_LABELS: Readonly<Record<LegacyServiceReviewState, WebKey>> = {
  OPEN: 'web.lsr_state_open',
  ACKNOWLEDGED: 'web.lsr_state_acknowledged',
  KEPT_AS_HISTORY: 'web.lsr_state_kept',
  ADOPT_APPROVED: 'web.lsr_state_approved',
  ADOPTING: 'web.lsr_state_adopting',
  ADOPTED: 'web.lsr_state_adopted',
};

const STATE_TONES: Readonly<Record<LegacyServiceReviewState, Tone>> = {
  OPEN: 'warn',
  ACKNOWLEDGED: 'info',
  KEPT_AS_HISTORY: 'neutral',
  ADOPT_APPROVED: 'info',
  ADOPTING: 'info',
  ADOPTED: 'ok',
};

const PANEL_CODE_CLASS_LABELS: Readonly<Record<string, WebKey>> = {
  EMPTY: 'web.lsr_code_empty',
  MAPPED: 'web.lsr_code_mapped',
  TEST: 'web.lsr_code_test',
  DECLARED_MISSING: 'web.lsr_code_declared_missing',
  DECLARED_UNRESOLVED: 'web.lsr_code_declared_unresolved',
  UNMAPPED: 'web.lsr_code_unmapped',
};

const CUSTOMER_LABELS: Readonly<Record<string, WebKey>> = {
  IMPORTED: 'web.lsr_customer_imported',
  NOT_IMPORTED: 'web.lsr_customer_not_imported',
  ORPHAN: 'web.lsr_customer_orphan',
};

const FAULTS: Readonly<Record<string, WebKey>> = {
  'legacy_service_candidate.not_found': 'web.lsr_fault_not_found',
  'legacy_service_candidate.not_in_state': 'web.lsr_fault_not_in_state',
  'legacy_service_candidate.version_conflict': 'web.lsr_fault_version',
  'legacy_service_candidate.not_adoptable': 'web.lsr_fault_not_adoptable',
  'legacy_service_candidate.panel_refused': 'web.lsr_fault_panel',
  'legacy_service_candidate.scope_stopped': 'web.lsr_fault_stopped',
};

export function legacyServiceFault(error: unknown): string {
  if (error instanceof ApiError) {
    const key = FAULTS[error.code];
    if (key !== undefined) return t(key);
  }
  return messageFor(error);
}

/** A refusal code is an outcome or one of the approval's own four; labelled either way. */
function refusalLabel(code: string): string {
  const outcome = LEGACY_SERVICE_OUTCOME_LABELS[code as LegacyServiceOutcome];
  if (outcome !== undefined) return t(outcome);
  const own: Readonly<Record<string, WebKey>> = {
    NOT_LIVE: 'web.lsr_refusal_not_live',
    SOURCE_CHANGED: 'web.lsr_refusal_source_changed',
    PANEL_NOT_MAPPED: 'web.lsr_refusal_panel_not_mapped',
    PANEL_CONFLICTS_WITH_MAP: 'web.lsr_refusal_panel_conflicts',
  };
  const key = own[code];
  return key === undefined ? code : t(key);
}

type OutcomeFilter = LegacyServiceOutcome | 'ALL';
type StateFilter = LegacyServiceReviewState | 'ALL';

export function LegacyServicesPage({
  denied,
  mayDecide,
  mayViewPanels,
  mayViewArchive,
}: {
  /** `legacy.services.view` is not held. */
  denied: boolean;
  /** `legacy.services.decide`. */
  mayDecide: boolean;
  /** `panels.view`: panel names instead of ids. */
  mayViewPanels: boolean;
  /** `legacy.invoices.view`: the archive revision's fields come with the detail. */
  mayViewArchive: boolean;
}) {
  const [outcome, setOutcome] = useState<OutcomeFilter>('ALL');
  const [reviewState, setReviewState] = useState<StateFilter>('OPEN');
  const [panelCode, setPanelCode] = useState('');
  const [productCode, setProductCode] = useState('');
  const [invoiceId, setInvoiceId] = useState('');
  const [trail, setTrail] = useState<readonly string[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const after = trail[trail.length - 1];
  const query = {
    ...(outcome === 'ALL' ? {} : { outcome }),
    ...(reviewState === 'ALL' ? {} : { reviewState }),
    ...(panelCode.trim() === '' ? {} : { panelCode }),
    ...(productCode.trim() === '' ? {} : { productCode }),
    // Verbatim: never trimmed.
    ...(invoiceId === '' ? {} : { invoiceId }),
    ...(after === undefined ? {} : { after }),
  };
  const list = useQuery({
    queryKey: ['legacy-services', query],
    queryFn: () => fetchLegacyServices(query),
    enabled: !denied,
  });
  const summary = useQuery({
    queryKey: ['legacy-services', 'summary'],
    queryFn: fetchLegacyServiceSummary,
    enabled: !denied,
  });
  // The names an operator chooses a panel by. Every page: a panel past the first must still
  // have its name (the picker never truncates silently).
  const panels = useQuery({
    queryKey: ['panels', 'legacy-services'],
    queryFn: () =>
      everyPage(async (cursor) => {
        const page = await fetchPanels({ limit: 100, ...(cursor === null ? {} : { cursor }) });
        return { items: page.panels, nextCursor: page.nextCursor };
      }),
    enabled: !denied && mayViewPanels,
    retry: false,
  });
  const panelName = (id: string): string =>
    panels.data?.find((panel) => panel.id === id)?.name ?? id;
  const rows = list.data?.candidates ?? [];
  const nextCursor = list.data?.nextCursor ?? null;
  const resetPaging = () => setTrail([]);

  const columns: readonly Column<LegacyServiceCandidateView>[] = [
    {
      key: 'invoice',
      header: t('web.lsr_col_invoice'),
      render: (row) => (
        <CellMain
          primary={<Ltr>{row.invoiceKey}</Ltr>}
          secondary={<span className="muted small">{formatTimestamp(row.updatedAt)}</span>}
        />
      ),
    },
    {
      key: 'outcome',
      header: t('web.lsr_col_outcome'),
      render: (row) => (
        <Badge tone={row.serviceId === null ? 'warn' : 'ok'}>
          {t(LEGACY_SERVICE_OUTCOME_LABELS[row.outcome])}
        </Badge>
      ),
    },
    {
      key: 'panel',
      header: t('web.lsr_col_panel_code'),
      render: (row) =>
        row.panelCode === null ? (
          <span className="muted">{t('web.lsr_code_empty')}</span>
        ) : (
          <Ltr>{row.panelCode}</Ltr>
        ),
    },
    {
      key: 'product',
      header: t('web.lsr_col_product_code'),
      render: (row) =>
        row.productCode === null ? <span className="muted">—</span> : <Ltr>{row.productCode}</Ltr>,
    },
    {
      key: 'state',
      header: t('web.lsr_col_state'),
      render: (row) => (
        <Badge tone={STATE_TONES[row.reviewState]}>
          {t(LEGACY_SERVICE_STATE_LABELS[row.reviewState])}
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: t('web.lsr_col_actions'),
      align: 'end',
      render: (row) => (
        <RowActions>
          <button type="button" className="btn ghost sm" onClick={() => setOpenId(row.id)}>
            {t('web.lsr_open')}
          </button>
        </RowActions>
      ),
    },
  ];

  return (
    <>
      <PageHead title={t('web.lsr_title')} subtitle={t('web.lsr_subtitle')} />
      <Banner tone="info" icon="info">
        {t('web.lsr_banner')}
      </Banner>
      {summary.data !== undefined && (
        <Card title={t('web.lsr_summary_title')}>
          <dl className="kv">
            <dt>{t('web.lsr_summary_total')}</dt>
            <dd>
              <Num value={summary.data.candidateCount} />
            </dd>
            {LEGACY_SERVICE_OUTCOMES.filter((o) => summary.data.byOutcome[o] > 0).map((o) => (
              <Fragment key={o}>
                <dt>{t(LEGACY_SERVICE_OUTCOME_LABELS[o])}</dt>
                <dd>
                  <Num value={summary.data.byOutcome[o]} />
                </dd>
              </Fragment>
            ))}
          </dl>
        </Card>
      )}
      <FilterBar>
        <Field label={t('web.lsr_col_outcome')} htmlFor="lsr-outcome" compact>
          <Select
            id="lsr-outcome"
            size="sm"
            value={outcome}
            onChange={(event) => {
              setOutcome(event.target.value as OutcomeFilter);
              resetPaging();
            }}
          >
            <option value="ALL">{t('web.lsr_filter_all_outcomes')}</option>
            {LEGACY_SERVICE_OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {t(LEGACY_SERVICE_OUTCOME_LABELS[o])}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('web.lsr_col_state')} htmlFor="lsr-state" compact>
          <Select
            id="lsr-state"
            size="sm"
            value={reviewState}
            onChange={(event) => {
              setReviewState(event.target.value as StateFilter);
              resetPaging();
            }}
          >
            {LEGACY_SERVICE_REVIEW_STATES.map((s) => (
              <option key={s} value={s}>
                {t(LEGACY_SERVICE_STATE_LABELS[s])}
              </option>
            ))}
            <option value="ALL">{t('web.lsr_filter_all_states')}</option>
          </Select>
        </Field>
        <Field label={t('web.lsr_col_panel_code')} htmlFor="lsr-panel" compact>
          <Input
            id="lsr-panel"
            size="sm"
            dir="ltr"
            value={panelCode}
            maxLength={300}
            onChange={(event) => {
              setPanelCode(event.target.value);
              resetPaging();
            }}
          />
        </Field>
        <Field label={t('web.lsr_col_product_code')} htmlFor="lsr-product" compact>
          <Input
            id="lsr-product"
            size="sm"
            dir="ltr"
            value={productCode}
            maxLength={300}
            onChange={(event) => {
              setProductCode(event.target.value);
              resetPaging();
            }}
          />
        </Field>
        <Field label={t('web.lsr_search_invoice')} htmlFor="lsr-invoice" compact>
          <Input
            id="lsr-invoice"
            size="sm"
            dir="ltr"
            value={invoiceId}
            maxLength={300}
            onChange={(event) => {
              setInvoiceId(event.target.value);
              resetPaging();
            }}
          />
        </Field>
      </FilterBar>
      <StateSwitch
        query={list}
        denied={denied}
        isEmpty={queryState(list) === 'ready' && rows.length === 0 && trail.length === 0}
        empty={<Empty title={t('web.lsr_empty')} hint={t('web.lsr_empty_hint')} />}
      >
        <Card title={t('web.lsr_title')}>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            caption={t('web.lsr_title')}
            dense
          />
          <CursorPager
            shown={rows.length}
            hasPrevious={trail.length > 0}
            hasNext={nextCursor !== null}
            onPrevious={() => setTrail(trail.slice(0, -1))}
            onNext={() => nextCursor !== null && setTrail([...trail, nextCursor])}
          />
        </Card>
      </StateSwitch>
      <Drawer
        open={openId !== null}
        onClose={() => setOpenId(null)}
        title={t('web.lsr_detail_title')}
        wide
      >
        {openId !== null && (
          <CandidateDetail
            id={openId}
            mayDecide={mayDecide}
            mayViewArchive={mayViewArchive}
            panelName={panelName}
          />
        )}
      </Drawer>
    </>
  );
}

/** One candidate: why it did not adopt, the evidence, the archive revision, the decision. */
export function CandidateDetail({
  id,
  mayDecide,
  mayViewArchive,
  panelName,
}: {
  id: string;
  mayDecide: boolean;
  mayViewArchive: boolean;
  panelName: (id: string) => string;
}) {
  const detail = useQuery({
    queryKey: ['legacy-services', 'detail', id],
    queryFn: () => fetchLegacyService(id),
  });
  if (detail.data === undefined) {
    return detail.error !== null ? (
      <Banner tone="danger" role="alert">
        {legacyServiceFault(detail.error)}
      </Banner>
    ) : (
      <p className="muted">{t('web.lsr_loading')}</p>
    );
  }
  const { candidate: row, archive, importOutcome, adoptPanels } = detail.data;
  const e = row.evidence;
  return (
    <div className="stack">
      <div className="form-actions">
        <Badge tone={row.serviceId === null ? 'warn' : 'ok'}>
          {t(LEGACY_SERVICE_OUTCOME_LABELS[row.outcome])}
        </Badge>
        <Badge tone={STATE_TONES[row.reviewState]}>
          {t(LEGACY_SERVICE_STATE_LABELS[row.reviewState])}
        </Badge>
      </div>
      {row.synthetic && <Banner tone="warn">{t('web.lsr_synthetic')}</Banner>}
      <Card title={t('web.lsr_why_title')}>
        <p>{t(LEGACY_SERVICE_OUTCOME_WHY[row.outcome])}</p>
        <dl className="kv">
          <dt>{t('web.lsr_col_invoice')}</dt>
          <dd>
            <Ltr>{row.invoiceKey}</Ltr>
          </dd>
          {row.blocker !== null && (
            <>
              <dt>{t('web.lsr_blocker')}</dt>
              <dd>
                <Ltr>{row.blocker}</Ltr>
              </dd>
            </>
          )}
          {row.lastApprovalRefusal !== null && (
            <>
              <dt>{t('web.lsr_last_refusal')}</dt>
              <dd>{refusalLabel(row.lastApprovalRefusal)}</dd>
            </>
          )}
          {importOutcome !== null && (
            <>
              <dt>{t('web.lsr_map_row')}</dt>
              <dd>
                <Ltr>
                  {[importOutcome.status, importOutcome.reasonCode, importOutcome.reviewState]
                    .filter((x) => x !== null)
                    .join(' · ')}
                </Ltr>
              </dd>
            </>
          )}
          {row.serviceId !== null && (
            <>
              <dt>{t('web.lsr_service')}</dt>
              <dd>
                <Ltr>{row.serviceId}</Ltr>
              </dd>
            </>
          )}
        </dl>
      </Card>
      <Card title={t('web.lsr_evidence_title')}>
        <dl className="kv">
          <dt>{t('web.lsr_col_panel_code')}</dt>
          <dd>
            {row.panelCode === null ? t('web.lsr_code_empty') : <Ltr>{row.panelCode}</Ltr>} ·{' '}
            {t(PANEL_CODE_CLASS_LABELS[e.panelCodeClass] ?? 'web.lsr_code_unmapped')}
          </dd>
          <dt>{t('web.lsr_mapped_panel')}</dt>
          <dd>{e.mappedPanelId === null ? '—' : panelName(e.mappedPanelId)}</dd>
          <dt>{t('web.lsr_customer')}</dt>
          <dd>{t(CUSTOMER_LABELS[e.customer] ?? 'web.lsr_customer_orphan')}</dd>
          <dt>{t('web.lsr_holders')}</dt>
          <dd>
            {e.holders.length === 0 ? (
              t('web.lsr_holders_none')
            ) : (
              <ul className="plain">
                {e.holders.map((h) => (
                  <li key={h.panelId}>
                    {panelName(h.panelId)} ·{' '}
                    {h.mapped ? t('web.lsr_holder_mapped') : t('web.lsr_holder_unmapped')} ·{' '}
                    {h.spellings === 1 ? (
                      <Ltr>{h.state ?? '—'}</Ltr>
                    ) : (
                      t('web.lsr_holder_collision')
                    )}
                  </li>
                ))}
              </ul>
            )}
          </dd>
          {e.incompletePanels.length > 0 && (
            <>
              <dt>{t('web.lsr_incomplete_panels')}</dt>
              <dd>{e.incompletePanels.map(panelName).join(', ')}</dd>
            </>
          )}
          <dt>{t('web.lsr_product')}</dt>
          <dd>
            <Ltr>{e.product.path}</Ltr> ·{' '}
            {e.product.resolved ? t('web.lsr_product_resolved') : t('web.lsr_product_unresolved')}
          </dd>
          <dt>{t('web.lsr_claims')}</dt>
          <dd>
            <Num value={e.claims} />
          </dd>
          {row.observedAt !== null && (
            <>
              <dt>{t('web.lsr_observed_at')}</dt>
              <dd>{formatTimestamp(row.observedAt)}</dd>
            </>
          )}
          <dt>{t('web.lsr_source_fingerprint')}</dt>
          <dd>
            <Ltr>{row.sourceFingerprint}</Ltr>
          </dd>
          <dt>{t('web.lsr_run')}</dt>
          <dd>
            <Ltr>{row.runId}</Ltr>
          </dd>
        </dl>
      </Card>
      <Card title={t('web.lsr_archive_title')}>
        {archive !== null ? (
          <dl className="kv">
            <dt>{t('web.lsr_archive_revision')}</dt>
            <dd>
              <Num value={archive.revision} /> · <Ltr>{archive.classification}</Ltr>
            </dd>
            <dt>{t('web.lsr_archive_status')}</dt>
            <dd>
              <Ltr>{archive.status ?? '—'}</Ltr>
            </dd>
            <dt>{t('web.lsr_archive_product')}</dt>
            <dd>
              <bdi>{archive.productName ?? archive.productCode ?? '—'}</bdi>
            </dd>
            <dt>{t('web.lsr_archive_price')}</dt>
            <dd>
              <Ltr>{archive.priceRaw ?? '—'}</Ltr> {t('web.lsr_archive_price_note')}
            </dd>
            {archive.soldAt !== null && (
              <>
                <dt>{t('web.lsr_archive_sold_at')}</dt>
                <dd>{formatTimestamp(archive.soldAt)}</dd>
              </>
            )}
          </dl>
        ) : (
          <p className="muted">
            {row.archiveId === null
              ? t('web.lsr_archive_none')
              : mayViewArchive
                ? t('web.lsr_loading')
                : t('web.lsr_archive_needs_permission')}
          </p>
        )}
        <p className="muted small">{t('web.lsr_archive_pii_note')}</p>
      </Card>
      {mayDecide ? (
        <Decisions
          key={`${row.id}:${String(row.version)}`}
          row={row}
          adoptPanels={adoptPanels}
          panelName={panelName}
        />
      ) : (
        <Banner tone="info">{t('web.lsr_view_only')}</Banner>
      )}
    </div>
  );
}

function Decisions({
  row,
  adoptPanels,
  panelName,
}: {
  row: LegacyServiceCandidateView;
  adoptPanels: LegacyServiceCandidateDetailResponse['adoptPanels'];
  panelName: (id: string) => string;
}) {
  const queries = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();
  const [reason, setReason] = useState('');
  const needsPanel = row.evidence.mappedPanelId === null;
  const [panelId, setPanelId] = useState<string>(adoptPanels[0] ?? '');

  const act = useMutation({
    mutationFn: (
      command:
        | { kind: 'decide'; decision: LegacyServiceReviewDecision }
        | { kind: 'adopt' }
        | { kind: 'reopen' },
    ) => {
      const idempotencyKey = submission.current({
        id: row.id,
        version: row.version,
        command,
        panelId: needsPanel ? panelId : null,
        reason: reason.trim(),
      });
      const common = {
        id: row.id,
        idempotencyKey,
        expectedVersion: row.version,
        reason: reason.trim(),
      };
      if (command.kind === 'decide') {
        return decideLegacyService({ ...common, decision: command.decision });
      }
      if (command.kind === 'adopt') {
        return approveLegacyServiceAdoption({ ...common, ...(needsPanel ? { panelId } : {}) });
      }
      return reopenLegacyService(common);
    },
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.lsr_saved') });
      void queries.invalidateQueries({ queryKey: ['legacy-services'] });
    },
    onError: (error: unknown) => {
      submission.settleOn(error);
      void queries.invalidateQueries({ queryKey: ['legacy-services'] });
    },
  });
  const busy = act.isPending;
  const noReason = reason.trim() === '';
  const open = row.reviewState === 'OPEN';
  const acknowledged = row.reviewState === 'ACKNOWLEDGED';
  const adoptable =
    (open || acknowledged) &&
    (LEGACY_SERVICE_ADOPTABLE_OUTCOMES as readonly string[]).includes(row.outcome);
  const reopenable = (LEGACY_SERVICE_REOPENABLE_STATES as readonly string[]).includes(
    row.reviewState,
  );
  const adoptBlocked = adoptable && needsPanel && adoptPanels.length === 0;

  if (!open && !acknowledged && !reopenable) {
    return <Banner tone="info">{t('web.lsr_no_decision')}</Banner>;
  }
  return (
    <Card title={t('web.lsr_decide_title')}>
      <div className="stack">
        {row.reviewState === 'ADOPT_APPROVED' && (
          <Banner tone="info">{t('web.lsr_approved_waiting')}</Banner>
        )}
        <Field label={t('web.lsr_reason')} htmlFor="lsr-reason" hint={t('web.lsr_reason_hint')}>
          <Input
            id="lsr-reason"
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        {adoptable && (
          <>
            <Banner tone="warn">{t('web.lsr_adopt_explained')}</Banner>
            {needsPanel &&
              (adoptBlocked ? (
                <Banner tone="info">{t('web.lsr_adopt_no_panel_available')}</Banner>
              ) : (
                <Field label={t('web.lsr_adopt_panel')} htmlFor="lsr-adopt-panel">
                  <Select
                    id="lsr-adopt-panel"
                    value={panelId}
                    onChange={(event) => setPanelId(event.target.value)}
                  >
                    {adoptPanels.map((p) => (
                      <option key={p} value={p}>
                        {panelName(p)}
                      </option>
                    ))}
                  </Select>
                </Field>
              ))}
          </>
        )}
        <div className="form-actions">
          {open && (
            <button
              type="button"
              className="btn sm"
              disabled={busy || noReason}
              onClick={() => act.mutate({ kind: 'decide', decision: 'ACKNOWLEDGE' })}
            >
              {t('web.lsr_acknowledge')}
            </button>
          )}
          {(open || acknowledged) && (
            <button
              type="button"
              className="btn sm"
              disabled={busy || noReason}
              onClick={() => act.mutate({ kind: 'decide', decision: 'KEEP_AS_HISTORY' })}
            >
              {t('web.lsr_keep')}
            </button>
          )}
          {adoptable && (
            <button
              type="button"
              className="btn primary sm"
              disabled={busy || noReason || adoptBlocked || (needsPanel && panelId === '')}
              onClick={() => act.mutate({ kind: 'adopt' })}
            >
              {t('web.lsr_adopt')}
            </button>
          )}
          {reopenable && (
            <button
              type="button"
              className="btn sm"
              disabled={busy || noReason}
              onClick={() => act.mutate({ kind: 'reopen' })}
            >
              {t('web.lsr_reopen')}
            </button>
          )}
        </div>
        {act.error !== null && (
          <Banner tone="danger" role="alert">
            {legacyServiceFault(act.error)}
          </Banner>
        )}
      </div>
    </Card>
  );
}
