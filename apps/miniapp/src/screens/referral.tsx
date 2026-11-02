import { useState } from 'react';
import {
  MINIAPP_ROUTES,
  miniAppReferralFriendsResponseSchema,
  miniAppReferralResponseSchema,
  type MiniAppReferralFriendStatus,
} from '@nexa/contracts';
import { useApp } from '../app.js';
import { t, type MiniAppKey } from '../i18n/t.js';
import { dateOnly, money } from '../format.js';
import { openTelegram } from '../telegram.js';
import { Button, Card, Loading, Ltr, errorText, useLoad } from '../ui.js';

/**
 * دعوت دوستان: the program's commission, the customer's own invite link (the bot's
 * `t.me/<bot>?start=ref-…` link, minted once) with share and copy, and their three figures.
 * The program being off is said in the bot's own sentence.
 *
 * R11 B3: below the figures, the customer's own invited friends (`Friends`), only while the
 * `referral_friends_list` flag is on. The server decides that and masks every name; this
 * screen draws what it is given and never asks for an id, a phone or a last name.
 */

const STATUS_KEY: Readonly<Record<MiniAppReferralFriendStatus, MiniAppKey>> = {
  JOINED: 'miniapp.referral_friend_status_joined',
  PURCHASED: 'miniapp.referral_friend_status_purchased',
  REWARD_PENDING: 'miniapp.referral_friend_status_reward_pending',
  REWARD_PAID: 'miniapp.referral_friend_status_reward_paid',
};

const friendsQuery = (cursor: string | null) =>
  cursor === null ? undefined : `cursor=${encodeURIComponent(cursor)}`;

type FriendsPage = ReturnType<typeof miniAppReferralFriendsResponseSchema.parse>;
type EnabledFriends = Extract<FriendsPage, { enabled: true }>;

/** The summary counts, then the friends newest first, a page at a time; nothing while the flag is off. */
function Friends() {
  const { api } = useApp();
  const load = (cursor: string | null) =>
    api.get(
      MINIAPP_ROUTES.referralFriends,
      {},
      miniAppReferralFriendsResponseSchema,
      friendsQuery(cursor),
    );
  const { loaded, reload } = useLoad(() => load(null), [api]);
  return (
    <Loading loaded={loaded} reload={reload}>
      {(first) => (first.enabled ? <FriendsList first={first} load={load} /> : null)}
    </Loading>
  );
}

function FriendsList({
  first,
  load,
}: {
  first: EnabledFriends;
  load: (cursor: string) => Promise<FriendsPage>;
}) {
  const [extra, setExtra] = useState<EnabledFriends['items']>([]);
  const [next, setNext] = useState(first.nextCursor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const more = async () => {
    if (next === null) return;
    setBusy(true);
    setError(null);
    try {
      const page = await load(next);
      if (page.enabled) {
        setExtra((current) => [...current, ...page.items]);
        setNext(page.nextCursor);
      } else {
        setNext(null);
      }
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  const items = [...first.items, ...extra];
  const counts: readonly [MiniAppReferralFriendStatus, number][] = [
    ['JOINED', first.counts.joined],
    ['PURCHASED', first.counts.purchased],
    ['REWARD_PENDING', first.counts.rewardPending],
    ['REWARD_PAID', first.counts.rewardPaid],
  ];
  return (
    <Card>
      <h2 className="lead">{t('miniapp.referral_friends_title')}</h2>
      <p className="muted">{t('miniapp.referral_friends_total', { count: first.counts.total })}</p>
      <div className="friend-counts">
        {counts.map(([status, count]) => (
          <span key={status} className="stat">
            <b>{count}</b>
            <span className="muted">{t(STATUS_KEY[status])}</span>
          </span>
        ))}
      </div>
      {items.length === 0 ? (
        <p className="muted">{t('miniapp.referral_friends_empty')}</p>
      ) : (
        <ul className="list tx-list">
          {items.map((friend, index) => (
            <li key={`${friend.joinedAt}:${String(index)}`} className="tx">
              <span className="tx-main">
                <span className="friend-name">
                  {friend.displayName === null ? (
                    t('miniapp.referral_friend_unnamed')
                  ) : (
                    <bdi>{friend.displayName}</bdi>
                  )}
                </span>
                <span className="muted">
                  {t('miniapp.referral_friend_joined_on', { date: dateOnly(friend.joinedAt) })}
                </span>
                {friend.rewardNotBefore !== null && (
                  <span className="muted">
                    {t('miniapp.referral_friend_held_until', {
                      date: dateOnly(friend.rewardNotBefore),
                    })}
                  </span>
                )}
              </span>
              <span
                className={
                  friend.status === 'REWARD_PAID'
                    ? 'badge badge-ok'
                    : friend.status === 'REWARD_PENDING'
                      ? 'badge badge-warn'
                      : 'badge'
                }
              >
                {t(STATUS_KEY[friend.status])}
              </span>
            </li>
          ))}
        </ul>
      )}
      {error !== null && <p className="error">{error}</p>}
      {next !== null && (
        <Button disabled={busy} onClick={() => void more()}>
          {t('miniapp.referral_friends_more')}
        </Button>
      )}
    </Card>
  );
}

export function Referral() {
  const { api } = useApp();
  const { loaded, reload } = useLoad(
    () => api.get(MINIAPP_ROUTES.referral, {}, miniAppReferralResponseSchema),
    [api],
  );
  const [copy, setCopy] = useState<'idle' | 'done' | 'failed'>('idle');
  return (
    <main className="page">
      <h1 className="title">{t('miniapp.referral_title')}</h1>
      <Loading loaded={loaded} reload={reload}>
        {(referral) =>
          !referral.active ? (
            <p className="muted">{t('miniapp.referral_inactive')}</p>
          ) : (
            <>
              <Card>
                <p className="lead">
                  {t('miniapp.referral_headline', { percent: referral.commissionPercent })}
                </p>
                <p className="muted">{t('miniapp.referral_note')}</p>
                <div className="link-box">
                  <Ltr>{referral.inviteLink}</Ltr>
                </div>
                <div className="actions">
                  <Button
                    primary
                    onClick={() =>
                      openTelegram(
                        `https://t.me/share/url?url=${encodeURIComponent(referral.inviteLink)}`,
                      )
                    }
                  >
                    {t('miniapp.referral_share')}
                  </Button>
                  <Button
                    onClick={() => {
                      navigator.clipboard.writeText(referral.inviteLink).then(
                        () => setCopy('done'),
                        () => setCopy('failed'),
                      );
                    }}
                  >
                    {copy === 'done' ? t('miniapp.copied') : t('miniapp.referral_copy')}
                  </Button>
                </div>
                {copy === 'failed' && <p className="error">{t('miniapp.referral_copy_failed')}</p>}
              </Card>
              {referral.stats !== null && (
                <Card>
                  <div className="stats">
                    <span className="stat">
                      <b>{referral.stats.referralCount}</b>
                      <span className="muted">{t('miniapp.referral_stat_invited')}</span>
                    </span>
                    <span className="stat">
                      <b>{referral.stats.referredPurchaseCount}</b>
                      <span className="muted">{t('miniapp.referral_stat_purchased')}</span>
                    </span>
                    <span className="stat">
                      <b>{money(referral.stats.commissionReceivedTotal)}</b>
                      <span className="muted">{t('miniapp.referral_stat_earned')}</span>
                    </span>
                  </div>
                </Card>
              )}
              <Friends />
              <Card>
                <ol className="list">
                  <li>{t('miniapp.referral_step_1')}</li>
                  <li>{t('miniapp.referral_step_2')}</li>
                  <li>{t('miniapp.referral_step_3')}</li>
                </ol>
              </Card>
            </>
          )
        }
      </Loading>
    </main>
  );
}
