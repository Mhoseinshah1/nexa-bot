import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  LEGACY_HISTORY_PAGE_DEFAULT,
  type LegacyHistoryItem,
  type LegacyHistoryRecordType,
} from '@nexa/contracts';
import { fetchCustomerLegacyHistory } from '../api/client';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { useLinkHandler } from '../router';
import {
  Badge,
  Banner,
  Card,
  CursorPager,
  Disclosure,
  Empty,
  Ltr,
  Num,
  StateSwitch,
} from '../ui/kit';

/*
 * Mirza `.nxpkg` importer — «سوابق میرزا» on Customer 360 (design §5).
 *
 * The customer's archived Mirza history: payments, wallet transactions, service operations,
 * tickets and the rest, grouped by record type and paged by offset. Read only — nothing here
 * is a balance, an order or a service, and nothing can be changed from it. Drawn only for a
 * viewer holding `legacy.history.view`; the server charges it (and `users.view`) regardless,
 * and returns the personal fields null unless the viewer also holds `legacy.invoices.pii.view`.
 */

const TYPE_LABELS: Readonly<Record<LegacyHistoryRecordType, WebKey>> = {
  payment: 'web.c360_legacy_type_payment',
  wallet_transaction: 'web.c360_legacy_type_wallet_transaction',
  wallet_history_check: 'web.c360_legacy_type_wallet_history_check',
  wallet_difference: 'web.c360_legacy_type_wallet_difference',
  service_operation: 'web.c360_legacy_type_service_operation',
  service_cancellation_request: 'web.c360_legacy_type_service_cancellation_request',
  manual_config_inventory: 'web.c360_legacy_type_manual_config_inventory',
  service_ownership: 'web.c360_legacy_type_service_ownership',
  panel_registry: 'web.c360_legacy_type_panel_registry',
  panel_target: 'web.c360_legacy_type_panel_target',
  panel_mapping_template: 'web.c360_legacy_type_panel_mapping_template',
  category_catalogue: 'web.c360_legacy_type_category_catalogue',
  product_mapping_proposal: 'web.c360_legacy_type_product_mapping_proposal',
  agent_profile: 'web.c360_legacy_type_agent_profile',
  agent_price_level: 'web.c360_legacy_type_agent_price_level',
  agent_invoice: 'web.c360_legacy_type_agent_invoice',
  agent_log: 'web.c360_legacy_type_agent_log',
  agent_usage: 'web.c360_legacy_type_agent_usage',
  agent_request: 'web.c360_legacy_type_agent_request',
  agent_state: 'web.c360_legacy_type_agent_state',
  discount: 'web.c360_legacy_type_discount',
  discount_usage: 'web.c360_legacy_type_discount_usage',
  referral: 'web.c360_legacy_type_referral',
  wheel_result: 'web.c360_legacy_type_wheel_result',
  ad_campaign: 'web.c360_legacy_type_ad_campaign',
  program_setting: 'web.c360_legacy_type_program_setting',
  support_department: 'web.c360_legacy_type_support_department',
  support_message: 'web.c360_legacy_type_support_message',
  ticket: 'web.c360_legacy_type_ticket',
  ticket_message: 'web.c360_legacy_type_ticket_message',
  archive_row: 'web.c360_legacy_type_archive_row',
  configuration_row: 'web.c360_legacy_type_configuration_row',
};

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
                        <LegacyHistoryRow key={item.id} item={item} />
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

function LegacyHistoryRow({ item }: { item: LegacyHistoryItem }) {
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
    </li>
  );
}

/** The page's items under their record type, in the order they arrived. */
function groupByType(
  items: readonly LegacyHistoryItem[],
): [LegacyHistoryRecordType, LegacyHistoryItem[]][] {
  const groups = new Map<LegacyHistoryRecordType, LegacyHistoryItem[]>();
  for (const item of items) {
    const group = groups.get(item.recordType);
    if (group === undefined) groups.set(item.recordType, [item]);
    else group.push(item);
  }
  return [...groups.entries()];
}
