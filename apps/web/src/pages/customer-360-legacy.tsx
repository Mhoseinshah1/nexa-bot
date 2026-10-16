import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  LEGACY_CUSTOMER_INVOICES_PAGE_DEFAULT,
  LEGACY_HISTORY_PAGE_DEFAULT,
  type LegacyCustomerInvoice,
  type LegacyHistoryItem,
  type LegacyHistoryRecordType,
  type LegacyWalletDebtState,
} from '@nexa/contracts';
import {
  fetchCustomerLegacyHistory,
  fetchCustomerLegacyInvoices,
  fetchLegacyDebts,
} from '../api/client';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { useLinkHandler } from '../router';
import {
  Badge,
  Banner,
  Card,
  CellMain,
  CursorPager,
  DataTable,
  Disclosure,
  Empty,
  KV,
  Ltr,
  Money,
  Num,
  StateSwitch,
  type Column,
  type Tone,
} from '../ui/kit';
import { LEGACY_DEBT_STATE_LABELS } from './legacy-debts';
import { LEGACY_INVOICE_CLASS_LABELS } from './legacy-invoices';
import { LEGACY_SERVICE_OUTCOME_LABELS, LEGACY_SERVICE_STATE_LABELS } from './legacy-services';
import { LEGACY_HISTORY_TYPE_LABELS, mirzaStatusLabel } from './mirza-labels';

/*
 * Mirza `.nxpkg` importer — «سوابق میرزا» on Customer 360 (design §5).
 *
 * The customer's archived Mirza history: payments, wallet transactions, service operations,
 * tickets and the rest, grouped by record type and paged by offset. Read only — nothing here
 * is a balance, an order or a service, and nothing can be changed from it. Drawn only for a
 * viewer holding `legacy.history.view`; the server charges it (and `users.view`) regardless,
 * and returns the personal fields null unless the viewer also holds `legacy.invoices.pii.view`.
 */

const TYPE_LABELS = LEGACY_HISTORY_TYPE_LABELS;

/** The summary fields the server picks; an unknown one is shown under its own (Latin) name. */
const SUMMARY_LABELS: Readonly<Record<string, WebKey>> = {
  schema: 'web.c360_legacy_f_schema',
  sourceTable: 'web.c360_legacy_f_source_table',
  status: 'web.c360_legacy_f_status',
  state: 'web.c360_legacy_f_status',
  method: 'web.c360_legacy_f_method',
  amountMinor: 'web.c360_legacy_f_amount',
  prizeMinor: 'web.c360_legacy_f_amount',
  currency: 'web.c360_legacy_f_currency',
  type: 'web.c360_legacy_f_type',
  kind: 'web.c360_legacy_f_type',
  operation: 'web.c360_legacy_f_type',
  balanceAfterMinor: 'web.c360_legacy_f_balance_after',
  verdict: 'web.c360_legacy_f_verdict',
  decision: 'web.c360_legacy_f_verdict',
  cause: 'web.c360_legacy_f_cause',
  deltaMinor: 'web.c360_legacy_f_delta',
  codePanel: 'web.c360_legacy_f_panel',
  invoiceKey: 'web.c360_legacy_f_invoice',
  codeProduct: 'web.c360_legacy_f_product',
};

/** `schema` and `sourceTable` are provenance: kept for the details, not the row. */
const HIDDEN_IN_ROW = new Set(['schema', 'sourceTable']);

export function CustomerLegacyHistoryCard({
  customerId,
  mayView,
}: {
  customerId: string;
  mayView: boolean;
}) {
  const onLink = useLinkHandler();
  const [type, setType] = useState<LegacyHistoryRecordType | undefined>(undefined);
  const [offset, setOffset] = useState(0);
  const limit = LEGACY_HISTORY_PAGE_DEFAULT;
  const history = useQuery({
    queryKey: ['customer-legacy-history', customerId, type ?? null, offset],
    queryFn: () =>
      fetchCustomerLegacyHistory(customerId, {
        ...(type === undefined ? {} : { type }),
        offset,
        limit,
      }),
    enabled: mayView,
    // The filter and the pager stay put while the next page loads.
    placeholderData: keepPreviousData,
  });
  if (!mayView) return null;

  const choose = (next: LegacyHistoryRecordType | undefined) => {
    setType(next);
    setOffset(0);
  };
  const data = history.data;

  return (
    <Card title={t('web.c360_legacy_title')} hint={t('web.c360_legacy_hint')} id="c360-legacy">
      <StateSwitch query={history}>
        {data === undefined ? null : (
          <div className="stack">
            {data.piiRedacted && <Banner tone="info">{t('web.c360_legacy_pii_redacted')}</Banner>}
            {(data.invoiceArchive !== null || data.walletDebts !== null) && (
              <p className="small">
                {data.invoiceArchive !== null && (
                  <a href="/legacy-invoices" onClick={onLink}>
                    {t('web.c360_legacy_invoices')} <Num value={data.invoiceArchive.invoices} />
                  </a>
                )}
                {data.invoiceArchive !== null && data.walletDebts !== null && ' · '}
                {data.walletDebts !== null && (
                  <a href="/legacy-debts" onClick={onLink}>
                    {t('web.c360_legacy_debts')} <Num value={data.walletDebts.debts} />
                  </a>
                )}
              </p>
            )}
            {data.byType.length === 0 ? (
              <Empty variant="compact" title={t('web.c360_legacy_empty')} />
            ) : (
              <>
                <div className="row" role="group" aria-label={t('web.c360_legacy_filter')}>
                  <button
                    type="button"
                    className={type === undefined ? 'btn sm primary' : 'btn sm'}
                    aria-pressed={type === undefined}
                    onClick={() => choose(undefined)}
                  >
                    {t('web.c360_legacy_all')}{' '}
                    <Num value={data.byType.reduce((sum, row) => sum + row.count, 0)} />
                  </button>
                  {data.byType.map((row) => (
                    <button
                      key={row.recordType}
                      type="button"
                      className={type === row.recordType ? 'btn sm primary' : 'btn sm'}
                      aria-pressed={type === row.recordType}
                      onClick={() => choose(row.recordType)}
                    >
                      {t(TYPE_LABELS[row.recordType])} <Num value={row.count} />
                    </button>
                  ))}
                </div>
                {groupByType(data.items).map(([recordType, items]) => (
                  <section key={recordType} className="stack">
                    <h4>{t(TYPE_LABELS[recordType])}</h4>
                    <ul className="plain stack">
                      {items.map((item) => (
                        <LegacyHistoryRow
                          key={item.id}
                          item={item}
                          messages={messagesOf(item, data.items)}
                        />
                      ))}
                    </ul>
                  </section>
                ))}
                <CursorPager
                  hasPrevious={offset > 0}
                  hasNext={offset + data.items.length < data.matching}
                  onPrevious={() => setOffset(Math.max(0, offset - limit))}
                  onNext={() => setOffset(offset + limit)}
                  summary={
                    <>
                      {t('web.c360_legacy_total')} <Num value={data.matching} />
                    </>
                  }
                />
              </>
            )}
          </div>
        )}
      </StateSwitch>
    </Card>
  );
}

/**
 * The ticket messages of a ticket record, when both are on the page. A message whose ticket is
 * not on this page (or matched none) stays under its own heading, so none is ever hidden.
 */
export function messagesOf(
  item: LegacyHistoryItem,
  all: readonly LegacyHistoryItem[],
): LegacyHistoryItem[] {
  if (item.recordType !== 'ticket') return [];
  return all.filter((m) => m.recordType === 'ticket_message' && m.ticketRecordId === item.id);
}

export function LegacyHistoryRow({
  item,
  messages = [],
}: {
  item: LegacyHistoryItem;
  messages?: readonly LegacyHistoryItem[];
}) {
  const fields = Object.entries(item.summary).filter(([key]) => !HIDDEN_IN_ROW.has(key));
  return (
    <li className="stack">
      <span className="muted small">
        {item.occurredAt === null ? t('web.c360_legacy_no_time') : formatTimestamp(item.occurredAt)}
      </span>
      {fields.length > 0 && (
        <span className="row">
          {fields.map(([key, value]) => {
            const label = SUMMARY_LABELS[key];
            return (
              <Badge key={key} tone="neutral" outline>
                {label === undefined ? <Ltr>{key}</Ltr> : t(label)}:{' '}
                <Ltr>{value === null ? '—' : String(value)}</Ltr>
              </Badge>
            );
          })}
        </span>
      )}
      <Disclosure size="sm" summary={t('web.c360_legacy_details')}>
        <pre className="ltr mono small" dir="ltr">
          {JSON.stringify(item.payload, null, 2)}
        </pre>
      </Disclosure>
      {messages.length > 0 && (
        <ul className="plain stack" aria-label={t(TYPE_LABELS.ticket_message)}>
          {messages.map((message) => (
            <LegacyHistoryRow key={message.id} item={message} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** The page's items under their record type, in the order they arrived. */
function groupByType(
  items: readonly LegacyHistoryItem[],
): [LegacyHistoryRecordType, LegacyHistoryItem[]][] {
  const groups = new Map<LegacyHistoryRecordType, LegacyHistoryItem[]>();
  const ticketIds = new Set(items.filter((i) => i.recordType === 'ticket').map((i) => i.id));
  for (const item of items) {
    // Shown under its ticket when that ticket is on the page (see `messagesOf`).
    if (
      item.recordType === 'ticket_message' &&
      item.ticketRecordId != null &&
      ticketIds.has(item.ticketRecordId)
    ) {
      continue;
    }
    const group = groups.get(item.recordType);
    if (group === undefined) groups.set(item.recordType, [item]);
    else group.push(item);
  }
  return [...groups.entries()];
}

// --- the customer's Mirza invoices -------------------------------------------------------------

/** What the import made of one invoice, said without promising anything it did not do. */
type InvoiceVerdict =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'adopted'; readonly serviceId: string }
  | { readonly kind: 'kept' }
  | { readonly kind: 'review' }
  | { readonly kind: 'undecided' }
  | { readonly kind: 'history' };

const VERDICT_TONES: Readonly<Record<InvoiceVerdict['kind'], Tone>> = {
  hidden: 'neutral',
  adopted: 'ok',
  kept: 'neutral',
  review: 'warn',
  undecided: 'warn',
  history: 'neutral',
};

const VERDICT_LABELS: Readonly<Record<InvoiceVerdict['kind'], WebKey>> = {
  hidden: 'web.c360_li_hidden',
  adopted: 'web.c360_li_adopted',
  kept: 'web.c360_li_kept',
  review: 'web.c360_li_needs_review',
  undecided: 'web.c360_li_not_decided',
  history: 'web.c360_li_history_only',
};

/**
 * - an adopted candidate is the one case that names a live NEXA service;
 * - an operator's "keep as history" is history by decision;
 * - any other candidate outcome is HELD (inventory incomplete, ownership ambiguous, no panel,
 *   panel unmapped, provider missing, …): whether the account exists is not known here;
 * - no candidate: an archive row the importer would consider (`LIVE_CANDIDATE`, `NO_PANEL`)
 *   that no run has decided yet, or one it never considers — history only.
 */
export function invoiceVerdict(
  row: LegacyCustomerInvoice,
  candidatesVisible: boolean,
): InvoiceVerdict {
  if (!candidatesVisible) return { kind: 'hidden' };
  const candidate = row.candidate;
  if (candidate === null) {
    return row.classification === 'LIVE_CANDIDATE' || row.classification === 'NO_PANEL'
      ? { kind: 'undecided' }
      : { kind: 'history' };
  }
  if (candidate.serviceId !== null) return { kind: 'adopted', serviceId: candidate.serviceId };
  if (candidate.reviewState === 'KEPT_AS_HISTORY') return { kind: 'kept' };
  return { kind: 'review' };
}

/** Mirza's verbatim status: its documented meaning, or "unknown" beside the raw value. */
export function MirzaStatus({ status }: { status: string | null }) {
  const label = mirzaStatusLabel(status);
  if (label !== null) return <span title={status ?? undefined}>{label}</span>;
  return (
    <span>
      <Badge tone="warn" outline>
        {t('web.mrz_status_unknown')}
      </Badge>{' '}
      <Ltr>{status ?? '—'}</Ltr>
    </span>
  );
}

function VerdictCell({
  row,
  candidatesVisible,
}: {
  row: LegacyCustomerInvoice;
  candidatesVisible: boolean;
}) {
  const onLink = useLinkHandler();
  const verdict = invoiceVerdict(row, candidatesVisible);
  const candidate = candidatesVisible ? row.candidate : null;
  const reviewHref = `/legacy-services?reviewState=ALL&invoiceId=${encodeURIComponent(row.invoiceKey)}`;
  return (
    <span className="stack">
      <span>
        <Badge tone={VERDICT_TONES[verdict.kind]} dot>
          {t(VERDICT_LABELS[verdict.kind])}
        </Badge>
        {row.isTest === true && (
          <>
            {' '}
            <Badge tone="neutral" outline>
              {t('web.c360_li_test')}
            </Badge>
          </>
        )}
      </span>
      {verdict.kind === 'adopted' && (
        <a href={`/services/${encodeURIComponent(verdict.serviceId)}`} onClick={onLink}>
          {t('web.c360_li_open_service')}
        </a>
      )}
      {candidate !== null && verdict.kind !== 'adopted' && (
        <span className="muted small">
          {t('web.c360_li_reason')} {t(LEGACY_SERVICE_OUTCOME_LABELS[candidate.outcome])}
          {candidate.blocker !== null && (
            <>
              {' '}
              <Ltr>{candidate.blocker}</Ltr>
            </>
          )}
          {' · '}
          {t('web.c360_li_review')} {t(LEGACY_SERVICE_STATE_LABELS[candidate.reviewState])}{' '}
          <a href={reviewHref} onClick={onLink}>
            {t('web.c360_li_open_review')}
          </a>
        </span>
      )}
      {candidate === null && verdict.kind !== 'hidden' && (
        <span className="muted small">{t(LEGACY_INVOICE_CLASS_LABELS[row.classification])}</span>
      )}
    </span>
  );
}

/**
 * The customer's Mirza invoices: the latest archived revision of each, beside what the
 * import made of it. HISTORY, never an order — no row here is a purchase, a payment or a
 * service, and the card says so. Drawn only for `legacy.invoices.view`; the server charges it
 * (and `users.view`) regardless, nulls the outcomes without `legacy.services.view` and the
 * account name without `legacy.invoices.pii.view`.
 */
export function CustomerLegacyInvoicesCard({
  customerId,
  telegramUserId,
  mayView,
  mayViewPii,
}: {
  customerId: string;
  telegramUserId: string;
  mayView: boolean;
  mayViewPii: boolean;
}) {
  const onLink = useLinkHandler();
  const [trail, setTrail] = useState<readonly string[]>([]);
  const after = trail[trail.length - 1];
  const invoices = useQuery({
    queryKey: ['customer-legacy-invoices', customerId, after ?? null],
    queryFn: () =>
      fetchCustomerLegacyInvoices(customerId, {
        limit: LEGACY_CUSTOMER_INVOICES_PAGE_DEFAULT,
        ...(after === undefined ? {} : { after }),
      }),
    enabled: mayView,
    placeholderData: keepPreviousData,
  });
  if (!mayView) return null;
  const data = invoices.data;
  const candidatesVisible = data?.candidatesVisible ?? false;
  // The archive page filters by the legacy owner only for a PII reader (it refuses otherwise).
  const allHref = mayViewPii
    ? `/legacy-invoices?legacyUserId=${encodeURIComponent(telegramUserId)}`
    : '/legacy-invoices';

  const columns: readonly Column<LegacyCustomerInvoice>[] = [
    {
      key: 'invoice',
      header: t('web.c360_li_col_invoice'),
      render: (row) => (
        <CellMain
          primary={<Ltr>{row.invoiceKey}</Ltr>}
          secondary={
            <span className="muted small">
              {row.productName ?? row.productCode ?? '—'}
              {row.username !== null && (
                <>
                  {' · '}
                  <Ltr>{row.username}</Ltr>
                </>
              )}
            </span>
          }
        />
      ),
    },
    {
      key: 'status',
      header: t('web.c360_li_col_status'),
      render: (row) => <MirzaStatus status={row.status} />,
    },
    {
      key: 'outcome',
      header: t('web.c360_li_col_outcome'),
      render: (row) => <VerdictCell row={row} candidatesVisible={candidatesVisible} />,
    },
    {
      key: 'price',
      header: t('web.c360_li_col_price'),
      render: (row) =>
        row.priceMinor === null || row.priceCurrency === null ? (
          '—'
        ) : (
          <Money value={{ amountMinor: row.priceMinor, currency: row.priceCurrency }} />
        ),
    },
    {
      key: 'soldAt',
      header: t('web.c360_li_col_sold_at'),
      render: (row) =>
        row.soldAt === null ? '—' : <span className="nowrap">{formatTimestamp(row.soldAt)}</span>,
    },
  ];

  return (
    <Card
      title={t('web.c360_li_title')}
      hint={t('web.c360_li_hint')}
      id="c360-legacy-invoices"
      actions={
        <a href={allHref} onClick={onLink}>
          {t('web.c360_li_all')}
        </a>
      }
    >
      <StateSwitch query={invoices}>
        {data === undefined ? null : (
          <div className="stack">
            {data.piiRedacted && <Banner tone="info">{t('web.c360_li_pii_redacted')}</Banner>}
            {!data.candidatesVisible && (
              <Banner tone="info">{t('web.c360_li_outcomes_hidden')}</Banner>
            )}
            {data.invoices.length === 0 ? (
              <Empty variant="compact" title={t('web.c360_li_empty')} />
            ) : (
              <>
                <DataTable
                  caption={t('web.c360_li_title')}
                  columns={columns}
                  rows={data.invoices}
                  rowKey={(row) => row.archiveId}
                  dense
                />
                <CursorPager
                  shown={data.invoices.length}
                  hasPrevious={trail.length > 0}
                  hasNext={data.nextCursor !== null}
                  onPrevious={() => setTrail(trail.slice(0, -1))}
                  onNext={() => {
                    if (data.nextCursor !== null) setTrail([...trail, data.nextCursor]);
                  }}
                />
              </>
            )}
          </div>
        )}
      </StateSwitch>
    </Card>
  );
}

// --- the customer's legacy debt ----------------------------------------------------------------

const DEBT_TONES: Readonly<Record<LegacyWalletDebtState, Tone>> = {
  PENDING_REVIEW: 'warn',
  ACKNOWLEDGED: 'info',
  WAIVED: 'neutral',
};

/**
 * The customer's legacy wallet debt, beside the wallet: the negative Mirza balance recorded
 * for review — NEVER collected, and never part of the balance above it. Drawn only for
 * `legacy.debts.view` (the debts list, filtered by the customer's Telegram id, which is the
 * debt's legacy user id); a customer without a debt draws nothing.
 */
export function CustomerLegacyDebtCard({
  telegramUserId,
  mayView,
}: {
  telegramUserId: string;
  mayView: boolean;
}) {
  const onLink = useLinkHandler();
  const debts = useQuery({
    queryKey: ['customer-legacy-debt', telegramUserId],
    queryFn: () => fetchLegacyDebts({ legacyUserId: telegramUserId }),
    enabled: mayView,
  });
  if (!mayView) return null;
  if (debts.isSuccess && debts.data.debts.length === 0) return null;
  return (
    <Card title={t('web.c360_debt_title')} hint={t('web.c360_debt_hint')} id="c360-legacy-debt">
      <StateSwitch query={debts}>
        {debts.data === undefined ? null : (
          <div className="stack">
            {debts.data.debts.map((debt) => (
              <KV
                key={debt.id}
                items={[
                  [
                    t('web.c360_debt_amount'),
                    <Money
                      key="a"
                      value={{ amountMinor: debt.amountMinor, currency: debt.currency }}
                    />,
                  ],
                  [
                    t('web.c360_debt_state'),
                    <span key="s">
                      <Badge tone={DEBT_TONES[debt.state]}>
                        {t(LEGACY_DEBT_STATE_LABELS[debt.state])}
                      </Badge>
                      {debt.synthetic && (
                        <>
                          {' '}
                          <Badge tone="neutral" outline>
                            {t('web.c360_debt_synthetic')}
                          </Badge>
                        </>
                      )}
                    </span>,
                  ],
                  [t('web.c360_debt_recorded'), formatTimestamp(debt.recordedAt)],
                ]}
              />
            ))}
            <p className="muted small">{t('web.lwd_never_collected')}</p>
            <a
              href={`/legacy-debts?state=ALL&legacyUserId=${encodeURIComponent(telegramUserId)}`}
              onClick={onLink}
            >
              {t('web.c360_debt_open')}
            </a>
          </div>
        )}
      </StateSwitch>
    </Card>
  );
}
