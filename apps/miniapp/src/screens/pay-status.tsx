import { useEffect, useState } from 'react';
import {
  MINIAPP_ROUTES,
  miniAppGatewayAttemptSchema,
  miniAppPaymentStatusSchema,
  type MiniAppPaymentStatus,
} from '@nexa/contracts';
import { useApp } from '../app.js';
import { t, type MiniAppKey } from '../i18n/t.js';
import { openExternal, openTelegram } from '../telegram.js';
import { Button, Card, Loading, Ltr, errorText, useLoad } from '../ui.js';

/** How often an open payment is read again while this screen is up. */
const POLL_MS = 5000;

/**
 * وضعیت پرداخت: what the reads the bot already has can say — the payment's own state, the
 * gateway attempt (and its page, once the provider made it), whether a receipt was filed,
 * and the order. There is no timeline with times: no customer-own record of those steps
 * exists, and the outcome reaches the customer in the bot through its notifications.
 */
export function PayStatus({ paymentId }: { paymentId: string }) {
  const { api, me, replace } = useApp();
  const { loaded, reload } = useLoad(
    () => api.get(MINIAPP_ROUTES.payment, { paymentId }, miniAppPaymentStatusSchema),
    [api, paymentId],
  );
  const [error, setError] = useState<string | null>(null);
  const open = loaded.state === 'ready' && loaded.data.state === 'PENDING';
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(reload, POLL_MS);
    return () => window.clearInterval(timer);
  }, [open, reload]);

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
              <p className="lead">{t(headline(status))}</p>
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

function headline(status: MiniAppPaymentStatus): MiniAppKey {
  if (status.state === 'CONFIRMED') return 'miniapp.pay_confirmed';
  if (status.state !== 'PENDING') return 'miniapp.pay_closed';
  if (status.method === 'MANUAL_TRANSFER') {
    return status.receiptFiled ? 'miniapp.pay_receipt_review' : 'miniapp.pay_transfer_open';
  }
  return 'miniapp.pay_waiting';
}
