import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  LEGACY_INVOICE_ARCHIVE_CLASSES,
  LEGACY_INVOICE_ARCHIVE_SEARCH_MAX,
  type LegacyInvoiceArchiveClass,
  type LegacyInvoiceArchiveRowView,
  type LegacyInvoiceArchiveRunView,
  type LegacyInvoiceParseNote,
  type LegacyInvoiceProductRef,
  type LegacyInvoiceRevisionReason,
} from '@nexa/contracts';
import {
  ApiError,
  fetchLegacyInvoice,
  fetchLegacyInvoiceSummary,
  fetchLegacyInvoices,
  type LegacyInvoiceArchiveQuery,
} from '../api/client';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
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
  type Column,
  type Tone,
} from '../ui/kit';
import { Drawer } from '../ui/overlays';

/**
 * Mirza migration PR3 — the legacy invoice archive, READ-ONLY.
 *
 * Every row is the latest revision of one legacy (Mirza) invoice, kept as HISTORY by
 * `legacy-import invoices-read`. Nothing on this page creates an order, a payment, a
 * service or a figure on a report, and there is no button that writes anything. The
 * historical price is labelled as history. The legacy owner's Telegram id, the account
 * username, the referrer and the note are hidden unless the reader holds
 * `legacy.invoices.pii.view` — the server returns them null otherwise; searching BY them is
 * offered only to such a reader (the server refuses it otherwise, and audits the attempt).
 */

export const LEGACY_INVOICE_CLASS_LABELS: Readonly<Record<LegacyInvoiceArchiveClass, WebKey>> = {
  KEY_SHAPE_UNRECOGNISED: 'web.lia_class_key_shape',
  TEST: 'web.lia_class_test',
  TEST_FLAG_INVALID: 'web.lia_class_test_flag_invalid',
  ORPHAN_OWNER: 'web.lia_class_orphan',
  NOT_LIVE: 'web.lia_class_not_live',
  NO_PANEL: 'web.lia_class_no_panel',
  LIVE_CANDIDATE: 'web.lia_class_live_candidate',
};

const CLASS_TONES: Readonly<Record<LegacyInvoiceArchiveClass, Tone>> = {
  KEY_SHAPE_UNRECOGNISED: 'danger',
  TEST: 'neutral',
  TEST_FLAG_INVALID: 'danger',
  ORPHAN_OWNER: 'warn',
  NOT_LIVE: 'neutral',
  NO_PANEL: 'warn',
  LIVE_CANDIDATE: 'info',
};

const PRODUCT_REF_LABELS: Readonly<Record<LegacyInvoiceProductRef, WebKey>> = {
  NONE: 'web.lia_product_none',
  NAMED: 'web.lia_product_named',
  NOT_IN_PRODUCT_TABLE: 'web.lia_product_missing',
};

const NOTE_LABELS: Readonly<Record<LegacyInvoiceParseNote, WebKey>> = {
  ABSENT: 'web.lia_note_absent',
  EMPTY: 'web.lia_note_empty',
  NOT_A_NUMBER: 'web.lia_note_not_a_number',
  OUT_OF_RANGE: 'web.lia_note_out_of_range',
  FORMAT_UNKNOWN: 'web.lia_note_format_unknown',
};

const REVISION_LABELS: Readonly<Record<LegacyInvoiceRevisionReason, WebKey>> = {
  FIRST_SEEN: 'web.lia_revision_first',
  ROW_CHANGED: 'web.lia_revision_row_changed',
  CONTEXT_CHANGED: 'web.lia_revision_context_changed',
};

const RUN_STATE_LABELS: Readonly<Record<LegacyInvoiceArchiveRunView['state'], WebKey>> = {
  STAGING: 'web.lia_run_staging',
  VERIFIED: 'web.lia_run_verified',
  COMPLETED: 'web.lia_run_completed',
  FAILED: 'web.lia_run_failed',
};

const FAULTS: Readonly<Record<string, WebKey>> = {
  'legacy_invoice_archive.not_found': 'web.lia_fault_not_found',
  'legacy_invoice_archive.request_invalid': 'web.lia_fault_request',
  'platform.permission_denied': 'web.lia_fault_pii',
};

export function legacyInvoiceFault(error: unknown): string {
  if (error instanceof ApiError) {
    const key = FAULTS[error.code];
    if (key !== undefined) return t(key);
  }
  return messageFor(error);
}

const Muted = () => <span className="muted">—</span>;

/** A personal cell: shown to a PII reader, a lock label to anyone else. */
function Personal({ value, redacted }: { value: string | null; redacted: boolean }) {
  if (redacted) return <span className="muted">{t('web.lia_hidden')}</span>;
  return value === null ? <Muted /> : <Ltr>{value}</Ltr>;
}

function ClassBadge({ value }: { value: LegacyInvoiceArchiveClass }) {
  return (
    <span data-class={value}>
      <Badge tone={CLASS_TONES[value]} dot>
        {t(LEGACY_INVOICE_CLASS_LABELS[value])}
      </Badge>
    </span>
  );
}

/** The historical price, always labelled as such. Never a price, a total or revenue. */
function HistoricalPrice({ row }: { row: LegacyInvoiceArchiveRowView }) {
  if (row.priceMinor !== null && row.priceCurrency !== null) {
    return (
      <span title={t('web.lia_price_hint')}>
        <Money value={{ amountMinor: row.priceMinor, currency: row.priceCurrency }} />
      </span>
    );
  }
  return row.priceRaw === null ? <Muted /> : <Ltr>{row.priceRaw}</Ltr>;
}

function SoldAt({ row }: { row: LegacyInvoiceArchiveRowView }) {
  if (row.soldAt !== null) return <>{formatTimestamp(row.soldAt)}</>;
  return row.soldAtRaw === null || row.soldAtRaw === '' ? (
    <Muted />
  ) : (
    <span title={row.soldAtNote === null ? undefined : t(NOTE_LABELS[row.soldAtNote])}>
      <Ltr>{row.soldAtRaw}</Ltr>
    </span>
  );
}

type TestFilter = 'ALL' | 'true' | 'false';

interface Filters {
  readonly invoiceId: string;
  readonly legacyUserId: string;
  readonly username: string;
  readonly status: string;
  readonly panelCode: string;
  readonly productCode: string;
  readonly classification: LegacyInvoiceArchiveClass | 'ALL';
  readonly test: TestFilter;
}

const NO_FILTERS: Filters = {
  invoiceId: '',
  legacyUserId: '',
  username: '',
  status: '',
  panelCode: '',
  productCode: '',
  classification: 'ALL',
  test: 'ALL',
};

function queryOf(filters: Filters, mayViewPii: boolean, after: string | undefined) {
  const query: Record<string, string> = {};
  const text = (name: keyof Filters) => {
    const value = (filters[name] as string).trim();
    if (value !== '') query[name] = value;
  };
  text('invoiceId');
  // A search by personal data is offered to a PII reader only; never sent otherwise.
  if (mayViewPii) {
    text('legacyUserId');
    text('username');
  }
  text('status');
  text('panelCode');
  text('productCode');
  if (filters.classification !== 'ALL') query['classification'] = filters.classification;
  if (filters.test !== 'ALL') query['test'] = filters.test;
  if (after !== undefined) query['after'] = after;
  return query as LegacyInvoiceArchiveQuery;
}

export function LegacyInvoicesPage({
  denied,
  mayViewPii,
}: {
  /** `legacy.invoices.view` is not held. */
  denied: boolean;
  /** `legacy.invoices.pii.view`: personal cells shown, and searchable. */
  mayViewPii: boolean;
}) {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [trail, setTrail] = useState<readonly string[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const after = trail[trail.length - 1];
  const query = queryOf(filters, mayViewPii, after);
  const invoices = useQuery({
    queryKey: ['legacy-invoices', query],
    queryFn: () => fetchLegacyInvoices(query),
    enabled: !denied,
  });
  const summary = useQuery({
    queryKey: ['legacy-invoices-summary'],
    queryFn: fetchLegacyInvoiceSummary,
    enabled: !denied,
  });
  const rows = invoices.data?.rows ?? [];
  const nextCursor = invoices.data?.nextCursor ?? null;

  const set = <K extends keyof Filters>(name: K, value: Filters[K]) => {
    setFilters({ ...filters, [name]: value });
    setTrail([]);
  };

  const columns: readonly Column<LegacyInvoiceArchiveRowView>[] = [
    {
      key: 'invoice',
      header: t('web.lia_col_invoice'),
      render: (row) => (
        <CellMain
          primary={<Ltr>{row.invoiceKey === '' ? '""' : row.invoiceKey}</Ltr>}
          secondary={
            row.revision > 1 ? (
              <span className="muted small">
                {t('web.lia_revision')} <Num value={row.revision} />
              </span>
            ) : undefined
          }
        />
      ),
    },
    {
      key: 'class',
      header: t('web.lia_col_class'),
      render: (row) => <ClassBadge value={row.classification} />,
    },
    {
      key: 'status',
      header: t('web.lia_col_status'),
      render: (row) => (row.status === null ? <Muted /> : <Ltr>{row.status}</Ltr>),
    },
    {
      key: 'owner',
      header: t('web.lia_col_owner'),
      render: (row) => (
        <CellMain
          primary={<Personal value={row.legacyUserId} redacted={row.piiRedacted} />}
          secondary={
            row.ownerPresent ? undefined : (
              <span className="muted small">{t('web.lia_owner_missing')}</span>
            )
          }
        />
      ),
    },
    {
      key: 'username',
      header: t('web.lia_col_username'),
      render: (row) => <Personal value={row.username} redacted={row.piiRedacted} />,
    },
    {
      key: 'panel',
      header: t('web.lia_col_panel'),
      render: (row) => (row.panelCode === null ? <Muted /> : <Ltr>{row.panelCode}</Ltr>),
    },
    {
      key: 'product',
      header: t('web.lia_col_product'),
      render: (row) => (
        <CellMain
          primary={row.productCode === null ? <Muted /> : <Ltr>{row.productCode}</Ltr>}
          secondary={<span className="muted small">{t(PRODUCT_REF_LABELS[row.productRef])}</span>}
        />
      ),
    },
    {
      key: 'price',
      header: t('web.lia_col_price'),
      align: 'end',
      render: (row) => <HistoricalPrice row={row} />,
    },
    {
      key: 'sold',
      header: t('web.lia_col_sold_at'),
      render: (row) => <SoldAt row={row} />,
    },
    {
      key: 'actions',
      header: t('web.lia_col_actions'),
      align: 'end',
      render: (row) => (
        <RowActions>
          <button type="button" className="btn ghost sm" onClick={() => setOpenId(row.id)}>
            {t('web.lia_open')}
          </button>
        </RowActions>
      ),
    },
  ];

  const textFilter = (name: keyof Filters, label: WebKey, disabled = false) => (
    <Field
      label={t(label)}
      htmlFor={`lia-${name}`}
      compact
      {...(disabled ? { hint: t('web.lia_pii_needed') } : {})}
    >
      <Input
        id={`lia-${name}`}
        size="sm"
        value={filters[name] as string}
        maxLength={LEGACY_INVOICE_ARCHIVE_SEARCH_MAX}
        disabled={disabled}
        onChange={(event) => set(name, event.target.value as never)}
      />
    </Field>
  );

  return (
    <>
      <PageHead title={t('web.lia_title')} subtitle={t('web.lia_subtitle')} />
      <Banner tone="info" icon="info">
        {t('web.lia_banner')}
      </Banner>
      {!mayViewPii && <Banner tone="neutral">{t('web.lia_pii_banner')}</Banner>}
      {summary.data !== undefined && <ArchiveSummary data={summary.data} />}
      <FilterBar>
        {textFilter('invoiceId', 'web.lia_filter_invoice')}
        {textFilter('legacyUserId', 'web.lia_filter_owner', !mayViewPii)}
        {textFilter('username', 'web.lia_filter_username', !mayViewPii)}
        {textFilter('status', 'web.lia_filter_status')}
        {textFilter('panelCode', 'web.lia_filter_panel')}
        {textFilter('productCode', 'web.lia_filter_product')}
        <Field label={t('web.lia_col_class')} htmlFor="lia-class" compact>
          <Select
            id="lia-class"
            size="sm"
            value={filters.classification}
            onChange={(event) =>
              set('classification', event.target.value as Filters['classification'])
            }
          >
            <option value="ALL">{t('web.lia_filter_all')}</option>
            {LEGACY_INVOICE_ARCHIVE_CLASSES.map((value) => (
              <option key={value} value={value}>
                {t(LEGACY_INVOICE_CLASS_LABELS[value])}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('web.lia_filter_test')} htmlFor="lia-test" compact>
          <Select
            id="lia-test"
            size="sm"
            value={filters.test}
            onChange={(event) => set('test', event.target.value as TestFilter)}
          >
            <option value="ALL">{t('web.lia_filter_all')}</option>
            <option value="true">{t('web.lia_test_yes')}</option>
            <option value="false">{t('web.lia_test_no')}</option>
          </Select>
        </Field>
      </FilterBar>
      <StateSwitch
        query={invoices}
        denied={denied}
        isEmpty={queryState(invoices) === 'ready' && rows.length === 0 && trail.length === 0}
        empty={<Empty title={t('web.lia_empty')} hint={t('web.lia_empty_hint')} />}
      >
        <Card title={t('web.lia_title')}>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            caption={t('web.lia_title')}
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
        title={t('web.lia_detail_title')}
        wide
      >
        {openId !== null && <InvoiceDetail id={openId} />}
      </Drawer>
    </>
  );
}

/** Counts by class and the recent runs: aggregates only, no id or username. */
function ArchiveSummary({
  data,
}: {
  data: {
    readonly invoices: number;
    readonly revisions: number;
    readonly classes: Readonly<Record<LegacyInvoiceArchiveClass, number>>;
    readonly runs: readonly LegacyInvoiceArchiveRunView[];
  };
}) {
  const last = data.runs[0];
  return (
    <Card title={t('web.lia_summary_title')} hint={t('web.lia_summary_hint')}>
      <dl className="kv small">
        <dt>{t('web.lia_summary_invoices')}</dt>
        <dd>
          <Num value={data.invoices} />
        </dd>
        <dt>{t('web.lia_summary_revisions')}</dt>
        <dd>
          <Num value={data.revisions} />
        </dd>
        {LEGACY_INVOICE_ARCHIVE_CLASSES.map((value) => (
          <div key={value} className="kv-row" data-summary-class={value}>
            <dt>{t(LEGACY_INVOICE_CLASS_LABELS[value])}</dt>
            <dd>
              <Num value={data.classes[value]} />
            </dd>
          </div>
        ))}
        {last !== undefined && (
          <>
            <dt>{t('web.lia_summary_last_run')}</dt>
            <dd>
              <Badge
                tone={
                  last.state === 'FAILED' ? 'danger' : last.state === 'COMPLETED' ? 'ok' : 'warn'
                }
              >
                {t(RUN_STATE_LABELS[last.state])}
              </Badge>{' '}
              {formatTimestamp(last.startedAt)}{' '}
              {last.synthetic && <Badge tone="violet">{t('web.lia_synthetic')}</Badge>}
            </dd>
            {last.missingInSnapshot !== null && last.missingInSnapshot > 0 && (
              <>
                <dt>{t('web.lia_summary_missing')}</dt>
                <dd>
                  <Num value={last.missingInSnapshot} />
                </dd>
              </>
            )}
          </>
        )}
      </dl>
    </Card>
  );
}

/** One archived revision: the normalised fields, the raw cells, the revisions, the provenance. */
export function InvoiceDetail({ id }: { id: string }) {
  const detail = useQuery({
    queryKey: ['legacy-invoice', id],
    queryFn: () => fetchLegacyInvoice(id),
  });
  if (detail.error !== null)
    return <Banner tone="danger">{legacyInvoiceFault(detail.error)}</Banner>;
  if (detail.data === undefined) return <p className="muted">{t('web.lia_loading')}</p>;
  const { row, raw, redactedColumns, revisions, importOutcome } = detail.data;
  const redacted = new Set(redactedColumns);
  return (
    <div className="stack">
      <p>
        <Ltr>{row.invoiceKey === '' ? '""' : row.invoiceKey}</Ltr>{' '}
        <ClassBadge value={row.classification} />{' '}
        {!row.keyShapeEvidenced && <Badge tone="danger">{t('web.lia_key_unrecognised')}</Badge>}
      </p>
      <Banner tone="info">{t('web.lia_history_only')}</Banner>
      {row.classification === 'NO_PANEL' && (
        <Banner tone="warn">{t('web.lia_no_panel_explained')}</Banner>
      )}
      {row.classification === 'ORPHAN_OWNER' && (
        <Banner tone="warn">{t('web.lia_orphan_explained')}</Banner>
      )}

      <Card title={t('web.lia_parsed_title')} hint={t('web.lia_parsed_hint')}>
        <dl className="kv">
          <dt>{t('web.lia_col_status')}</dt>
          <dd>
            {row.status === null ? <Muted /> : <Ltr>{row.status}</Ltr>}{' '}
            <span className="muted small">
              {t(row.live ? 'web.lia_live_yes' : 'web.lia_live_no')}
            </span>
          </dd>
          <dt>{t('web.lia_filter_test')}</dt>
          <dd>
            {row.isTest === null
              ? t('web.lia_test_invalid')
              : t(row.isTest ? 'web.lia_test_yes' : 'web.lia_test_no')}
          </dd>
          <dt>{t('web.lia_col_owner')}</dt>
          <dd>
            <Personal value={row.legacyUserId} redacted={row.piiRedacted} />{' '}
            {!row.ownerPresent && <span className="muted small">{t('web.lia_owner_missing')}</span>}
          </dd>
          <dt>{t('web.lia_col_username')}</dt>
          <dd>
            <Personal value={row.username} redacted={row.piiRedacted} />
          </dd>
          <dt>{t('web.lia_col_panel')}</dt>
          <dd>{row.panelCode === null ? <Muted /> : <Ltr>{row.panelCode}</Ltr>}</dd>
          <dt>{t('web.lia_col_product')}</dt>
          <dd>
            {row.productCode === null ? <Muted /> : <Ltr>{row.productCode}</Ltr>}{' '}
            <span className="muted small">{t(PRODUCT_REF_LABELS[row.productRef])}</span>
          </dd>
          <dt>{t('web.lia_product_name')}</dt>
          <dd>{row.productName === null ? <Muted /> : <bdi>{row.productName}</bdi>}</dd>
          <dt>{t('web.lia_col_price')}</dt>
          <dd>
            <HistoricalPrice row={row} />{' '}
            <span className="muted small">
              {row.priceNote === null ? t('web.lia_price_hint') : t(NOTE_LABELS[row.priceNote])}
            </span>
          </dd>
          <dt>{t('web.lia_col_sold_at')}</dt>
          <dd>
            <SoldAt row={row} />{' '}
            {row.soldAtNote !== null && (
              <span className="muted small">{t(NOTE_LABELS[row.soldAtNote])}</span>
            )}
          </dd>
        </dl>
      </Card>

      <Card title={t('web.lia_raw_title')} hint={t('web.lia_raw_hint')}>
        <div className="table-scroll">
          <table className="table dense">
            <thead>
              <tr>
                <th scope="col">{t('web.lia_raw_column')}</th>
                <th scope="col">{t('web.lia_raw_value')}</th>
              </tr>
            </thead>
            <tbody>
              {Object.keys(raw)
                .sort()
                .map((column) => (
                  <tr key={column}>
                    <th scope="row">
                      <Ltr>{column}</Ltr>
                    </th>
                    <td>
                      {redacted.has(column) ? (
                        <span className="muted">{t('web.lia_hidden')}</span>
                      ) : raw[column] === null || raw[column] === undefined ? (
                        <span className="muted">NULL</span>
                      ) : (
                        <Ltr mono={false}>{raw[column]}</Ltr>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title={t('web.lia_revisions_title')}>
        <table className="table dense">
          <thead>
            <tr>
              <th scope="col">{t('web.lia_revision')}</th>
              <th scope="col">{t('web.lia_revision_reason')}</th>
              <th scope="col">{t('web.lia_col_class')}</th>
              <th scope="col">{t('web.lia_archived_at')}</th>
            </tr>
          </thead>
          <tbody>
            {revisions.map((revision) => (
              <tr key={revision.id} data-revision={revision.revision}>
                <td>
                  <Num value={revision.revision} />{' '}
                  {!revision.visible && <Badge tone="warn">{t('web.lia_revision_pending')}</Badge>}
                </td>
                <td>{t(REVISION_LABELS[revision.revisionReason])}</td>
                <td>
                  <ClassBadge value={revision.classification} />
                </td>
                <td>{formatTimestamp(revision.archivedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title={t('web.lia_import_title')} hint={t('web.lia_import_hint')}>
        {importOutcome === null ? (
          <p className="muted">{t('web.lia_import_none')}</p>
        ) : (
          <dl className="kv small">
            <dt>{t('web.lia_import_status')}</dt>
            <dd>
              <Ltr>{importOutcome.status}</Ltr>
            </dd>
            <dt>{t('web.lia_import_reason')}</dt>
            <dd>
              {importOutcome.reasonCode === null ? (
                <Muted />
              ) : (
                <Ltr>{importOutcome.reasonCode}</Ltr>
              )}
            </dd>
            <dt>{t('web.lia_import_review')}</dt>
            <dd>
              {importOutcome.reviewState === null ? (
                <Muted />
              ) : (
                <Ltr>{importOutcome.reviewState}</Ltr>
              )}
            </dd>
          </dl>
        )}
      </Card>

      <Card title={t('web.lia_provenance_title')}>
        <dl className="kv small">
          <dt>{t('web.lia_row_checksum')}</dt>
          <dd>
            <Ltr>{row.rowChecksum}</Ltr>
          </dd>
          <dt>{t('web.lia_read_fingerprint')}</dt>
          <dd>
            <Ltr>{row.readSetFingerprint}</Ltr>
          </dd>
          <dt>{t('web.lia_source_fingerprint')}</dt>
          <dd>
            <Ltr>{row.sourceFingerprint}</Ltr>
          </dd>
          <dt>{t('web.lia_run')}</dt>
          <dd>
            <Ltr>{row.runId}</Ltr>
          </dd>
          <dt>{t('web.lia_archived_at')}</dt>
          <dd>{formatTimestamp(row.archivedAt)}</dd>
        </dl>
      </Card>
    </div>
  );
}
