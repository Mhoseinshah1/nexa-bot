import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { LedgerReason } from '@nexa/contracts';
import { formatMoneyText, formatNumber, formatRelative } from '../../format';
import { t } from '../../i18n/web.fa';
import { LEDGER_REASON_LABELS } from '../../pages/mirza-labels';
import { Button, Empty, StateSwitch } from '../../ui/kit';
import { fetchDashboard } from '../api';
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

/**
 * «داشبورد»: only what the dashboard endpoint returns now — balance, active services, this
 * month's sales, the expiring count and list, the tier and the last transactions. There is no
 * trial card and no tier-progress card here (they arrive with their own endpoints).
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
                <div className="rp-gap">
                  <Button size="sm" onClick={() => goTo(SCREEN_PATHS.prices)}>
                    {t('web.rp_see_prices')}
                  </Button>
                </div>
              </RpCard>
              <RpCard title={t('web.rp_tx_title')} hint={t('web.rp_tx_hint')}>
                {data.recentTransactions.length === 0 ? (
                  <Empty variant="compact" title={t('web.rp_tx_empty')} />
                ) : (
                  <ul className="rp-list">
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
