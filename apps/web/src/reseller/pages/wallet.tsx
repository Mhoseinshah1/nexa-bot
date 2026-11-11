import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { RESELLER_WALLET_FILTERS } from '@nexa/contracts';
import { formatRelative } from '../../format';
import { t, type WebKey } from '../../i18n/web.fa';
import { Banner, Button, Empty, StateSwitch } from '../../ui/kit';
import { fetchWalletEntries } from '../api';
import { RpCard, signedAmountText } from '../view';
import { ledgerReasonText } from './dashboard';
import { TopupCard } from './wallet-topup';

type Direction = (typeof RESELLER_WALLET_FILTERS)[number];

const DIRECTION_LABEL: Readonly<Record<Direction, WebKey>> = {
  ALL: 'web.rp_history_all',
  CREDIT: 'web.rp_history_credit',
  DEBIT: 'web.rp_history_debit',
};

/** The wallet: the top-up form with the history BESIDE it (owner layout decision). */
export function WalletPage() {
  return (
    <>
      <div className="rp-split rp-stretch">
        <div className="rp-grow rp-wallet-form">
          <TopupCard />
        </div>
        <div className="rp-grow rp-wallet-history">
          <History />
        </div>
      </div>
      <Banner tone="info">{t('web.rp_wallet_rule')}</Banner>
    </>
  );
}

function History() {
  const [direction, setDirection] = useState<Direction>('ALL');
  const query = useInfiniteQuery({
    queryKey: ['reseller', 'wallet-entries', direction],
    queryFn: ({ pageParam }) => fetchWalletEntries(direction, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <RpCard
      title={t('web.rp_history_title')}
      hint={t('web.rp_history_hint')}
      actions={
        <div className="rp-chips" role="group" aria-label={t('web.rp_history_filters')}>
          {RESELLER_WALLET_FILTERS.map((one) => (
            <button
              key={one}
              type="button"
              className={`rp-chip${one === direction ? ' on' : ''}`}
              aria-pressed={one === direction}
              onClick={() => setDirection(one)}
            >
              {t(DIRECTION_LABEL[one])}
            </button>
          ))}
        </div>
      }
    >
      <StateSwitch
        query={query}
        isEmpty={items.length === 0}
        empty={<Empty variant="compact" title={t('web.rp_history_empty')} />}
      >
        <ul className="rp-list">
          {items.map((entry) => (
            <li key={entry.id}>
              <div>
                <b>{ledgerReasonText(entry.reason)}</b>
                <span className="muted small">{formatRelative(entry.createdAt)}</span>
              </div>
              <b className={entry.direction === 'CREDIT' ? 'ok' : undefined}>
                {signedAmountText(entry.direction, entry.amount)}
              </b>
            </li>
          ))}
        </ul>
        {query.hasNextPage && (
          <div className="rp-more">
            <Button
              size="sm"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {t('web.rp_history_more')}
            </Button>
          </div>
        )}
      </StateSwitch>
    </RpCard>
  );
}
