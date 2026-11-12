import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LedgerReason, MoneyWire, ResellerTierProgress } from '@nexa/contracts';
import { errorText } from '../../error-text';
import { formatMoneyText, formatNumber, formatRelative } from '../../format';
import { t } from '../../i18n/web.fa';
import { LEDGER_REASON_LABELS } from '../../pages/mirza-labels';
import { useSubmissionKey } from '../../submission-key';
import { JALALI_MONTH_KEYS, toJalali } from '../../ui/jalali';
import { Button, Empty, Progress, StateSwitch, useToast } from '../../ui/kit';
import { fetchDashboard, fetchTierProgress, fetchTrial, makeTrial } from '../api';
import { SCREEN_PATHS, goTo } from '../route';
import { Expiry, RpCard, Usage, signedAmountText } from '../view';
import { ServiceDrawer } from './service-drawer';

export const DASHBOARD_KEY = ['reseller', 'dashboard'] as const;

export function ledgerReasonText(reason: string): string {
  return Object.hasOwn(LEDGER_REASON_LABELS, reason)
    ? t(LEDGER_REASON_LABELS[reason as LedgerReason])
    : t('web.ledger_reason_other');
}

export function RpStat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rp-card rp-stat">
      <small>{label}</small>
      <strong>{value}</strong>
      {note !== undefined && <em>{note}</em>}
    </div>
  );
}

export const TRIAL_KEY = ['reseller', 'trial'] as const;
export const TIER_PROGRESS_KEY = ['reseller', 'tier-progress'] as const;

/**
 * «سرویس تست — امروز: x از N»: drawn only while `GET /trial` says the reseller has a trial to
 * give (quota above 0, a trial product chosen and switched on). A refused or failed read draws
 * nothing — the card is an extra, never a reason to hide the dashboard.
 */
export function TrialCard() {
  const toast = useToast();
  const client = useQueryClient();
  const query = useQuery({ queryKey: TRIAL_KEY, queryFn: fetchTrial });
  const submission = useSubmissionKey();
  const make = useMutation({
    mutationFn: () => makeTrial(submission.current(query.data?.usedToday ?? 0)),
    onSuccess: (issued) => {
      submission.settle();
      client.setQueryData(TRIAL_KEY, {
        enabled: true,
        quota: issued.quota,
        usedToday: issued.usedToday,
      });
      toast({ tone: 'ok', message: t('web.rp_trial_made') });
      void client.invalidateQueries({ queryKey: ['reseller', 'services'] });
      void client.invalidateQueries({ queryKey: DASHBOARD_KEY });
    },
    onError: (error) => {
      submission.settleOn(error);
      toast({ tone: 'danger', message: errorText(error), error });
      void client.invalidateQueries({ queryKey: TRIAL_KEY });
    },
  });
  const status = query.data;
  if (status === undefined || !status.enabled || status.quota <= 0) return null;
  return (
    <RpCard title={t('web.rp_trial_title')} hint={t('web.rp_trial_hint')}>
      <div className="rp-line rp-between">
        <span className="muted">
          {t('web.rp_trial_today')
            .replace('{used}', formatNumber(status.usedToday))
            .replace('{quota}', formatNumber(status.quota))}
        </span>
        <Button
          size="sm"
          variant="primary"
          disabled={make.isPending || status.usedToday >= status.quota}
          onClick={() => make.mutate()}
        >
          {t('web.rp_trial_make')}
        </Button>
      </div>
    </RpCard>
  );
}

/** The Jalali month the progress runs to: `monthEnd` is the first instant AFTER the month. */
export function progressMonthName(monthEnd: string): string {
  const last = new Date(Date.parse(monthEnd) - 12 * 3_600_000);
  if (Number.isNaN(last.getTime())) return '';
  const j = toJalali({
    gy: last.getUTCFullYear(),
    gm: last.getUTCMonth() + 1,
    gd: last.getUTCDate(),
  });
  return t(JALALI_MONTH_KEYS[j.jm - 1] ?? 'web.jalali_m1');
}

function targetAmountOf(progress: ResellerTierProgress): MoneyWire | null {
  return progress.target?.kind === 'AMOUNT' ? progress.target.amount : null;
}

/**
 * «پیشرفت تا سطح بعد»: the bar, «x از N سرویس این ماه» and what is left to the month's end.
 * Drawn only when the API says `shown` (the flag is on and the tier has a target).
 */
export function TierProgressBlock() {
  const query = useQuery({ queryKey: TIER_PROGRESS_KEY, queryFn: fetchTierProgress });
  const progress = query.data;
  if (progress === undefined || !progress.shown || progress.target === null) return null;
  const month = progressMonthName(progress.monthEnd);
  const amountTarget = targetAmountOf(progress);
  const reached =
    amountTarget !== null
      ? progress.remainingAmount === null || BigInt(progress.remainingAmount.amountMinor) <= 0n
      : (progress.remainingCount ?? 0) <= 0;
  const value: number | bigint =
    amountTarget !== null ? BigInt(progress.amount?.amountMinor ?? '0') : progress.count;
  const max: number | bigint =
    amountTarget !== null
      ? BigInt(amountTarget.amountMinor)
      : progress.target.kind === 'COUNT'
        ? progress.target.count
        : 0;
  return (
    <div className="rp-progress">
      <div className="rp-line rp-between">
        <b className="small">{t('web.rp_progress_title')}</b>
        <span className="muted small">
          {amountTarget !== null
            ? t('web.rp_progress_amount')
                .replace(
                  '{amount}',
                  formatMoneyText(progress.amount ?? { ...amountTarget, amountMinor: '0' }),
                )
                .replace('{target}', formatMoneyText(amountTarget))
            : t('web.rp_progress_count')
                .replace('{count}', formatNumber(progress.count))
                .replace(
                  '{target}',
                  formatNumber(progress.target.kind === 'COUNT' ? progress.target.count : 0),
                )}
        </span>
      </div>
      <Progress value={value} max={max} label={t('web.rp_progress_bar')} tone="violet" size="lg" />
      <span className="muted small">
        {reached
          ? t('web.rp_progress_reached')
          : amountTarget !== null && progress.remainingAmount !== null
            ? t('web.rp_progress_left_amount')
                .replace('{amount}', formatMoneyText(progress.remainingAmount))
                .replace('{month}', month)
            : t('web.rp_progress_left_count')
                .replace('{n}', formatNumber(progress.remainingCount ?? 0))
                .replace('{month}', month)}
      </span>
    </div>
  );
}

/**
 * «داشبورد»: balance, active services, this month's sales, the expiring count and list, the
 * tier (with its progress to the next one when the owner shows it), the trial card (when the
 * reseller has trials to give) and the last transactions.
 */
export function DashboardPage() {
  const query = useQuery({ queryKey: DASHBOARD_KEY, queryFn: fetchDashboard });
  const [renewing, setRenewing] = useState<string | null>(null);
  const data = query.data;
  return (
    <StateSwitch query={query}>
      {data !== undefined && (
        <>
          <div className="rp-grid4">
            <RpStat
              label={t('web.rp_stat_balance')}
              value={formatMoneyText(data.balance)}
              note={t('web.rp_stat_balance_note')}
            />
            <RpStat label={t('web.rp_stat_active')} value={formatNumber(data.activeServices)} />
            <RpStat
              label={t('web.rp_stat_sales')}
              value={
                data.monthSales.amount.length === 0
                  ? '—'
                  : data.monthSales.amount.map((money) => formatMoneyText(money)).join(' + ')
              }
              note={t('web.rp_stat_sales_count').replace(
                '{n}',
                formatNumber(data.monthSales.count),
              )}
            />
            <RpStat
              label={t('web.rp_stat_expiring')}
              value={formatNumber(data.expiringCount)}
              note={t('web.rp_stat_expiring_note')}
            />
          </div>
          <div className="rp-split">
            <div className="rp-grow">
              <RpCard
                title={t('web.rp_expiring_title')}
                hint={t('web.rp_expiring_hint')}
                actions={
                  <Button
                    size="sm"
                    onClick={() => goTo(`${SCREEN_PATHS.services}?filter=EXPIRING`)}
                  >
                    {t('web.rp_all')}
                  </Button>
                }
              >
                {data.expiring.length === 0 ? (
                  <Empty variant="compact" title={t('web.rp_expiring_empty')} />
                ) : (
                  <div className="rp-table-wrap">
                    <table className="rp-table">
                      <thead>
                        <tr>
                          <th>{t('web.rp_col_user')}</th>
                          <th>{t('web.rp_col_note')}</th>
                          <th>{t('web.rp_col_usage')}</th>
                          <th>{t('web.rp_col_expiry')}</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {data.expiring.map((row) => (
                          <tr key={row.id}>
                            <td dir="ltr" className="rp-mono">
                              {row.username}
                            </td>
                            <td>{row.note ?? '—'}</td>
                            <td>
                              <Usage row={row} />
                            </td>
                            <td>
                              <Expiry row={row} />
                            </td>
                            <td className="rp-end">
                              <Button size="sm" onClick={() => setRenewing(row.id)}>
                                {t('web.rp_renew')}
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </RpCard>
              <RpCard title={t('web.rp_tx_title')} hint={t('web.rp_tx_hint')}>
                {data.recentTransactions.length === 0 ? (
                  <Empty variant="compact" title={t('web.rp_tx_empty')} />
                ) : (
                  <ul className="rp-list rp-list-inline">
                    {data.recentTransactions.map((tx) => (
                      <li key={tx.id}>
                        <div>
                          <b>{ledgerReasonText(tx.reason)}</b>
                          <span className="muted small">{formatRelative(tx.at)}</span>
                        </div>
                        <b className={tx.direction === 'CREDIT' ? 'ok' : undefined}>
                          {signedAmountText(tx.direction, tx.amount)}
                        </b>
                      </li>
                    ))}
                  </ul>
                )}
              </RpCard>
            </div>
            <div className="rp-aside">
              <RpCard title={t('web.rp_tier_title')} hint={t('web.rp_tier_hint')}>
                <div className="rp-line">
                  <span className="badge violet">{data.tier.name}</span>
                  {data.tier.discountPercent !== null && data.tier.discountPercent > 0 && (
                    <span className="muted small">
                      {t('web.rp_tier_discount').replace(
                        '{n}',
                        formatNumber(data.tier.discountPercent),
                      )}
                    </span>
                  )}
                </div>
                <TierProgressBlock />
                <div className="rp-gap">
                  <Button size="sm" onClick={() => goTo(SCREEN_PATHS.prices)}>
                    {t('web.rp_see_prices')}
                  </Button>
                </div>
              </RpCard>
              <TrialCard />
            </div>
          </div>
          {renewing !== null && (
            <ServiceDrawer
              serviceId={renewing}
              initialTab="renew"
              onClose={() => setRenewing(null)}
            />
          )}
        </>
      )}
    </StateSwitch>
  );
}
