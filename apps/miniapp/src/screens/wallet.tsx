import { useState, type FormEvent, type ReactNode } from 'react';
import {
  MINIAPP_ROUTES,
  miniAppPaymentListSchema,
  miniAppTopupQuoteResponseSchema,
  miniAppTopupResponseSchema,
  miniAppWalletEntriesSchema,
  miniAppWalletResponseSchema,
  type MiniAppPaymentList,
  type MiniAppTopupQuoteResponse,
  type MiniAppWalletEntries,
  type MiniAppWalletResponse,
  type MoneyWire,
} from '@nexa/contracts';
import { ApiError } from '../api.js';
import { useApp } from '../app.js';
import { t } from '../i18n/t.js';
import { dateTime, money, parseAmountInput, signedMoney } from '../format.js';
import { openExternal } from '../telegram.js';
import { Button, Card, Loading, errorText, useLoad } from '../ui.js';
import { LEDGER_REASON_KEY, PAYMENT_METHOD_KEY, PAYMENT_STATE_KEY } from './wallet-labels.js';

/**
 * کیف پول: the balance, a top-up through the payment routes the server offers for that
 * amount (the bot's own chooser), and the customer's OWN history — the wallet ledger and
 * the payments list, newest first, read-only (owner correction 2026-10-25).
 *
 * Not drawn: the six-month spending chart (no spending history is read), the history
 * filter (the two lists are the filter), and a pending-top-up row inside the ledger (a
 * pending top-up is a payment; it is in the payments list, where it belongs).
 */
export function Wallet() {
  const { api } = useApp();
  const { loaded, reload } = useLoad(
    () => api.get(MINIAPP_ROUTES.wallet, {}, miniAppWalletResponseSchema),
    [api],
  );
  return (
    <main className="page">
      <h1 className="title">{t('miniapp.wallet_title')}</h1>
      <Loading loaded={loaded} reload={reload}>
        {(wallet) => (
          <>
            <Card className="balance">
              <span className="muted">{t('miniapp.wallet_balance')}</span>
              <strong className="figure">{money(wallet.balance)}</strong>
            </Card>
            <TopUp wallet={wallet} />
            <History />
          </>
        )}
      </Loading>
    </main>
  );
}

/** A route the top-up quote returned. */
type TopupRoute = Extract<MiniAppTopupQuoteResponse, { outcome: 'ROUTES' }>['routes'][number];

function TopUp({ wallet }: { wallet: MiniAppWalletResponse }) {
  const { api, navigate } = useApp();
  const currency = wallet.balance.currency;
  const [text, setText] = useState('');
  const [preset, setPreset] = useState<MoneyWire | null>(null);
  const [quoted, setQuoted] = useState<{ amount: MoneyWire; routes: TopupRoute[] } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const typed = text.trim() === '' ? null : parseAmountInput(text, currency);
  const amount = text.trim() === '' ? preset : typed;
  const invalid = text.trim() !== '' && typed === null;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await work();
    } catch (failure) {
      setNotice(walletErrorText(failure));
    } finally {
      setBusy(false);
    }
  };

  const choose = (next: MoneyWire | null, typedText: string) => {
    setPreset(next);
    setText(typedText);
    setQuoted(null);
    setNotice(null);
  };

  const quote = (event: FormEvent) => {
    event.preventDefault();
    if (amount === null) return;
    void run(async () => {
      const answer = await api.post(
        MINIAPP_ROUTES.walletTopupQuote,
        {},
        miniAppTopupQuoteResponseSchema,
        { amount },
      );
      if (answer.outcome === 'BELOW_MINIMUM') {
        setQuoted(null);
        setNotice(t('miniapp.wallet_below_minimum', { amount: money(answer.minimum) }));
      } else if (answer.outcome === 'ABOVE_MAXIMUM') {
        setQuoted(null);
        setNotice(t('miniapp.wallet_above_maximum', { amount: money(answer.maximum) }));
      } else {
        setQuoted({ amount: answer.amount, routes: answer.routes });
      }
    });
  };

  const request = (route: TopupRoute) =>
    run(async () => {
      if (quoted === null) return;
      const result = await api.post(MINIAPP_ROUTES.walletTopup, {}, miniAppTopupResponseSchema, {
        amount: quoted.amount,
        provider: route.provider,
      });
      if (result.kind === 'CARD_TO_CARD') {
        navigate({ name: 'card', instruction: result.instruction });
        return;
      }
      if (result.attempt.payUrl !== null) openExternal(result.attempt.payUrl);
      navigate({ name: 'pay', paymentId: result.attempt.paymentId });
    });

  return (
    <Card>
      <h2>{t('miniapp.wallet_topup_title')}</h2>
      {wallet.presets.length > 0 && (
        <div className="presets" role="group" aria-label={t('miniapp.wallet_topup_title')}>
          {wallet.presets.map((value) => (
            <button
              key={`${value.amountMinor}:${value.currency}`}
              type="button"
              className={
                text.trim() === '' && preset?.amountMinor === value.amountMinor
                  ? 'chip chip-on'
                  : 'chip'
              }
              aria-pressed={text.trim() === '' && preset?.amountMinor === value.amountMinor}
              onClick={() => choose(value, '')}
            >
              {money(value)}
            </button>
          ))}
        </div>
      )}
      <form className="inline-form" onSubmit={quote}>
        <label className="field">
          <span>{t('miniapp.wallet_custom_label')}</span>
          <input
            dir="ltr"
            inputMode="numeric"
            value={text}
            onChange={(event) => choose(null, event.target.value)}
            autoComplete="off"
          />
        </label>
        <Button type="submit" primary disabled={busy || amount === null}>
          {t('miniapp.wallet_continue')}
        </Button>
      </form>
      {(wallet.minimum !== null || wallet.maximum !== null) && (
        <p className="muted">
          {[
            wallet.minimum === null
              ? null
              : t('miniapp.wallet_minimum', { amount: money(wallet.minimum) }),
            wallet.maximum === null
              ? null
              : t('miniapp.wallet_maximum', { amount: money(wallet.maximum) }),
          ]
            .filter((part) => part !== null)
            .join(t('miniapp.list_separator'))}
        </p>
      )}
      {invalid && <p className="error">{t('miniapp.wallet_amount_invalid')}</p>}
      {notice !== null && <p className="error">{notice}</p>}
      {quoted !== null && (
        <section
          className="methods"
          aria-label={t('miniapp.wallet_routes_title', { amount: money(quoted.amount) })}
        >
          <h2>{t('miniapp.wallet_routes_title', { amount: money(quoted.amount) })}</h2>
          {quoted.routes.length === 0 && <p className="muted">{t('miniapp.wallet_no_routes')}</p>}
          {quoted.routes.map((route) => (
            <button
              key={route.provider}
              type="button"
              className="method"
              disabled={busy}
              onClick={() => void request(route)}
            >
              <strong>
                {route.kind === 'CARD_TO_CARD' ? t('miniapp.checkout_card') : route.name}
              </strong>
              <span className="muted">
                {[
                  route.paysInChat ? t('miniapp.checkout_in_chat') : null,
                  route.giftPercent > 0
                    ? t('miniapp.wallet_route_gift', { percent: route.giftPercent })
                    : null,
                ]
                  .filter((part) => part !== null)
                  .join(t('miniapp.list_separator'))}
              </span>
            </button>
          ))}
        </section>
      )}
    </Card>
  );
}

function walletErrorText(error: unknown): string {
  if (error instanceof ApiError && error.code === 'miniapp.route_unavailable') {
    return t('miniapp.wallet_route_unavailable');
  }
  return errorText(error);
}

type HistoryTab = 'entries' | 'payments';

function History() {
  const [tab, setTab] = useState<HistoryTab>('entries');
  return (
    <section className="section">
      <div className="section-head">
        <h2>{t('miniapp.wallet_history_title')}</h2>
      </div>
      <div className="chips" role="tablist">
        {(['entries', 'payments'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            className={tab === value ? 'chip chip-on' : 'chip'}
            onClick={() => setTab(value)}
          >
            {t(value === 'entries' ? 'miniapp.wallet_tab_entries' : 'miniapp.wallet_tab_payments')}
          </button>
        ))}
      </div>
      {tab === 'entries' ? <Entries /> : <Payments />}
    </section>
  );
}

/** A keyset page's query string: the cursor the server gave, URI-encoded. */
const cursorQuery = (cursor: string | null) =>
  cursor === null ? undefined : `cursor=${encodeURIComponent(cursor)}`;

function Entries() {
  const { api } = useApp();
  const load = (cursor: string | null) =>
    api.get(MINIAPP_ROUTES.walletEntries, {}, miniAppWalletEntriesSchema, cursorQuery(cursor));
  const { loaded, reload } = useLoad(() => load(null), [api]);
  return (
    <Loading loaded={loaded} reload={reload}>
      {(first: MiniAppWalletEntries) => (
        <Paged
          first={first}
          loadMore={load}
          empty={t('miniapp.wallet_entries_empty')}
          row={(entry) => (
            <li key={entry.id} className="tx">
              <span className="tx-main">
                <strong>{t(LEDGER_REASON_KEY[entry.reason])}</strong>
                <span className="muted">{dateTime(entry.createdAt)}</span>
              </span>
              <bdi
                dir="rtl"
                className={entry.direction === 'CREDIT' ? 'amount amount-credit' : 'amount'}
              >
                {signedMoney(entry.direction, entry.amount)}
              </bdi>
            </li>
          )}
        />
      )}
    </Loading>
  );
}

function Payments() {
  const { api, navigate } = useApp();
  const load = (cursor: string | null) =>
    api.get(MINIAPP_ROUTES.payments, {}, miniAppPaymentListSchema, cursorQuery(cursor));
  const { loaded, reload } = useLoad(() => load(null), [api]);
  return (
    <Loading loaded={loaded} reload={reload}>
      {(first: MiniAppPaymentList) => (
        <Paged
          first={first}
          loadMore={load}
          empty={t('miniapp.wallet_payments_empty')}
          row={(payment) => (
            <li key={payment.id} className="tx">
              <button
                type="button"
                className="tx-open"
                onClick={() => navigate({ name: 'pay', paymentId: payment.id })}
              >
                <span className="tx-main">
                  <strong>
                    {payment.topup
                      ? t('miniapp.wallet_payment_topup')
                      : t('miniapp.wallet_payment_order')}
                  </strong>
                  <span className="muted">
                    {[
                      t(PAYMENT_METHOD_KEY[payment.method]),
                      t(PAYMENT_STATE_KEY[payment.state]),
                      dateTime(payment.createdAt),
                    ].join(t('miniapp.list_separator'))}
                  </span>
                </span>
                <span className="amount">{money(payment.amount)}</span>
              </button>
            </li>
          )}
        />
      )}
    </Loading>
  );
}

interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/** A keyset list: the first page already read, the rest on demand, each page appended. */
function Paged<T extends { readonly id: string }>({
  first,
  loadMore,
  empty,
  row,
}: {
  first: Page<T>;
  loadMore: (cursor: string) => Promise<Page<T>>;
  empty: string;
  row: (item: T) => ReactNode;
}) {
  const [extra, setExtra] = useState<readonly T[]>([]);
  const [next, setNext] = useState(first.nextCursor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = [
    ...first.items,
    ...extra.filter((item) => !first.items.some((x) => x.id === item.id)),
  ];

  const more = async () => {
    if (next === null) return;
    setBusy(true);
    setError(null);
    try {
      const page = await loadMore(next);
      setExtra((current) => [...current, ...page.items]);
      setNext(page.nextCursor);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  if (items.length === 0) return <p className="muted">{empty}</p>;
  return (
    <Card>
      <ul className="list tx-list">{items.map(row)}</ul>
      {error !== null && <p className="error">{error}</p>}
      {next !== null && (
        <Button disabled={busy} onClick={() => void more()}>
          {t('miniapp.wallet_more')}
        </Button>
      )}
    </Card>
  );
}
