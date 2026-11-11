import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { RESELLER_SERVICE_FILTERS, type ResellerServiceFilter } from '@nexa/contracts';
import { formatNumber } from '../../format';
import { t, type WebKey } from '../../i18n/web.fa';
import { Badge, Button, Empty, SearchInput, StateSwitch } from '../../ui/kit';
import { fetchServices } from '../api';
import { Expiry, RpCard, StateBadge, Usage } from '../view';
import { ServiceDrawer } from './service-drawer';

const FILTER_LABEL: Readonly<Record<ResellerServiceFilter, WebKey>> = {
  ALL: 'web.rp_filter_all',
  ACTIVE: 'web.rp_filter_active',
  EXPIRING: 'web.rp_filter_expiring',
  EXPIRED: 'web.rp_filter_expired',
  SUSPENDED: 'web.rp_filter_suspended',
  OTHER: 'web.rp_filter_other',
};

export const SERVICES_KEY = ['reseller', 'services'] as const;

function initialFilter(search: string): ResellerServiceFilter {
  const wanted = new URLSearchParams(search).get('filter');
  return RESELLER_SERVICE_FILTERS.find((filter) => filter === wanted) ?? 'ALL';
}

/**
 * «سرویس‌های من»: filter chips with server counts, search, the table and the «مدیریت» drawer.
 *
 * The «مشتری» column is drawn only when a row carries a client, and there is no auto-renew
 * switch column: the wire has neither a client nor an auto-renew flag yet (PR-5), and a column
 * of dashes or a dead switch would be a fabricated feature.
 */
export function ServicesPage({ search = '' }: { search?: string }) {
  const [filter, setFilter] = useState<ResellerServiceFilter>(() => initialFilter(search));
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);

  // The search box waits for a pause in typing; every change starts again from the first page.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQ(draft);
      setPage(0);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [draft]);

  const query = useQuery({
    queryKey: [...SERVICES_KEY, filter, q, page],
    queryFn: () => fetchServices({ filter, q, page }),
    placeholderData: keepPreviousData,
  });
  const data = query.data;
  const showClient = data?.items.some((row) => row.client !== null) === true;

  return (
    <RpCard>
      <div className="rp-toolbar">
        <div className="rp-chips" role="group" aria-label={t('web.rp_filters_label')}>
          {RESELLER_SERVICE_FILTERS.map((one) => (
            <button
              key={one}
              type="button"
              className={`rp-chip${one === filter ? ' on' : ''}`}
              aria-pressed={one === filter}
              onClick={() => {
                setFilter(one);
                setPage(0);
              }}
            >
              {t(FILTER_LABEL[one])}
              {data !== undefined && <b>{formatNumber(data.counts[one] ?? 0)}</b>}
            </button>
          ))}
        </div>
        <SearchInput
          value={draft}
          onChange={setDraft}
          label={t('web.rp_search_label')}
          placeholder={t('web.rp_search_ph')}
        />
      </div>
      <StateSwitch
        query={query}
        isEmpty={data?.items.length === 0}
        empty={<Empty title={t('web.rp_services_empty')} />}
      >
        {data !== undefined && (
          <>
            <div className="rp-table-wrap">
              <table className="rp-table">
                <thead>
                  <tr>
                    <th>{t('web.rp_col_user')}</th>
                    {showClient && <th>{t('web.rp_col_client')}</th>}
                    <th>{t('web.rp_col_note')}</th>
                    <th>{t('web.rp_col_product')}</th>
                    <th>{t('web.rp_col_location')}</th>
                    <th>{t('web.rp_col_usage')}</th>
                    <th>{t('web.rp_col_expiry')}</th>
                    <th>{t('web.rp_col_status')}</th>
                    <th>
                      <span className="visually-hidden">{t('web.rp_col_manage')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((row) => (
                    <tr key={row.id}>
                      <td dir="ltr" className="rp-mono">
                        {row.username}{' '}
                        {row.isTrial && (
                          <Badge tone="violet" outline>
                            {t('web.rp_trial')}
                          </Badge>
                        )}
                      </td>
                      {showClient && <td>{row.client ?? '—'}</td>}
                      <td>{row.note ?? '—'}</td>
                      <td>{row.product ?? '—'}</td>
                      <td>{row.location ?? '—'}</td>
                      <td>
                        <Usage row={row} />
                      </td>
                      <td>
                        <Expiry row={row} />
                      </td>
                      <td>
                        <StateBadge state={row.state} />
                      </td>
                      <td className="rp-end">
                        <Button size="sm" onClick={() => setOpenId(row.id)}>
                          {t('web.rp_manage')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.pages > 1 && (
              <nav className="rp-pager" aria-label={t('web.rp_page_of')}>
                <Button size="sm" disabled={page <= 0} onClick={() => setPage(page - 1)}>
                  {t('web.rp_page_prev')}
                </Button>
                <span className="muted small">
                  {t('web.rp_page_of')
                    .replace('{page}', formatNumber(data.page + 1))
                    .replace('{pages}', formatNumber(data.pages))}
                </span>
                <Button
                  size="sm"
                  disabled={page + 1 >= data.pages}
                  onClick={() => setPage(page + 1)}
                >
                  {t('web.rp_page_next')}
                </Button>
              </nav>
            )}
          </>
        )}
      </StateSwitch>
      {openId !== null && <ServiceDrawer serviceId={openId} onClose={() => setOpenId(null)} />}
    </RpCard>
  );
}
