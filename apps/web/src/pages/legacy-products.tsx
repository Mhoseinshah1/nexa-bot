import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LEGACY_PRODUCT_REVIEW_APPROVED_STATES,
  LEGACY_PRODUCT_REVIEW_DECIDABLE_STATES,
  LEGACY_PRODUCT_REVIEW_DECIDED_STATES,
  LEGACY_PRODUCT_REVIEW_STATES,
  PRODUCT_TITLE_MAX_LENGTH,
  formatTrafficGb,
  parseTrafficGb,
  type LegacyProductParseNote,
  type LegacyProductParsedField,
  type LegacyProductReviewState,
  type LegacyProductReviewView,
} from '@nexa/contracts';
import {
  ApiError,
  approveLegacyProductExisting,
  approveLegacyProductNew,
  fetchLegacyProductReviews,
  fetchProducts,
  rejectLegacyProduct,
  reopenLegacyProduct,
} from '../api/client';
import { formatTimestamp, formatTrafficGbText } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { useLinkHandler } from '../router';
import { useSubmissionKey } from '../submission-key';
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
  FilterBar,
  Input,
  Ltr,
  Money,
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
 * Mirza migration PR2 — the legacy product review (`docs/legacy-product-review-design.md` §8).
 *
 * Each row is one legacy `code_product`, read by `legacy-import products-read`. Nothing on this
 * page sells, prices or activates anything: an approval maps the code for the importer's panel
 * map (`products-export`), and «ساخت پیش‌نویس» creates a product that is inactive, hidden,
 * unpriced, uncategorised and panel-less. The historical price is shown as history and never
 * offered as a price. Every decision names the facts it was made on (their checksum) and a
 * submission-scoped key; buttons are a courtesy — the server charges `legacy.products.decide`
 * (and `catalog.edit` for a draft).
 */

export const LEGACY_PRODUCT_STATE_LABELS: Readonly<Record<LegacyProductReviewState, WebKey>> = {
  PENDING_REVIEW: 'web.lpr_state_pending',
  APPROVED_EXISTING: 'web.lpr_state_approved_existing',
  APPROVED_NEW: 'web.lpr_state_approved_new',
  REJECTED: 'web.lpr_state_rejected',
  SOURCE_CHANGED: 'web.lpr_state_source_changed',
};

const STATE_TONES: Readonly<Record<LegacyProductReviewState, Tone>> = {
  PENDING_REVIEW: 'warn',
  APPROVED_EXISTING: 'ok',
  APPROVED_NEW: 'ok',
  REJECTED: 'neutral',
  SOURCE_CHANGED: 'danger',
};

const NOTE_LABELS: Readonly<Record<LegacyProductParseNote, WebKey>> = {
  ABSENT: 'web.lpr_note_absent',
  EMPTY: 'web.lpr_note_empty',
  NOT_A_NUMBER: 'web.lpr_note_not_a_number',
  OUT_OF_RANGE: 'web.lpr_note_out_of_range',
  ZERO_MEANING_UNKNOWN: 'web.lpr_note_zero_unknown',
  SOURCE_CONFLICT: 'web.lpr_note_conflict',
};

const FIELD_LABELS: Readonly<Record<LegacyProductParsedField, WebKey>> = {
  title: 'web.lpr_col_title',
  trafficBytes: 'web.lpr_col_traffic',
  durationDays: 'web.lpr_col_days',
  historicalPrice: 'web.lpr_col_historical_price',
};

const FAULTS: Readonly<Record<string, WebKey>> = {
  'legacy_product_review.facts_changed': 'web.lpr_fault_facts_changed',
  'legacy_product_review.version_conflict': 'web.lpr_fault_version',
  'legacy_product_review.not_in_state': 'web.lpr_fault_state',
  'legacy_product_review.source_absent': 'web.lpr_fault_absent',
  'legacy_product_review.source_conflict': 'web.lpr_fault_conflict',
  'legacy_product_review.product_not_found': 'web.lpr_fault_product',
  'legacy_product_review.not_found': 'web.lpr_fault_not_found',
  'legacy_product_review.scope_stopped': 'web.lpr_fault_stopped',
};

export function legacyProductFault(error: unknown): string {
  if (error instanceof ApiError) {
    const key = FAULTS[error.code];
    if (key !== undefined) return t(key);
  }
  return messageFor(error);
}

type StateFilter = LegacyProductReviewState | 'ALL' | 'ATTENTION';

function decidable(state: LegacyProductReviewState): boolean {
  return (LEGACY_PRODUCT_REVIEW_DECIDABLE_STATES as readonly string[]).includes(state);
}

function decided(state: LegacyProductReviewState): boolean {
  return (LEGACY_PRODUCT_REVIEW_DECIDED_STATES as readonly string[]).includes(state);
}

function approved(state: LegacyProductReviewState): boolean {
  return (LEGACY_PRODUCT_REVIEW_APPROVED_STATES as readonly string[]).includes(state);
}

function Traffic({ bytes }: { bytes: string | null }) {
  if (bytes === null) return <span className="muted">—</span>;
  return (
    <>
      <Num value={formatTrafficGbText(BigInt(bytes))} /> {t('web.unit_gib')}
    </>
  );
}

/** The historical price, always labelled as such. Never a selling price. */
function HistoricalPrice({ row }: { row: LegacyProductReviewView }) {
  if (row.historicalPriceMinor !== null && row.historicalPriceCurrency !== null) {
    return (
      <span title={t('web.lpr_historical_hint')}>
        <Money
          value={{ amountMinor: row.historicalPriceMinor, currency: row.historicalPriceCurrency }}
        />
      </span>
    );
  }
  return row.historicalPriceRaw === null ? (
    <span className="muted">—</span>
  ) : (
    <Ltr>{row.historicalPriceRaw}</Ltr>
  );
}

function StateBadges({ row }: { row: LegacyProductReviewView }) {
  return (
    <span data-lifecycle={row.state}>
      <Badge tone={STATE_TONES[row.state]} dot>
        {t(LEGACY_PRODUCT_STATE_LABELS[row.state])}
      </Badge>{' '}
      {row.missingSinceReadFingerprint !== null && (
        <Badge tone="danger">{t('web.lpr_badge_absent')}</Badge>
      )}{' '}
      {row.sourceConflict !== null && <Badge tone="danger">{t('web.lpr_badge_conflict')}</Badge>}{' '}
      {row.exportable && <Badge tone="info">{t('web.lpr_badge_exportable')}</Badge>}
    </span>
  );
}

export function LegacyProductsPage({
  denied,
  mayDecide,
  mayCreateProduct,
  mayPickProduct,
}: {
  /** `legacy.products.view` is not held. */
  denied: boolean;
  /** `legacy.products.decide`. */
  mayDecide: boolean;
  /** `catalog.edit`: approve-as-new creates a product. */
  mayCreateProduct: boolean;
  /** `catalog.view`: the product picker of approve-existing reads the catalogue. */
  mayPickProduct: boolean;
}) {
  const [stateFilter, setStateFilter] = useState<StateFilter>('ATTENTION');
  const [search, setSearch] = useState('');
  const [trail, setTrail] = useState<readonly string[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const after = trail[trail.length - 1];
  const query = {
    ...(stateFilter === 'ATTENTION' ? { attention: true as const } : {}),
    ...(stateFilter !== 'ALL' && stateFilter !== 'ATTENTION' ? { state: stateFilter } : {}),
    ...(search.trim() === '' ? {} : { q: search.trim() }),
    ...(after === undefined ? {} : { after }),
  };
  const reviews = useQuery({
    queryKey: ['legacy-products', query],
    queryFn: () => fetchLegacyProductReviews(query),
    enabled: !denied,
  });
  const rows = reviews.data?.reviews ?? [];
  const nextCursor = reviews.data?.nextCursor ?? null;
  const open = rows.find((row) => row.id === openId) ?? null;

  const columns: readonly Column<LegacyProductReviewView>[] = [
    {
      key: 'code',
      header: t('web.lpr_col_code'),
      render: (row) => (
        <CellMain
          primary={<Ltr>{row.codeProduct}</Ltr>}
          secondary={
            <span className="muted small">
              {t('web.lpr_legacy_id')} <Ltr>{row.legacyProductId}</Ltr>
            </span>
          }
        />
      ),
    },
    {
      key: 'title',
      header: t('web.lpr_col_title'),
      wrap: true,
      render: (row) =>
        row.title === null ? <span className="muted">—</span> : <bdi>{row.title}</bdi>,
    },
    {
      key: 'traffic',
      header: t('web.lpr_col_traffic'),
      align: 'end',
      render: (row) => <Traffic bytes={row.trafficBytes} />,
    },
    {
      key: 'days',
      header: t('web.lpr_col_days'),
      align: 'end',
      render: (row) =>
        row.durationDays === null ? (
          <span className="muted">—</span>
        ) : (
          <Num value={row.durationDays} />
        ),
    },
    {
      key: 'price',
      header: t('web.lpr_col_historical_price'),
      align: 'end',
      render: (row) => <HistoricalPrice row={row} />,
    },
    {
      key: 'live',
      header: t('web.lpr_col_live_invoices'),
      align: 'end',
      render: (row) => <Num value={row.liveInvoiceCount} />,
    },
    {
      key: 'state',
      header: t('web.lpr_col_state'),
      render: (row) => <StateBadges row={row} />,
    },
    {
      key: 'actions',
      header: t('web.lpr_col_actions'),
      align: 'end',
      render: (row) => (
        <RowActions>
          <button type="button" className="btn ghost sm" onClick={() => setOpenId(row.id)}>
            {t('web.lpr_open')}
          </button>
        </RowActions>
      ),
    },
  ];

  const resetPaging = () => setTrail([]);

  return (
    <>
      <PageHead title={t('web.lpr_title')} subtitle={t('web.lpr_subtitle')} />
      <Banner tone="info" icon="info">
        {t('web.lpr_banner')}
      </Banner>
      <FilterBar>
        <Field label={t('web.lpr_col_state')} htmlFor="lpr-state" compact>
          <Select
            id="lpr-state"
            size="sm"
            value={stateFilter}
            onChange={(event) => {
              setStateFilter(event.target.value as StateFilter);
              resetPaging();
            }}
          >
            <option value="ATTENTION">{t('web.lpr_filter_attention')}</option>
            <option value="ALL">{t('web.lpr_filter_all')}</option>
            {LEGACY_PRODUCT_REVIEW_STATES.map((state) => (
              <option key={state} value={state}>
                {t(LEGACY_PRODUCT_STATE_LABELS[state])}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('web.lpr_search')} htmlFor="lpr-search" compact>
          <Input
            id="lpr-search"
            size="sm"
            value={search}
            maxLength={200}
            onChange={(event) => {
              setSearch(event.target.value);
              resetPaging();
            }}
          />
        </Field>
      </FilterBar>
      <StateSwitch
        query={reviews}
        denied={denied}
        isEmpty={queryState(reviews) === 'ready' && rows.length === 0 && trail.length === 0}
        empty={<Empty title={t('web.lpr_empty')} hint={t('web.lpr_empty_hint')} />}
      >
        <Card title={t('web.lpr_title')}>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            caption={t('web.lpr_title')}
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
        open={open !== null}
        onClose={() => setOpenId(null)}
        title={open === null ? '' : <Ltr>{open.codeProduct}</Ltr>}
        wide
      >
        {open !== null && (
          <ReviewDetail
            key={`${open.id}:${String(open.version)}`}
            row={open}
            mayDecide={mayDecide}
            mayCreateProduct={mayCreateProduct}
            mayPickProduct={mayPickProduct}
          />
        )}
      </Drawer>
    </>
  );
}

/** The raw legacy facts beside the parsed proposal, the provenance, and the decisions. */
export function ReviewDetail({
  row,
  mayDecide,
  mayCreateProduct,
  mayPickProduct,
}: {
  row: LegacyProductReviewView;
  mayDecide: boolean;
  mayCreateProduct: boolean;
  mayPickProduct: boolean;
}) {
  const onLink = useLinkHandler();
  const columns = [...new Set(row.facts.flatMap((fact) => Object.keys(fact)))];
  return (
    <div className="stack">
      <StateBadges row={row} />
      {row.state === 'SOURCE_CHANGED' && (
        <Banner tone="warn">
          {t('web.lpr_source_changed_explained')}
          {row.priorState !== null && (
            <>
              {' '}
              {t('web.lpr_prior_state')} {t(LEGACY_PRODUCT_STATE_LABELS[row.priorState])}
            </>
          )}
        </Banner>
      )}
      {row.missingSinceReadFingerprint !== null && (
        <Banner tone="warn">{t('web.lpr_absent_explained')}</Banner>
      )}
      {row.sourceConflict !== null && (
        <Banner tone="danger">{t('web.lpr_conflict_explained')}</Banner>
      )}

      <Card title={t('web.lpr_parsed_title')} hint={t('web.lpr_parsed_hint')}>
        <dl className="kv">
          <dt>{t('web.lpr_col_title')}</dt>
          <dd>{row.title === null ? '—' : <bdi>{row.title}</bdi>}</dd>
          <dt>{t('web.lpr_col_traffic')}</dt>
          <dd>
            <Traffic bytes={row.trafficBytes} />
          </dd>
          <dt>{t('web.lpr_col_days')}</dt>
          <dd>{row.durationDays === null ? '—' : <Num value={row.durationDays} />}</dd>
          <dt>{t('web.lpr_col_historical_price')}</dt>
          <dd>
            <HistoricalPrice row={row} />{' '}
            <span className="muted small">{t('web.lpr_historical_hint')}</span>
          </dd>
          <dt>{t('web.lpr_col_live_invoices')}</dt>
          <dd>
            <Num value={row.liveInvoiceCount} />
          </dd>
        </dl>
        {Object.keys(row.parseNotes).length > 0 && (
          <ul className="small">
            {(
              Object.entries(row.parseNotes) as [LegacyProductParsedField, LegacyProductParseNote][]
            ).map(([field, note]) => (
              <li key={field}>
                {t(FIELD_LABELS[field])}: {t(NOTE_LABELS[note])}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={t('web.lpr_facts_title')} hint={t('web.lpr_facts_hint')}>
        <div className="table-scroll">
          <table className="table dense">
            <thead>
              <tr>
                <th scope="col">{t('web.lpr_fact_column')}</th>
                {row.facts.map((_, index) => (
                  <th key={index} scope="col">
                    {t('web.lpr_fact_row')} <Num value={index + 1} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {columns.map((column) => (
                <tr key={column}>
                  <th scope="row">
                    <Ltr>{column}</Ltr>
                  </th>
                  {row.facts.map((fact, index) => (
                    <td key={index}>
                      {fact[column] === null || fact[column] === undefined ? (
                        <span className="muted">NULL</span>
                      ) : (
                        <Ltr mono={false}>{fact[column]}</Ltr>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title={t('web.lpr_provenance_title')}>
        <dl className="kv small">
          <dt>{t('web.lpr_facts_checksum')}</dt>
          <dd>
            <Ltr>{row.factsChecksum}</Ltr>
          </dd>
          <dt>{t('web.lpr_read_fingerprint')}</dt>
          <dd>
            <Ltr>{row.readFingerprint}</Ltr>
          </dd>
          <dt>{t('web.lpr_source_fingerprint')}</dt>
          <dd>
            <Ltr>{row.sourceFingerprint}</Ltr>
          </dd>
          {row.approvedProductId !== null && (
            <>
              <dt>{t('web.lpr_approved_product')}</dt>
              <dd>
                <a href={`/products/${encodeURIComponent(row.approvedProductId)}`} onClick={onLink}>
                  {row.approvedProductTitle ?? <Ltr>{row.approvedProductId}</Ltr>}
                </a>
              </dd>
            </>
          )}
          {row.decidedAt !== null && (
            <>
              <dt>{t('web.lpr_decided_at')}</dt>
              <dd>{formatTimestamp(row.decidedAt)}</dd>
            </>
          )}
          {row.decisionReason !== null && (
            <>
              <dt>{t('web.lpr_reason')}</dt>
              <dd>
                <bdi>{row.decisionReason}</bdi>
              </dd>
            </>
          )}
        </dl>
      </Card>

      {mayDecide ? (
        <Decisions row={row} mayCreateProduct={mayCreateProduct} mayPickProduct={mayPickProduct} />
      ) : (
        <Banner tone="info">{t('web.lpr_view_only')}</Banner>
      )}
    </div>
  );
}

function Decisions({
  row,
  mayCreateProduct,
  mayPickProduct,
}: {
  row: LegacyProductReviewView;
  mayCreateProduct: boolean;
  mayPickProduct: boolean;
}) {
  const queries = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();
  const [reason, setReason] = useState('');
  const [productId, setProductId] = useState('');
  const [title, setTitle] = useState((row.title ?? '').slice(0, PRODUCT_TITLE_MAX_LENGTH));
  const [days, setDays] = useState(row.durationDays === null ? '' : String(row.durationDays));
  const [traffic, setTraffic] = useState(
    row.trafficBytes === null ? '' : formatTrafficGb(BigInt(row.trafficBytes)),
  );
  const products = useQuery({
    queryKey: ['legacy-products-picker'],
    queryFn: () => fetchProducts({ limit: 100 }),
    enabled: mayPickProduct && decidable(row.state),
  });

  const done = () => {
    submission.settle();
    notify({ tone: 'ok', message: t('web.lpr_saved') });
    void queries.invalidateQueries({ queryKey: ['legacy-products'] });
  };
  const failed = (error: unknown) => {
    submission.settleOn(error);
    void queries.invalidateQueries({ queryKey: ['legacy-products'] });
  };
  const reasonOrNull = reason.trim() === '' ? null : reason.trim();

  const decide = useMutation({
    mutationFn: (
      command:
        | { kind: 'existing'; productId: string }
        | { kind: 'new'; title: string; durationDays: number; trafficBytes: string }
        | { kind: 'reject' }
        | { kind: 'reopen' },
    ) => {
      const idempotencyKey = submission.current({
        id: row.id,
        version: row.version,
        command,
        reason: reasonOrNull,
      });
      if (command.kind === 'existing') {
        return approveLegacyProductExisting({
          id: row.id,
          idempotencyKey,
          expectedFactsChecksum: row.factsChecksum,
          expectedVersion: row.version,
          productId: command.productId,
          reason: reasonOrNull,
        });
      }
      if (command.kind === 'new') {
        return approveLegacyProductNew({
          id: row.id,
          idempotencyKey,
          expectedFactsChecksum: row.factsChecksum,
          expectedVersion: row.version,
          title: command.title,
          durationDays: command.durationDays,
          trafficBytes: command.trafficBytes,
          reason: reasonOrNull,
        });
      }
      if (command.kind === 'reject') {
        return rejectLegacyProduct({
          id: row.id,
          idempotencyKey,
          expectedFactsChecksum: row.factsChecksum,
          expectedVersion: row.version,
          reason: reason.trim(),
        });
      }
      return reopenLegacyProduct({
        id: row.id,
        idempotencyKey,
        expectedVersion: row.version,
        reason: reason.trim(),
      });
    },
    onSuccess: done,
    onError: failed,
  });

  const busy = decide.isPending;
  const trafficBytes = parseTrafficGb(traffic.trim());
  const durationDays = /^[0-9]{1,4}$/u.test(days.trim()) ? Number(days.trim()) : null;
  const draftReady =
    title.trim() !== '' && trafficBytes !== null && durationDays !== null && durationDays <= 3650;
  const mayApprove = row.missingSinceReadFingerprint === null && row.sourceConflict === null;

  return (
    <Card title={t('web.lpr_decide_title')}>
      <div className="stack">
        <Field label={t('web.lpr_reason')} htmlFor="lpr-reason" hint={t('web.lpr_reason_hint')}>
          <Input
            id="lpr-reason"
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>

        {decidable(row.state) && mayApprove && (
          <div className="ca-decision-part">
            <h3>{t('web.lpr_approve_existing')}</h3>
            {mayPickProduct ? (
              <Field label={t('web.lpr_pick_product')} htmlFor="lpr-product">
                <Select
                  id="lpr-product"
                  value={productId}
                  onChange={(event) => setProductId(event.target.value)}
                >
                  <option value="">—</option>
                  {(products.data?.products ?? []).map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.title}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <Banner tone="info">{t('web.lpr_no_catalog_view')}</Banner>
            )}
            <div className="form-actions">
              <button
                type="button"
                className="btn primary sm"
                disabled={busy || productId === ''}
                onClick={() => decide.mutate({ kind: 'existing', productId })}
              >
                {t('web.lpr_approve_existing')}
              </button>
            </div>
          </div>
        )}

        {decidable(row.state) && mayApprove && (
          <div className="ca-decision-part">
            <h3>{t('web.lpr_approve_new')}</h3>
            <Banner tone="info">{t('web.lpr_draft_explained')}</Banner>
            {mayCreateProduct ? (
              <>
                <Field label={t('web.lpr_draft_title')} htmlFor="lpr-draft-title">
                  <Input
                    id="lpr-draft-title"
                    value={title}
                    maxLength={PRODUCT_TITLE_MAX_LENGTH}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </Field>
                <Field label={t('web.lpr_draft_traffic')} htmlFor="lpr-draft-traffic">
                  <Input
                    id="lpr-draft-traffic"
                    inputMode="decimal"
                    value={traffic}
                    onChange={(event) => setTraffic(event.target.value)}
                  />
                </Field>
                <Field label={t('web.lpr_draft_days')} htmlFor="lpr-draft-days">
                  <Input
                    id="lpr-draft-days"
                    inputMode="numeric"
                    value={days}
                    onChange={(event) => setDays(event.target.value)}
                  />
                </Field>
                <div className="form-actions">
                  <button
                    type="button"
                    className="btn sm"
                    disabled={busy || !draftReady}
                    onClick={() =>
                      trafficBytes !== null &&
                      durationDays !== null &&
                      decide.mutate({
                        kind: 'new',
                        title: title.trim(),
                        durationDays,
                        trafficBytes: trafficBytes.toString(),
                      })
                    }
                  >
                    {t('web.lpr_approve_new')}
                  </button>
                </div>
              </>
            ) : (
              <Banner tone="info">{t('web.lpr_no_catalog_edit')}</Banner>
            )}
          </div>
        )}

        {decidable(row.state) && (
          <div className="form-actions">
            <button
              type="button"
              className="btn danger sm"
              disabled={busy || reason.trim() === ''}
              onClick={() => decide.mutate({ kind: 'reject' })}
            >
              {t('web.lpr_reject')}
            </button>
          </div>
        )}

        {decided(row.state) && (
          <div className="form-actions">
            {approved(row.state) && <span className="muted small">{t('web.lpr_reopen_hint')}</span>}
            <button
              type="button"
              className="btn sm"
              disabled={busy || reason.trim() === ''}
              onClick={() => decide.mutate({ kind: 'reopen' })}
            >
              {t('web.lpr_reopen')}
            </button>
          </div>
        )}

        {decide.error !== null && (
          <Banner tone="danger" role="alert">
            {legacyProductFault(decide.error)}
          </Banner>
        )}
      </div>
    </Card>
  );
}
