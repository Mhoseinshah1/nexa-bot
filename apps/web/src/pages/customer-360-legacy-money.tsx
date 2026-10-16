import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  LegacyMoneyHistoryResponse,
  LegacyMoneyPaymentOutcome,
  LegacyMoneyPaymentPurpose,
  LegacyMoneyReconciliationStatus,
  LegacyMoneyTotal,
  MoneyWire,
} from '@nexa/contracts';
import { fetchCustomerLegacyMoneyHistory } from '../api/client';
import { t, type WebKey } from '../i18n/web.fa';
import { Badge, Banner, Card, KV, Ltr, Money, Num, StateSwitch, type Tone } from '../ui/kit';

/*
 * Mirza `.nxpkg` importer — «سوابق مالی میرزا» on Customer 360.
 *
 * The customer's Mirza money history summarised — successful payments by purpose (the rest
 * apart), wallet transactions in and out, wheel prizes, referrals, discount uses, service
 * operations — beside the opening figure the migration wrote, with one reconciliation line.
 * READ ONLY and never a balance: the opening figure is the snapshot `Balance`, the history is
 * evidence, and the card says so in its first line. Drawn only for `legacy.history.view`; the
 * server charges it (and `users.view`) regardless.
 */

export const LEGACY_MONEY_PURPOSE_LABELS: Readonly<Record<LegacyMoneyPaymentPurpose, WebKey>> = {
  WALLET_TOP_UP: 'web.c360_money_purpose_top_up',
  SERVICE_PURCHASE: 'web.c360_money_purpose_purchase',
  ADMIN_CREDIT: 'web.c360_money_purpose_admin_credit',
  ADMIN_DEBIT: 'web.c360_money_purpose_admin_debit',
  PURPOSE_NOT_IN_SOURCE: 'web.c360_money_purpose_not_in_source',
  OTHER: 'web.c360_money_purpose_other',
};

export const LEGACY_MONEY_OUTCOME_LABELS: Readonly<Record<LegacyMoneyPaymentOutcome, WebKey>> = {
  SUCCEEDED: 'web.c360_money_outcome_succeeded',
  FAILED: 'web.c360_money_outcome_failed',
  PENDING: 'web.c360_money_outcome_pending',
  CANCELLED: 'web.c360_money_outcome_cancelled',
  UNKNOWN: 'web.c360_money_outcome_unknown',
};

export const LEGACY_MONEY_STATUS_LABELS: Readonly<Record<LegacyMoneyReconciliationStatus, WebKey>> =
  {
    RECONCILED: 'web.c360_money_st_reconciled',
    HISTORY_DIFFERS_SNAPSHOT_KEPT: 'web.c360_money_st_history_differs',
    NO_WALLET_HISTORY: 'web.c360_money_st_no_history',
    NO_OPENING_FIGURE: 'web.c360_money_st_no_opening',
    OPENING_DIFFERS_FROM_SNAPSHOT: 'web.c360_money_st_opening_differs',
    OPENING_INVALID: 'web.c360_money_st_opening_invalid',
    AMBIGUOUS_EVIDENCE: 'web.c360_money_st_ambiguous',
    UNREADABLE_EVIDENCE: 'web.c360_money_st_unreadable',
  };

const STATUS_TONES: Readonly<Record<LegacyMoneyReconciliationStatus, Tone>> = {
  RECONCILED: 'ok',
  HISTORY_DIFFERS_SNAPSHOT_KEPT: 'warn',
  NO_WALLET_HISTORY: 'neutral',
  NO_OPENING_FIGURE: 'neutral',
  OPENING_DIFFERS_FROM_SNAPSHOT: 'danger',
  OPENING_INVALID: 'danger',
  AMBIGUOUS_EVIDENCE: 'warn',
  UNREADABLE_EVIDENCE: 'warn',
};

function MaybeMoney({ value }: { value: MoneyWire | null }) {
  return value === null ? (
    <span className="muted">{t('web.c360_money_none')}</span>
  ) : (
    <Money value={value} />
  );
}

/** A count with the sum of its readable amounts (one per currency) and what was not summed. */
function Total({ total }: { total: LegacyMoneyTotal }) {
  return (
    <span>
      <Num value={total.count} /> {t('web.c360_money_records')}
      {total.amounts.map((amount) => (
        <span key={amount.currency}>
          {' · '}
          <Money value={amount} />
        </span>
      ))}
      {total.unparsedAmounts + total.unrecognisedCurrency > 0 && (
        <span className="muted small">
          {' '}
          ({t('web.c360_money_not_summed')}{' '}
          <Num value={total.unparsedAmounts + total.unrecognisedCurrency} />)
        </span>
      )}
    </span>
  );
}

export function CustomerLegacyMoneyCard({
  customerId,
  mayView,
}: {
  customerId: string;
  mayView: boolean;
}) {
  const money = useQuery({
    queryKey: ['customer-legacy-money', customerId],
    queryFn: () => fetchCustomerLegacyMoneyHistory(customerId),
    enabled: mayView,
  });
  if (!mayView) return null;
  return (
    <Card title={t('web.c360_money_title')} hint={t('web.c360_money_hint')} id="c360-legacy-money">
      <StateSwitch query={money}>
        {money.data === undefined ? null : <MoneyBody data={money.data} />}
      </StateSwitch>
    </Card>
  );
}

function MoneyBody({ data }: { data: LegacyMoneyHistoryResponse }) {
  const r = data.reconciliation;
  const p = data.payments;
  const w = data.walletTransactions;
  return (
    <div className="stack">
      <Banner tone="info">{t('web.c360_money_read_only')}</Banner>

      <section className="stack">
        <h4>{t('web.c360_money_opening')}</h4>
        <KV
          items={[
            [
              t('web.c360_money_opening_credit'),
              <MaybeMoney key="c" value={data.opening.credit} />,
            ],
            [
              t('web.c360_money_opening_debt'),
              data.opening.debt === null ? (
                <span key="d" className="muted">
                  {t('web.c360_money_none')}
                </span>
              ) : (
                <span key="d">
                  <Money value={data.opening.debt.amount} />{' '}
                  <Badge tone="warn" outline>
                    <Ltr>{data.opening.debt.state}</Ltr>
                  </Badge>
                </span>
              ),
            ],
          ]}
        />
      </section>

      <section className="stack">
        <h4>{t('web.c360_money_reconciliation')}</h4>
        <p>
          <Badge tone={STATUS_TONES[r.status]} dot>
            {t(LEGACY_MONEY_STATUS_LABELS[r.status])}
          </Badge>
        </p>
        <KV
          items={[
            [t('web.c360_money_opening_figure'), <MaybeMoney key="o" value={r.openingFigure} />],
            [t('web.c360_money_snapshot'), <MaybeMoney key="s" value={r.snapshotBalance} />],
            [
              t('web.c360_money_history_closing'),
              <MaybeMoney key="h" value={r.historyClosingBalance} />,
            ],
            [t('web.c360_money_delta'), <MaybeMoney key="d" value={r.deltaSnapshotMinusHistory} />],
            [
              t('web.c360_money_verdict'),
              r.historyVerdict === null ? (
                <span key="v" className="muted">
                  {t('web.c360_money_no_check')}
                </span>
              ) : (
                <Ltr key="v">{r.historyVerdict}</Ltr>
              ),
            ],
            ...(r.difference === null
              ? []
              : ([
                  [
                    t('web.c360_money_difference'),
                    <Ltr key="f">
                      {r.difference.cause ?? '—'} / {r.difference.certainty ?? '—'}
                    </Ltr>,
                  ],
                ] as [ReactNode, ReactNode][])),
          ]}
        />
        <p className="muted small">{t('web.c360_money_rule')}</p>
      </section>

      <section className="stack">
        <h4>{t('web.c360_money_payments_ok')}</h4>
        {p.succeededByPurpose.length === 0 ? (
          <span className="muted">{t('web.c360_money_none')}</span>
        ) : (
          <KV
            items={p.succeededByPurpose.map(
              (row) =>
                [
                  t(LEGACY_MONEY_PURPOSE_LABELS[row.purpose]),
                  <Total key={row.purpose} total={row.total} />,
                ] as [ReactNode, ReactNode],
            )}
          />
        )}
        {p.excludedByOutcome.length > 0 && (
          <>
            <h5>{t('web.c360_money_payments_excluded')}</h5>
            <KV
              items={p.excludedByOutcome.map(
                (row) =>
                  [
                    t(LEGACY_MONEY_OUTCOME_LABELS[row.outcome]),
                    <Total key={row.outcome} total={row.total} />,
                  ] as [ReactNode, ReactNode],
              )}
            />
          </>
        )}
      </section>

      <section className="stack">
        <h4>{t('web.c360_money_other')}</h4>
        <KV
          items={[
            [t('web.c360_money_wallet_in'), <Total key="in" total={w.moneyIn} />],
            [t('web.c360_money_wallet_out'), <Total key="out" total={w.moneyOut} />],
            [t('web.c360_money_wallet_zero'), <Num key="z" value={w.noChange} />],
            [t('web.c360_money_wheel_spins'), <Num key="ws" value={data.wheel.spins} />],
            [t('web.c360_money_wheel_won'), <Total key="ww" total={data.wheel.prizesWon} />],
            [t('web.c360_money_referee'), <Num key="re" value={data.referrals.asReferee} />],
            [t('web.c360_money_referrer'), <Num key="rr" value={data.referrals.asReferrer} />],
            [
              t('web.c360_money_referrer_gifts'),
              <Num key="rg" value={data.referrals.referrerGiftsPaid} />,
            ],
            [t('web.c360_money_discounts'), <Num key="dc" value={data.discountsUsed} />],
            ...data.serviceOperations.map(
              (row) =>
                [
                  <span key={`so-${row.status}`}>
                    {t('web.c360_money_service_ops')} <Ltr>{row.status}</Ltr>
                  </span>,
                  <Total key={row.status} total={row.total} />,
                ] as [ReactNode, ReactNode],
            ),
          ]}
        />
        <p className="muted small">{t('web.c360_money_amounts_note')}</p>
      </section>
    </div>
  );
}
