import { useEffect, useRef, useState } from 'react';
import {
  MINIAPP_ROUTES,
  miniAppGatewayAttemptSchema,
  miniAppPaymentStatusSchema,
  miniAppStarsInvoiceSchema,
  type MiniAppPaymentStatus,
} from '@nexa/contracts';
import { ApiError } from '../api.js';
import { useApp } from '../app.js';
import { t, type MiniAppKey } from '../i18n/t.js';
import { openExternal, openStarsInvoice, openTelegram } from '../telegram.js';
import { Button, Card, Loading, Ltr, errorText, useLoad } from '../ui.js';

/** How often an open payment is read again while this screen is up. */
const POLL_MS = 5000;

/**
 * وضعیت پرداخت: what the reads the bot already has can say — the payment's own state, the
 * gateway attempt (and its page, once the provider made it), whether a receipt was filed,
 * and the order. There is no timeline with times: no customer-own record of those steps
 * exists, and the outcome reaches the customer in the bot through its notifications.
 */
export function PayStatus({
  paymentId,
  openInvoice = false,
}: {
  paymentId: string;
  /** R11 B5: open the Stars invoice in place once, as the screen arrives from checkout. */
  openInvoice?: boolean;
}) {
  const { api, me, replace } = useApp();
  const { loaded, reload } = useLoad(
    () => api.get(MINIAPP_ROUTES.payment, { paymentId }, miniAppPaymentStatusSchema),
    [api, paymentId],
  );
  const [error, setError] = useState<string | null>(null);
  /**
   * R11 B5: Telegram's invoice said `paid`. That is the CLIENT's word, never the payment's
   * state: the screen only says the payment is being confirmed and keeps reading the server,
   * which calls it paid once the bot's webhook recorded Telegram's charge.
   */
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const open = loaded.state === 'ready' && loaded.data.state === 'PENDING';
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(reload, POLL_MS);
    return () => window.clearInterval(timer);
  }, [open, reload]);

  const payWithStars = async () => {
    setError(null);
    setBusy(true);
    try {
      const invoice = await api.post(
        MINIAPP_ROUTES.paymentStarsInvoice,
        { paymentId },
        miniAppStarsInvoiceSchema,
      );
      const status = await openStarsInvoice(invoice.invoiceLink);
      if (status === 'paid' || status === 'pending') {
        setConfirming(true);
      } else if (status === 'unsupported') {
        setError(t('miniapp.pay_stars_unsupported'));
      } else {
        // `cancelled` or `failed`: nothing was charged, and nothing changes on the server —
        // the order stays payable, here or from the chat invoice.
        setError(t('miniapp.pay_stars_not_completed'));
      }
      reload();
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.code === 'miniapp.route_unavailable'
          ? t('miniapp.wallet_route_unavailable')
          : errorText(failure),
      );
    } finally {
      setBusy(false);
    }
  };

  // Arriving from checkout with a Stars attempt payable here: open its invoice once.
  const autoOpened = useRef(false);
  const autoOpen =
    openInvoice &&
    loaded.state === 'ready' &&
    loaded.data.state === 'PENDING' &&
    loaded.data.gateway?.inAppInvoice === true;
  useEffect(() => {
    if (!autoOpen || autoOpened.current) return;
    autoOpened.current = true;
    void payWithStars();
    // `payWithStars` is a fresh closure each render; the ref makes this run once.
  }, [autoOpen]);

  const check = async () => {
    setError(null);
    try {
      await api.post(MINIAPP_ROUTES.paymentCheck, { paymentId }, miniAppGatewayAttemptSchema);
      reload();
    } catch (failure) {
      setError(errorText(failure));
    }
  };

  return (
    <main className="page">
      <h1 className="title">{t('miniapp.pay_title')}</h1>
      <Loading loaded={loaded} reload={reload}>
        {(status) => (
          <>
            <Card>
              <p className="lead">{t(headline(status, confirming))}</p>
              {status.order !== null && (
                <p className="muted">
                  {t('miniapp.checkout_order')} <Ltr>{status.order.code}</Ltr>
                  {t('miniapp.list_separator')}
                  {status.order.title}
                  {t('miniapp.list_separator')}
                  {t(`miniapp.pay_order_state_${status.order.state}`)}
                </p>
              )}
              {status.gateway !== null && status.state === 'PENDING' && (
                <>
                  {status.gateway.inAppInvoice && !confirming && (
                    <Button primary disabled={busy} onClick={() => void payWithStars()}>
                      {t('miniapp.pay_stars_open')}
                    </Button>
                  )}
                  {status.gateway.paysInChat ? (
                    <>
                      <p>{t('miniapp.pay_in_chat')}</p>
                      {me.botLink !== null && (
                        <Button onClick={() => openTelegram(me.botLink as string)}>
                          {t('miniapp.pay_go_bot')}
                        </Button>
                      )}
                    </>
                  ) : status.gateway.payUrl !== null ? (
                    <Button primary onClick={() => openExternal(status.gateway?.payUrl as string)}>
                      {t('miniapp.pay_open_gateway')}
                    </Button>
                  ) : (
                    <p className="muted">{t('miniapp.pay_preparing')}</p>
                  )}
                  <Button onClick={() => void check()}>{t('miniapp.pay_check')}</Button>
                </>
              )}
              {status.state === 'CONFIRMED' && status.order !== null && (
                <p className="muted">{t('miniapp.pay_delivery')}</p>
              )}
              {error !== null && <p className="error">{error}</p>}
            </Card>
            <Button onClick={() => replace({ name: 'home' })}>{t('miniapp.pay_home')}</Button>
          </>
        )}
      </Loading>
    </main>
  );
}

function headline(status: MiniAppPaymentStatus, confirming: boolean): MiniAppKey {
  if (status.state === 'CONFIRMED') return 'miniapp.pay_confirmed';
  if (status.state !== 'PENDING') return 'miniapp.pay_closed';
  // R11 B5: the invoice said `paid`, the server has not settled it yet.
  if (confirming) return 'miniapp.pay_stars_confirming';
  if (status.method === 'MANUAL_TRANSFER') {
    return status.receiptFiled ? 'miniapp.pay_receipt_review' : 'miniapp.pay_transfer_open';
  }
  return 'miniapp.pay_waiting';
}
