import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  LEGACY_RECORDS_LINKED_FILTERS,
  type LegacyHistoryRecordType,
  type LegacyInactivePanel,
  type LegacyRecordItem,
  type LegacyRecordsLinkedFilter,
} from '@nexa/contracts';
import {
  fetchLegacyRecords,
  fetchLegacyRecordsSummary,
  fetchServiceLegacyHistory,
} from '../api/client';
import { t, type WebKey } from '../i18n/web.fa';
import {
  Badge,
  Banner,
  Card,
  CursorPager,
  DataTable,
  Empty,
  Ltr,
  Num,
  PageHead,
  StateSwitch,
  type Column,
} from '../ui/kit';
import { LegacyHistoryRow } from './customer-360-legacy';
import { LEGACY_HISTORY_TYPE_LABELS } from './mirza-labels';

/*
 * «سوابق و تنظیمات میرزا» — the whole Mirza history archive, READ ONLY.
 *
 * The Customer 360 card shows one customer's records. This page lists every record type with
 * its counts — including the types that are never linked to a customer (panel registry,
 * product proposals, discounts, tickets, configuration rows…) — and pages one type, or the
 * customer-less records, by record id. Nothing here writes, and no record on it changed a
 * balance, an order or a service. The server charges `legacy.history.view` and returns the
 * personal fields reduced unless the reader also holds `legacy.invoices.pii.view`.
 */

const LINKED_LABELS: Readonly<Record<LegacyRecordsLinkedFilter, WebKey>> = {
  yes: 'web.lrec_linked_yes',
  no: 'web.lrec_linked_no',
};

/** A normalised Mirza panel status, named; any other value is shown raw beside a generic label. */
export function inactivePanelStatusLabel(status: string): string {
  return status === 'DISABLED' ? t('web.lrec_status_disabled') : t('web.lrec_status_other');
}

const PANEL_COLUMNS: readonly Column<LegacyInactivePanel>[] = [
  { key: 'code', header: t('web.lrec_panel_code'), render: (p) => <Ltr>{p.code}</Ltr> },
  { key: 'name', header: t('web.lrec_panel_name'), render: (p) => p.name ?? '—' },
  {
    key: 'type',
    header: t('web.lrec_panel_type'),
    render: (p) => (p.panelType === null ? '—' : <Ltr>{p.panelType}</Ltr>),
  },
  {
    key: 'status',
    header: t('web.lrec_panel_status'),
    render: (p) => (
      <span data-status={p.status}>
        <Badge tone="warn" dot>
          {inactivePanelStatusLabel(p.status)}
        </Badge>
      </span>
    ),
  },
];

export function LegacyRecordsPage({ denied }: { denied: boolean }) {
  const [type, setType] = useState<LegacyHistoryRecordType | undefined>(undefined);
  const [linked, setLinked] = useState<LegacyRecordsLinkedFilter | undefined>(undefined);
  const [trail, setTrail] = useState<readonly string[]>([]);
  const after = trail[trail.length - 1];

  const summary = useQuery({
    queryKey: ['legacy-records-summary'],
    queryFn: fetchLegacyRecordsSummary,
    enabled: !denied,
  });
  const records = useQuery({
    queryKey: ['legacy-records', type ?? null, linked ?? null, after ?? null],
    queryFn: () =>
      fetchLegacyRecords({
        ...(type === undefined ? {} : { type }),
        ...(linked === undefined ? {} : { linked }),
        ...(after === undefined ? {} : { after }),
      }),
    enabled: !denied,
    placeholderData: keepPreviousData,
  });

  const chooseType = (next: LegacyHistoryRecordType | undefined) => {
    setType(next);
    setTrail([]);
  };
  const chooseLinked = (next: LegacyRecordsLinkedFilter | undefined) => {
    setLinked(next);
    setTrail([]);
  };
  const data = records.data;
  const nextCursor = data?.nextCursor ?? null;

  return (
    <>
      <PageHead title={t('web.lrec_title')} subtitle={t('web.lrec_intro')} />
      <StateSwitch query={summary} denied={denied}>
        {summary.data === undefined ? null : (
          <>
            <Card title={t('web.lrec_panels_title')} hint={t('web.lrec_panels_hint')}>
              {summary.data.inactivePanels.length === 0 ? (
                <Empty variant="compact" title={t('web.lrec_panels_empty')} />
              ) : (
                <DataTable
                  caption={t('web.lrec_panels_title')}
                  columns={PANEL_COLUMNS}
                  rows={summary.data.inactivePanels}
                  rowKey={(p) => p.code}
                  dense
                />
              )}
            </Card>

            <Card title={t('web.lrec_types_title')}>
              <p className="small">
                {t('web.lrec_total')} <Num value={summary.data.total} /> · {t('web.lrec_unlinked')}{' '}
                <Num value={summary.data.unlinked} />
              </p>
              <div className="row" role="group" aria-label={t('web.lrec_filter_type')}>
                <button
                  type="button"
                  className={type === undefined ? 'btn sm primary' : 'btn sm'}
                  aria-pressed={type === undefined}
                  onClick={() => chooseType(undefined)}
                >
                  {t('web.lrec_all')} <Num value={summary.data.total} />
                </button>
                {summary.data.byType.map((row) => (
                  <button
                    key={row.recordType}
                    type="button"
                    className={type === row.recordType ? 'btn sm primary' : 'btn sm'}
                    aria-pressed={type === row.recordType}
                    onClick={() => chooseType(row.recordType)}
                  >
                    {t(LEGACY_HISTORY_TYPE_LABELS[row.recordType])} <Num value={row.total} />
                    {row.unlinked > 0 && (
                      <span className="muted small">
                        {' '}
                        ({t('web.lrec_unlinked')} <Num value={row.unlinked} />)
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <div className="row" role="group" aria-label={t('web.lrec_filter_linked')}>
                <button
                  type="button"
                  className={linked === undefined ? 'btn sm primary' : 'btn sm'}
                  aria-pressed={linked === undefined}
                  onClick={() => chooseLinked(undefined)}
                >
                  {t('web.lrec_all')}
                </button>
                {LEGACY_RECORDS_LINKED_FILTERS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={linked === value ? 'btn sm primary' : 'btn sm'}
                    aria-pressed={linked === value}
                    onClick={() => chooseLinked(value)}
                  >
                    {t(LINKED_LABELS[value])}
                  </button>
                ))}
              </div>
            </Card>
          </>
        )}
      </StateSwitch>

      <Card title={type === undefined ? t('web.lrec_title') : t(LEGACY_HISTORY_TYPE_LABELS[type])}>
        <StateSwitch query={records} denied={denied}>
          {data === undefined ? null : (
            <div className="stack">
              {data.piiRedacted && <Banner tone="info">{t('web.lrec_pii_redacted')}</Banner>}
              {data.items.length === 0 ? (
                <Empty variant="compact" title={t('web.lrec_empty')} />
              ) : (
                <ul className="plain stack">
                  {data.items.map((item) => (
                    <RecordRow key={item.id} item={item} />
                  ))}
                </ul>
              )}
              <CursorPager
                hasPrevious={trail.length > 0}
                hasNext={nextCursor !== null}
                onPrevious={() => setTrail(trail.slice(0, -1))}
                onNext={() => nextCursor !== null && setTrail([...trail, nextCursor])}
                shown={data.items.length}
              />
            </div>
          )}
        </StateSwitch>
      </Card>
    </>
  );
}

/** One record: its type, whether a customer is linked, then the shared summary + payload view. */
function RecordRow({ item }: { item: LegacyRecordItem }) {
  return (
    <li className="stack" data-record-type={item.recordType}>
      <span className="row">
        <strong>{t(LEGACY_HISTORY_TYPE_LABELS[item.recordType])}</strong>
        <Badge tone={item.customerLinked ? 'info' : 'neutral'} outline>
          {item.customerLinked ? t('web.lrec_badge_linked') : t('web.lrec_badge_unlinked')}
        </Badge>
      </span>
      <ul className="plain">
        <LegacyHistoryRow item={item} />
      </ul>
    </li>
  );
}

/**
 * The service page's «سوابق میرزا» card: the operations, cancellation requests and ownership
 * records of the Mirza invoice this service was adopted from. Drawn only for a viewer holding
 * `legacy.history.view` (the server also charges `services.view`).
 */
export function ServiceLegacyHistoryCard({
  serviceId,
  mayView,
}: {
  serviceId: string;
  mayView: boolean;
}) {
  const history = useQuery({
    queryKey: ['service-legacy-history', serviceId],
    queryFn: () => fetchServiceLegacyHistory(serviceId),
    enabled: mayView,
  });
  if (!mayView) return null;
  const data = history.data;
  return (
    <Card title={t('web.lrec_service_title')} hint={t('web.lrec_service_hint')}>
      <StateSwitch query={history}>
        {data === undefined ? null : (
          <div className="stack">
            {data.piiRedacted && data.items.length > 0 && (
              <Banner tone="info">{t('web.lrec_pii_redacted')}</Banner>
            )}
            {data.invoiceKeys.length > 0 && (
              <p className="small">
                {t('web.lrec_service_invoice')} <Ltr>{data.invoiceKeys.join(', ')}</Ltr>
              </p>
            )}
            {data.items.length === 0 ? (
              <Empty variant="compact" title={t('web.lrec_service_empty')} />
            ) : (
              <ul className="plain stack">
                {data.items.map((item) => (
                  <RecordRow key={item.id} item={item} />
                ))}
              </ul>
            )}
            {data.truncated && (
              <p className="muted small">
                {t('web.lrec_service_truncated')} <Num value={data.items.length} />
              </p>
            )}
          </div>
        )}
      </StateSwitch>
    </Card>
  );
}
