import { useState, type FormEvent } from 'react';
import {
  MINIAPP_ROUTES,
  miniAppCardInstructionSchema,
  miniAppGatewayAttemptSchema,
  miniAppOrderSchema,
  miniAppPaymentRoutesResponseSchema,
  miniAppWalletPayResponseSchema,
  type MiniAppOrder,
  type MiniAppPaymentRoutesResponse,
} from '@nexa/contracts';
import { CATALOGUE_FA, formatDurationDays } from '@nexa/i18n';
import { useApp } from '../app.js';
import { t } from '../i18n/t.js';
import { dateTime, money, trafficLimit } from '../format.js';
import { Sheet } from '../sheet.js';
import { openExternal } from '../telegram.js';
import { Button, Card, Loading, Ltr, Row, errorText, useLoad } from '../ui.js';

/**
 * R12 F3 item 5: the custom-username rule, the bot's own lines (`bot.username.instructions`
 * without its opening request) — so both surfaces state the same rule the shared validator
 * enforces.
 */
const USERNAME_RULE: readonly string[] = CATALOGUE_FA['bot.username.instructions']
  .split('\n')
  .slice(1)
  .map((line) => line.replace(/^•\s*/u, ''));

/** What the customer chose to pay with: the wallet, or one route the server offered. */
type Method =
  | { readonly kind: 'WALLET' }
  | { readonly kind: 'ROUTE'; readonly route: MiniAppPaymentRoutesResponse['routes'][number] };

/**
 * پیش‌فاکتور و روش پرداخت: every figure from the order's frozen totals (the quote is
 * honoured, never re-priced), a discount code through the one pricing boundary, the
 * username step the panel asks for, and ONLY the payment routes the server returns for
 * this order — the design's five fixed tiles are never drawn as such.
 *
 * Not drawn: an extra-device line on a new purchase (an order has one line; extra devices
 * are their own order on an existing service), and a per-order terms checkbox (the terms
 * are the bot's one-time gate, enforced before this screen is reachable).
 */
export function Checkout({ orderId }: { orderId: string }) {
  const { api } = useApp();
  const { loaded, reload } = useLoad(async () => {
    const order = await api.get(MINIAPP_ROUTES.order, { orderId }, miniAppOrderSchema);
    const payable = order.state === 'DRAFT' || order.state === 'AWAITING_PAYMENT';
    const routes = payable
      ? await api.get(MINIAPP_ROUTES.orderRoutes, { orderId }, miniAppPaymentRoutesResponseSchema)
      : null;
    return { order, routes };
  }, [api, orderId]);
  return (
    <main className="page">
      <h1 className="title">{t('miniapp.checkout_title')}</h1>
      <Loading loaded={loaded} reload={reload}>
        {({ order, routes }) => <Invoice order={order} routes={routes} reload={reload} />}
      </Loading>
    </main>
  );
}

function Invoice({
  order,
  routes,
  reload,
}: {
  order: MiniAppOrder;
  routes: MiniAppPaymentRoutesResponse | null;
  reload: () => void;
}) {
  const { api, replace } = useApp();
  const [method, setMethod] = useState<Method | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [username, setUsername] = useState('');
  // R12 F3 item 5: «لغو سفارش» asks before it cancels (the bot asks too).
  const [confirmCancel, setConfirmCancel] = useState(false);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  const applyCode = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await api.put(MINIAPP_ROUTES.orderDiscount, { orderId: order.id }, miniAppOrderSchema, {
        code: code.trim(),
      });
      setCode('');
      reload();
    });
  };
  const removeCode = () =>
    run(async () => {
      await api.put(MINIAPP_ROUTES.orderDiscount, { orderId: order.id }, miniAppOrderSchema, {
        code: null,
      });
      reload();
    });
  const chooseUsername = (body: { mode: 'AUTOMATIC' } | { mode: 'CUSTOM'; username: string }) =>
    run(async () => {
      await api.post(MINIAPP_ROUTES.orderUsername, { orderId: order.id }, miniAppOrderSchema, body);
      reload();
    });
  const cancel = () =>
    run(async () => {
      await api.post(MINIAPP_ROUTES.orderCancel, { orderId: order.id }, miniAppOrderSchema);
      reload();
    });

  const pay = () =>
    run(async () => {
      if (method === null) return;
      if (method.kind === 'WALLET') {
        const paid = await api.post(
          MINIAPP_ROUTES.orderPayWallet,
          { orderId: order.id },
          miniAppWalletPayResponseSchema,
        );
        replace({ name: 'pay', paymentId: paid.paymentId });
        return;
      }
      if (method.route.kind === 'CARD_TO_CARD') {
        const instruction = await api.post(
          MINIAPP_ROUTES.orderPayCard,
          { orderId: order.id },
          miniAppCardInstructionSchema,
        );
        replace({ name: 'card', instruction });
        return;
      }
      const attempt = await api.post(
        MINIAPP_ROUTES.orderPayGateway,
        { orderId: order.id },
        miniAppGatewayAttemptSchema,
        { provider: method.route.provider },
      );
      if (attempt.payUrl !== null) openExternal(attempt.payUrl);
      replace({ name: 'pay', paymentId: attempt.paymentId });
    });

  const discounted = order.discount.amountMinor !== '0';
  const payable = routes !== null;
  return (
    <>
      <Card>
        <Row label={t('miniapp.checkout_order')} value={<Ltr>{order.code}</Ltr>} />
        <Row label={t('miniapp.checkout_plan')} value={order.title} />
        {order.trafficBytes !== null && (
          <Row label={t('miniapp.checkout_traffic')} value={trafficLimit(order.trafficBytes)} />
        )}
        {order.durationDays !== null && (
          <Row
            label={t('miniapp.checkout_duration')}
            value={formatDurationDays(order.durationDays)}
          />
        )}
        {order.username !== null && (
          <Row label={t('miniapp.checkout_username')} value={<Ltr>{order.username}</Ltr>} />
        )}
        {order.locations.length > 0 && (
          <p className="muted">{order.locations.join(t('miniapp.list_separator'))}</p>
        )}
        {order.description !== null && <p className="prose">{order.description}</p>}
        {discounted && <Row label={t('miniapp.checkout_subtotal')} value={money(order.subtotal)} />}
        {discounted && (
          <Row
            label={
              order.personalDiscountPercent === null
                ? t('miniapp.checkout_discount')
                : t('miniapp.checkout_personal_discount', {
                    percent: order.personalDiscountPercent,
                  })
            }
            value={money(order.discount)}
          />
        )}
        <Row label={t('miniapp.checkout_total')} value={<strong>{money(order.total)}</strong>} />
        {order.cashback !== null && (
          <Row label={t('miniapp.checkout_cashback')} value={money(order.cashback)} />
        )}
        {order.expiresAt !== null && payable && (
          <p className="muted">
            {t('miniapp.checkout_expires', { at: dateTime(order.expiresAt) })}
          </p>
        )}
      </Card>

      {order.usernameModes.length > 0 && (
        <Card>
          <h2>{t('miniapp.checkout_username')}</h2>
          {order.usernameModes.includes('AUTOMATIC') && (
            <Button disabled={busy} onClick={() => chooseUsername({ mode: 'AUTOMATIC' })}>
              {t('miniapp.checkout_username_automatic')}
            </Button>
          )}
          {order.usernameModes.includes('CUSTOM') && (
            <form
              className="inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                void chooseUsername({ mode: 'CUSTOM', username });
              }}
            >
              <label className="field">
                <span>{t('miniapp.checkout_username_custom_label')}</span>
                <input
                  dir="ltr"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  maxLength={64}
                  autoComplete="off"
                />
              </label>
              {/* R12 F3 item 5: the rule, in the bot's own lines, before the customer is refused. */}
              <ul className="features muted" data-testid="username-rule">
                {USERNAME_RULE.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <Button type="submit" disabled={busy || username.trim() === ''}>
                {t('miniapp.checkout_username_save')}
              </Button>
            </form>
          )}
        </Card>
      )}

      {order.discountEditable && (
        <Card>
          {order.discountApplied ? (
            <div className="row">
              <span>{t('miniapp.checkout_discount_applied')}</span>
              <Button disabled={busy} onClick={removeCode}>
                {t('miniapp.checkout_discount_remove')}
              </Button>
            </div>
          ) : (
            <form className="inline-form" onSubmit={applyCode}>
              <label className="field">
                <span>{t('miniapp.checkout_discount_code')}</span>
                <input
                  dir="ltr"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  maxLength={64}
                  autoComplete="off"
                />
              </label>
              <Button type="submit" disabled={busy || code.trim() === ''}>
                {t('miniapp.checkout_discount_apply')}
              </Button>
            </form>
          )}
        </Card>
      )}

      {routes === null ? (
        <p className="muted">{t('miniapp.checkout_not_payable')}</p>
      ) : (
        <Card>
          <h2>{t('miniapp.checkout_methods')}</h2>
          <div className="methods" role="radiogroup">
            <MethodTile
              selected={method?.kind === 'WALLET'}
              disabled={!routes.wallet.sufficient}
              onSelect={() => setMethod({ kind: 'WALLET' })}
              title={t('miniapp.checkout_wallet')}
              detail={
                routes.wallet.shortfall === null
                  ? t('miniapp.checkout_wallet_balance', { amount: money(routes.wallet.balance) })
                  : t('miniapp.checkout_wallet_short', { amount: money(routes.wallet.shortfall) })
              }
            />
            {routes.routes.map((route) => (
              <MethodTile
                key={route.provider}
                selected={method?.kind === 'ROUTE' && method.route.provider === route.provider}
                onSelect={() => setMethod({ kind: 'ROUTE', route })}
                title={route.kind === 'CARD_TO_CARD' ? t('miniapp.checkout_card') : route.name}
                detail={route.paysInChat ? t('miniapp.checkout_in_chat') : null}
              />
            ))}
          </div>
          {routes.routes.length === 0 && <p className="muted">{t('miniapp.checkout_no_routes')}</p>}
          <Button primary disabled={busy || method === null} onClick={pay}>
            {t('miniapp.checkout_pay')}
          </Button>
          <Button disabled={busy} onClick={() => setConfirmCancel(true)}>
            {t('miniapp.checkout_cancel')}
          </Button>
        </Card>
      )}
      {error !== null && <p className="error">{error}</p>}
      {confirmCancel && (
        <Sheet title={t('miniapp.checkout_cancel_title')} onClose={() => setConfirmCancel(false)}>
          <p>{t('miniapp.checkout_cancel_question')}</p>
          <div className="sheet-actions">
            <Button onClick={() => setConfirmCancel(false)}>{t('miniapp.sheet_cancel')}</Button>
            <Button
              primary
              disabled={busy}
              onClick={() => {
                setConfirmCancel(false);
                void cancel();
              }}
            >
              {t('miniapp.checkout_cancel_yes')}
            </Button>
          </div>
        </Sheet>
      )}
    </>
  );
}

function MethodTile({
  title,
  detail,
  selected,
  disabled,
  onSelect,
}: {
  title: string;
  detail: string | null;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={selected ? 'method method-on' : 'method'}
      disabled={disabled}
      onClick={onSelect}
    >
      <strong>{title}</strong>
      {detail !== null && <span className="muted">{detail}</span>}
    </button>
  );
}
