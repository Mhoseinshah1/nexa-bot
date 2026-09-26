import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  ActorType,
  AuditResult,
  OrderPurpose,
  ResellerCreditStanding,
  ResellerCreditState,
  ResellerHistoryEntry,
  ResellerLimitSource,
  ResellerPurchase,
} from '@nexa/contracts';
import {
  fetchResellerCredit,
  fetchResellerHistory,
  fetchResellerPurchases,
  fetchResellerTierHistory,
} from '../api/client';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import {
  Badge,
  Banner,
  Card,
  CursorPager,
  DataTable,
  Empty,
  KV,
  Ltr,
  Money,
  StateSwitch,
  type Column,
  type Tone,
} from '../ui/kit';
import { STATE_LABELS as ORDER_STATE_LABELS, STATE_TONES as ORDER_STATE_TONES } from './orders';
import { PRICE_LAYER_LABELS, limitWire } from './resellers';

/**
 * A reseller's standing, as three read-only cards (WP14, `docs/wp14-reseller-phase2-audit.md`
 * D1–D4): the credit line in use, the purchases as their confirmation recorded them, and
 * the audited changes to the reseller or its tier.
 *
 * Nothing here moves money or states a rule the server does not apply. Every figure on the
 * credit card is the SERVER's derivation of R8 and the ledger; the browser formats it and
 * compares nothing. There is no settlement, repayment, due date or collection anywhere in
 * this product (`OQ-WP9-04`), so the card names none — a debt is a negative balance, and it
 * is repaid by the same top-ups and credits as any balance.
 *
 * Each card is drawn only when the viewer holds the key its route charges beyond
 * `resellers.view`; otherwise it says which key, rather than asking for a 403.
 */

const CREDIT_STATE_LABELS: Readonly<Record<ResellerCreditState, WebKey>> = {
  CREDIT_APPLIES: 'web.reseller_credit_state_applies',
  RESELLER_SUSPENDED: 'web.reseller_credit_state_suspended',
  NO_LIMIT: 'web.reseller_credit_state_no_limit',
  CURRENCY_MISMATCH: 'web.reseller_credit_state_currency',
};

const CREDIT_STATE_TONES: Readonly<Record<ResellerCreditState, Tone>> = {
  CREDIT_APPLIES: 'ok',
  RESELLER_SUSPENDED: 'warn',
  NO_LIMIT: 'neutral',
  CURRENCY_MISMATCH: 'warn',
};

const LIMIT_SOURCE_LABELS: Readonly<Record<ResellerLimitSource, WebKey>> = {
  RESELLER: 'web.reseller_credit_own',
  TIER: 'web.reseller_credit_from_tier',
};

/** Every purpose, including the one a reseller never buys, so the map is total. */
const PURCHASE_PURPOSE_LABELS: Readonly<Record<OrderPurpose, WebKey>> = {
  NEW_SERVICE: 'web.purpose_new_service',
  RENEW: 'web.purpose_renew',
  ADD_TRAFFIC: 'web.purpose_add_traffic',
  ADD_TIME: 'web.purpose_add_time',
  TRIAL: 'web.reseller_purchase_purpose_trial',
};

const ACTOR_TYPE_LABELS: Readonly<Record<ActorType, WebKey>> = {
  CUSTOMER: 'web.history_actor_customer',
  TELEGRAM_ADMIN: 'web.history_actor_telegram_admin',
  WEB_ADMIN: 'web.history_actor_web_admin',
  SYSTEM_JOB: 'web.history_actor_system',
  API: 'web.history_actor_api',
  PROVIDER_SYNC: 'web.history_actor_provider',
};

const RESULT_LABELS: Readonly<Record<AuditResult, WebKey>> = {
  SUCCESS: 'web.history_result_success',
  DENIED: 'web.history_result_denied',
  FAILED: 'web.history_result_failed',
};

const RESULT_TONES: Readonly<Record<AuditResult, Tone>> = {
  SUCCESS: 'ok',
  DENIED: 'warn',
  FAILED: 'danger',
};

/** The actions the two history routes can return; anything else is shown as its code. */
const ACTION_LABELS: Readonly<Record<string, WebKey>> = {
  'reseller.register': 'web.history_action_reseller_register',
  'reseller.update': 'web.history_action_reseller_update',
  'reseller_tier.create': 'web.history_action_tier_create',
  'reseller_tier.update': 'web.history_action_tier_update',
  'reseller_tier.grants': 'web.history_action_tier_grants',
};

/** The fields the reseller and tier writes audit (`serialisableReseller`, `serialisableTier`). */
const FIELD_LABELS: Readonly<Record<string, WebKey>> = {
  tierId: 'web.reseller_tier',
  status: 'web.status',
  pricingMode: 'web.reseller_pricing',
  discountPercentage: 'web.reseller_percent',
  creditLimit: 'web.reseller_credit_limit',
  name: 'web.reseller_tier_name',
  grants: 'web.reseller_grants',
};

// ---------------------------------------------------------------------------
// D1 — credit standing
// ---------------------------------------------------------------------------

export function ResellerCreditCard({
  customerId,
  mayViewWallet,
}: {
  customerId: string;
  /** `users.view`: the balance is the customer's wallet. */
  mayViewWallet: boolean;
}) {
  const credit = useQuery({
    queryKey: ['reseller-credit', customerId],
    queryFn: () => fetchResellerCredit(customerId),
    enabled: mayViewWallet,
  });
  return (
    <Card title={t('web.reseller_credit_title')} hint={t('web.reseller_credit_hint')}>
      {!mayViewWallet ? (
        <Banner tone="info">{t('web.reseller_credit_denied')}</Banner>
      ) : (
        <StateSwitch query={credit}>
          {credit.data !== undefined && <CreditStanding standing={credit.data.credit} />}
        </StateSwitch>
      )}
    </Card>
  );
}

function CreditStanding({ standing }: { standing: ResellerCreditStanding }) {
  const inSelling = (amount: string) => limitWire({ amount, currency: standing.balance.currency });
  const over = standing.overLimitBy.amount !== '0';
  return (
    <>
      <KV
        items={[
          [
            t('web.reseller_credit_state'),
            <Badge key="s" tone={CREDIT_STATE_TONES[standing.credit]}>
              {t(CREDIT_STATE_LABELS[standing.credit])}
            </Badge>,
          ],
          [
            t('web.reseller_credit_limit_effective'),
            <span key="l">
              <Money value={limitWire(standing.effectiveLimit)} />{' '}
              <span className="muted small">{t(LIMIT_SOURCE_LABELS[standing.limitSource])}</span>
            </span>,
          ],
          [
            t('web.reseller_credit_balance'),
            <Money key="b" value={inSelling(standing.balance.amount)} />,
          ],
          [
            t('web.reseller_credit_allowance'),
            <Money key="a" value={inSelling(standing.allowance.amount)} />,
          ],
          [
            t('web.reseller_credit_in_use'),
            <Money key="u" value={inSelling(standing.creditInUse.amount)} />,
          ],
          [
            t('web.reseller_credit_available'),
            <Money key="v" value={inSelling(standing.availableToSpend.amount)} />,
          ],
          [
            t('web.reseller_credit_over_limit'),
            <Money key="o" value={inSelling(standing.overLimitBy.amount)} />,
          ],
        ]}
      />
      {over && <Banner tone="warn">{t('web.reseller_credit_over_limit_banner')}</Banner>}
      {standing.credit === 'CURRENCY_MISMATCH' && (
        <Banner tone="warn">{t('web.reseller_credit_currency_banner')}</Banner>
      )}
      <p className="muted small">{t('web.reseller_credit_rule_debt')}</p>
      <p className="muted small">{t('web.reseller_credit_rule_available')}</p>
    </>
  );
}

// ---------------------------------------------------------------------------
// D2 — purchase history
// ---------------------------------------------------------------------------

export function ResellerPurchasesCard({
  customerId,
  mayViewOrders,
}: {
  customerId: string;
  /** `orders.view`: every row names an order. */
  mayViewOrders: boolean;
}) {
  const [trail, setTrail] = useState<readonly string[]>([]);
  const cursor = trail[trail.length - 1];
  const purchases = useQuery({
    queryKey: ['reseller-purchases', customerId, cursor ?? null],
    queryFn: () => fetchResellerPurchases(customerId, cursor === undefined ? {} : { cursor }),
    enabled: mayViewOrders,
  });
  const rows = purchases.data?.purchases ?? [];
  const next = purchases.data?.nextCursor ?? null;

  const money = (row: ResellerPurchase, amount: string) => (
    <Money value={limitWire({ amount, currency: row.currency })} />
  );
  const columns: readonly Column<ResellerPurchase>[] = [
    {
      key: 'confirmed',
      header: t('web.order_confirmed_at'),
      render: (row) => <span className="nowrap">{formatTimestamp(row.confirmedAt)}</span>,
    },
    {
      key: 'order',
      header: t('web.reseller_purchase_order'),
      render: (row) => (
        <span>
          <Ltr>{row.orderId.slice(0, 8)}</Ltr>{' '}
          <Badge tone={ORDER_STATE_TONES[row.orderState]}>
            {t(ORDER_STATE_LABELS[row.orderState])}
          </Badge>
        </span>
      ),
    },
    {
      key: 'purpose',
      header: t('web.reseller_purchase_purpose'),
      render: (row) => t(PURCHASE_PURPOSE_LABELS[row.purpose]),
    },
    {
      key: 'terms',
      header: t('web.reseller_purchase_terms'),
      render: (row) => (
        <span>
          {row.tierName} · {t(PRICE_LAYER_LABELS[row.layer])}
          {row.percent === null ? null : (
            <>
              {' '}
              <Ltr>{`${row.percent}%`}</Ltr>
            </>
          )}
        </span>
      ),
    },
    {
      key: 'list',
      header: t('web.reseller_purchase_list'),
      align: 'end',
      render: (row) => money(row, row.listAmount),
    },
    {
      key: 'cost',
      header: t('web.reseller_purchase_cost'),
      align: 'end',
      render: (row) => money(row, row.costAmount),
    },
    {
      key: 'promotion',
      header: t('web.reseller_purchase_promotion'),
      align: 'end',
      render: (row) => money(row, row.promotionAmount),
    },
    {
      key: 'sale',
      header: t('web.reseller_purchase_sale'),
      align: 'end',
      render: (row) => money(row, row.saleAmount),
    },
  ];

  return (
    <Card title={t('web.reseller_purchases_title')} hint={t('web.reseller_purchases_hint')}>
      {!mayViewOrders ? (
        <Banner tone="info">{t('web.reseller_purchases_denied')}</Banner>
      ) : (
        <StateSwitch
          query={purchases}
          isEmpty={rows.length === 0 && trail.length === 0}
          empty={<Empty title={t('web.reseller_purchases_empty')} icon="inbox" />}
        >
          <DataTable
            caption={t('web.reseller_purchases_title')}
            columns={columns}
            rows={rows}
            rowKey={(row) => row.orderId}
          />
          <CursorPager
            shown={rows.length}
            hasPrevious={trail.length > 0}
            hasNext={next !== null}
            onPrevious={() => setTrail((current) => current.slice(0, -1))}
            onNext={() => next !== null && setTrail((current) => [...current, next])}
          />
        </StateSwitch>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// D3 — change history
// ---------------------------------------------------------------------------

export function ResellerHistoryCard({
  customerId,
  mayViewAudit,
}: {
  customerId: string;
  mayViewAudit: boolean;
}) {
  const history = useQuery({
    queryKey: ['reseller-history', customerId],
    queryFn: () => fetchResellerHistory(customerId),
    enabled: mayViewAudit,
  });
  return (
    <HistoryCard
      query={history}
      entries={history.data?.entries ?? []}
      mayViewAudit={mayViewAudit}
    />
  );
}

export function TierHistoryCard({
  tierId,
  mayViewAudit,
}: {
  tierId: string;
  mayViewAudit: boolean;
}) {
  const history = useQuery({
    queryKey: ['reseller-tier-history', tierId],
    queryFn: () => fetchResellerTierHistory(tierId),
    enabled: mayViewAudit,
  });
  return (
    <HistoryCard
      query={history}
      entries={history.data?.entries ?? []}
      mayViewAudit={mayViewAudit}
    />
  );
}

function HistoryCard({
  query,
  entries,
  mayViewAudit,
}: {
  query: Parameters<typeof StateSwitch>[0]['query'];
  entries: readonly ResellerHistoryEntry[];
  mayViewAudit: boolean;
}) {
  const columns: readonly Column<ResellerHistoryEntry>[] = [
    {
      key: 'when',
      header: t('web.history_when'),
      render: (row) => <span className="nowrap">{formatTimestamp(row.occurredAt)}</span>,
    },
    {
      key: 'action',
      header: t('web.history_action'),
      render: (row) => {
        const label = ACTION_LABELS[row.action];
        return label === undefined ? <Ltr>{row.action}</Ltr> : t(label);
      },
    },
    {
      key: 'actor',
      header: t('web.history_actor'),
      render: (row) => (
        <span>
          {t(ACTOR_TYPE_LABELS[row.actorType])}
          {row.actorLabel === null ? null : (
            <>
              {' '}
              <Ltr>{row.actorLabel}</Ltr>
            </>
          )}
        </span>
      ),
    },
    {
      key: 'result',
      header: t('web.history_result'),
      render: (row) => (
        <Badge tone={RESULT_TONES[row.result]}>{t(RESULT_LABELS[row.result])}</Badge>
      ),
    },
    {
      key: 'changed',
      header: t('web.history_changed'),
      render: (row) => <ChangedFields entry={row} />,
    },
  ];
  return (
    <Card title={t('web.history_title')} hint={t('web.history_hint')}>
      {!mayViewAudit ? (
        <Banner tone="info">{t('web.history_denied')}</Banner>
      ) : (
        <StateSwitch
          query={query}
          isEmpty={entries.length === 0}
          empty={<Empty title={t('web.history_empty')} icon="inbox" />}
        >
          <DataTable
            caption={t('web.history_title')}
            columns={columns}
            rows={entries}
            rowKey={(row) => row.id}
          />
        </StateSwitch>
      )}
    </Card>
  );
}

/**
 * The top-level fields whose stored value differs between before and after — the NAMES,
 * not the values. The values are the reseller's terms, which the form above already shows
 * as they are now; a row that says "credit limit changed" answers "who changed this, and
 * when", which is the question an audit trail exists for.
 */
export function changedFieldsOf(entry: ResellerHistoryEntry): readonly string[] {
  if (entry.after === null) return [];
  const before = entry.before ?? {};
  return Object.keys(entry.after).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(entry.after?.[key]),
  );
}

function ChangedFields({ entry }: { entry: ResellerHistoryEntry }): ReactNode {
  const fields = changedFieldsOf(entry);
  if (fields.length === 0) return <span className="faint">—</span>;
  return (
    <span>
      {fields.map((field, index) => {
        const label = FIELD_LABELS[field];
        return (
          <span key={field}>
            {index === 0 ? null : ' · '}
            {label === undefined ? <Ltr>{field}</Ltr> : t(label)}
          </span>
        );
      })}
    </span>
  );
}
