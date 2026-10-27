import { useCallback, useEffect, useState } from 'react';
import {
  MINIAPP_NOTIFICATION_WINDOW_DAYS,
  MINIAPP_ROUTES,
  miniAppNotificationReadResponseSchema,
  miniAppNotificationsResponseSchema,
  type MiniAppNotification,
} from '@nexa/contracts';
import { useApp } from '../app.js';
import { t } from '../i18n/t.js';
import { dateTime } from '../format.js';
import { Button, Card, Message, errorText } from '../ui.js';

/** The most the bell's badge writes before it says «more than»: a counter, not a statistic. */
const BADGE_MAX = 99;

/**
 * The bell in the header (Round 11, B1). Drawn by the shell only while `me.notifications` is
 * non-null, which the server answers only while the feature `notification_centre` is on; with
 * it off there is no bell and no request for the list is ever made.
 */
export function NotificationBell() {
  const { me, navigate } = useApp();
  if (me.notifications === null) return null;
  const unread = me.notifications.unreadCount;
  return (
    <header className="topbar">
      <button
        type="button"
        className="bell"
        aria-label={
          unread === 0
            ? t('miniapp.notifications_title')
            : t('miniapp.notifications_bell_unread', { count: unread })
        }
        onClick={() => navigate({ name: 'notifications' })}
      >
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" className="bell-icon">
          <path
            d="M12 3a6 6 0 0 0-6 6v3.2c0 .6-.2 1.2-.6 1.7L4 16.5V18h16v-1.5l-1.4-1.6a2.6 2.6 0 0 1-.6-1.7V9a6 6 0 0 0-6-6Zm-2.2 17a2.2 2.2 0 0 0 4.4 0"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {unread > 0 && (
          <span className="bell-badge" aria-hidden="true">
            {unread > BADGE_MAX ? `${BADGE_MAX}+` : unread}
          </span>
        )}
      </button>
    </header>
  );
}

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly error: unknown }
  | {
      readonly status: 'ready';
      readonly items: readonly MiniAppNotification[];
      readonly next: string | null;
      readonly unread: number;
    };

/**
 * اعلان‌ها: the bot messages already delivered to this customer, newest first, one page at a
 * time. A tap marks that message read; «همه خوانده شد» marks every one. The text is what the
 * bot sent, drawn as text: never as markup, never rewritten here.
 */
export function Notifications() {
  const { api, refreshMe } = useApp();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const page = useCallback(
    async (cursor: string | null) =>
      api.get(
        MINIAPP_ROUTES.notifications,
        {},
        miniAppNotificationsResponseSchema,
        cursor === null ? undefined : `cursor=${encodeURIComponent(cursor)}`,
      ),
    [api],
  );

  useEffect(() => {
    let live = true;
    page(null).then(
      (first) =>
        live &&
        setState({
          status: 'ready',
          items: first.items,
          next: first.nextCursor,
          unread: first.unreadCount,
        }),
      (error: unknown) => live && setState({ status: 'failed', error }),
    );
    return () => {
      live = false;
    };
  }, [page]);

  if (state.status === 'loading') return <Message text={t('miniapp.loading')} />;
  if (state.status === 'failed') {
    return (
      <Message
        text={errorText(state.error)}
        action={
          <Button
            onClick={() => {
              setState({ status: 'loading' });
              page(null).then(
                (first) =>
                  setState({
                    status: 'ready',
                    items: first.items,
                    next: first.nextCursor,
                    unread: first.unreadCount,
                  }),
                (error: unknown) => setState({ status: 'failed', error }),
              );
            }}
          >
            {t('miniapp.retry')}
          </Button>
        }
      />
    );
  }
  const ready = state;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await work();
    } catch (failure) {
      setNotice(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  const more = () =>
    run(async () => {
      if (ready.next === null) return;
      const following = await page(ready.next);
      setState({
        status: 'ready',
        items: [...ready.items, ...following.items],
        next: following.nextCursor,
        unread: following.unreadCount,
      });
    });

  const open = (item: MiniAppNotification) => {
    if (item.read) return;
    void run(async () => {
      const answer = await api.post(
        MINIAPP_ROUTES.notificationRead,
        { notificationId: item.id },
        miniAppNotificationReadResponseSchema,
      );
      setState((current) =>
        current.status === 'ready'
          ? {
              ...current,
              unread: answer.unreadCount,
              items: current.items.map((one) =>
                one.id === item.id ? { ...one, read: true } : one,
              ),
            }
          : current,
      );
      refreshMe().catch(() => undefined);
    });
  };

  const readAll = () =>
    run(async () => {
      const answer = await api.post(
        MINIAPP_ROUTES.notificationsReadAll,
        {},
        miniAppNotificationReadResponseSchema,
      );
      setState((current) =>
        current.status === 'ready'
          ? {
              ...current,
              unread: answer.unreadCount,
              items: current.items.map((one) => ({ ...one, read: true })),
            }
          : current,
      );
      refreshMe().catch(() => undefined);
    });

  return (
    <main className="page">
      <div className="section-head">
        <h1 className="title">{t('miniapp.notifications_title')}</h1>
        <Button onClick={() => void readAll()} disabled={busy || ready.unread === 0}>
          {t('miniapp.notifications_read_all')}
        </Button>
      </div>
      {notice !== null && (
        <p className="error" role="alert">
          {notice}
        </p>
      )}
      {ready.items.length === 0 ? (
        <Card>
          <p className="muted">{t('miniapp.notifications_empty')}</p>
        </Card>
      ) : (
        <Card className="notices">
          {ready.items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.read ? 'notice' : 'notice notice-unread'}
              disabled={busy}
              onClick={() => open(item)}
            >
              <span className="notice-meta">
                {!item.read && (
                  <span
                    className="notice-dot"
                    role="img"
                    aria-label={t('miniapp.notifications_unread')}
                  />
                )}
                <time dateTime={item.createdAt}>{dateTime(item.createdAt)}</time>
              </span>
              <span className="notice-text" dir="auto">
                {item.text}
              </span>
            </button>
          ))}
        </Card>
      )}
      {ready.next !== null && (
        <Button onClick={() => void more()} disabled={busy}>
          {t('miniapp.notifications_more')}
        </Button>
      )}
      <p className="muted">
        {t('miniapp.notifications_window', { days: MINIAPP_NOTIFICATION_WINDOW_DAYS })}
      </p>
    </main>
  );
}
