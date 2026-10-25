import { useEffect, useState } from 'react';
import {
  MINIAPP_ROUTES,
  miniAppOrderSchema,
  miniAppServiceDetailSchema,
  miniAppServiceOfferSchema,
  type MiniAppServiceAction,
  type MiniAppServiceDetail,
} from '@nexa/contracts';
import { useApp } from '../app.js';
import { t } from '../i18n/t.js';
import { dateTime, money, traffic } from '../format.js';
import { Button, Card, Loading, Ltr, errorText, useLoad } from '../ui.js';
import { ServiceCard } from './service-card.js';

/**
 * جزئیات سرویس: the same facts the bot's service card shows — usage with the moment it was
 * read, expiry, the device limit, the location label — the subscription link (copy, QR),
 * and the renew / extra traffic / extra time the server offers now, each quoted into a
 * DRAFT and paid through the same checkout as a purchase.
 *
 * Not drawn: the seven-day usage chart and a connected-device count (only the stored usage
 * and the device LIMIT exist), «افزودن خودکار به برنامه» (client apps carry no import
 * link), and «حذف سرویس» (a customer can suspend or resume, never delete). Suspend, rotate,
 * change location, transfer, files, note and refund request arrive with their screens.
 */
export function ServiceDetail({ serviceId }: { serviceId: string }) {
  const { api } = useApp();
  const { loaded, reload } = useLoad(
    () => api.get(MINIAPP_ROUTES.service, { serviceId }, miniAppServiceDetailSchema),
    [api, serviceId],
  );
  return (
    <main className="page">
      <Loading loaded={loaded} reload={reload}>
        {(service) => <Detail service={service} />}
      </Loading>
    </main>
  );
}

function Detail({ service }: { service: MiniAppServiceDetail }) {
  const [copied, setCopied] = useState(false);
  const [action, setAction] = useState<MiniAppServiceAction | null>(null);
  const left =
    BigInt(service.trafficLimitBytes) > 0n
      ? BigInt(service.trafficLimitBytes) - BigInt(service.trafficUsedBytes)
      : null;
  return (
    <>
      <ServiceCard service={service} now={new Date()} />
      <Card>
        {left !== null && left >= 0n && (
          <p>{t('miniapp.service_left', { left: traffic(left) })}</p>
        )}
        <p className="muted">
          {service.usageSyncedAt === null
            ? t('miniapp.service_not_synced')
            : t('miniapp.service_synced', { at: dateTime(service.usageSyncedAt) })}
        </p>
      </Card>
      {service.subscriptionUrl !== null && (
        <Card>
          <h2>{t('miniapp.service_link')}</h2>
          <p className="secret">
            <Ltr>{service.subscriptionUrl}</Ltr>
          </p>
          <Button
            onClick={() => {
              void navigator.clipboard.writeText(service.subscriptionUrl as string);
              setCopied(true);
            }}
          >
            {copied ? t('miniapp.service_copied') : t('miniapp.service_copy_link')}
          </Button>
          {service.qr && <Qr serviceId={service.id} />}
        </Card>
      )}
      {service.working && <p className="muted">{t('miniapp.service_working')}</p>}
      {service.actions.length > 0 && (
        <Card>
          <h2>{t('miniapp.service_actions')}</h2>
          <div className="actions">
            {service.actions.map((kind) => (
              <Button key={kind} primary={kind === action} onClick={() => setAction(kind)}>
                {t(`miniapp.service_action_${kind}`)}
              </Button>
            ))}
          </div>
          {action !== null && <Offer key={action} serviceId={service.id} kind={action} />}
        </Card>
      )}
    </>
  );
}

/** The link's QR, drawn by the server's one QR renderer; shown on request. */
function Qr({ serviceId }: { serviceId: string }) {
  const { api } = useApp();
  const [shown, setShown] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!shown) return;
    let url: string | null = null;
    let live = true;
    api.blob(MINIAPP_ROUTES.serviceQr, { serviceId }).then(
      (made) => {
        url = made;
        if (live) setSrc(made);
        else URL.revokeObjectURL(made);
      },
      () => live && setSrc(null),
    );
    return () => {
      live = false;
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [api, serviceId, shown]);
  if (!shown) return <Button onClick={() => setShown(true)}>{t('miniapp.service_show_qr')}</Button>;
  return src === null ? null : <img className="qr" src={src} alt={t('miniapp.service_qr_alt')} />;
}

function Offer({ serviceId, kind }: { serviceId: string; kind: MiniAppServiceAction }) {
  const { api, navigate } = useApp();
  const [error, setError] = useState<string | null>(null);
  const { loaded, reload } = useLoad(
    () => api.get(MINIAPP_ROUTES.serviceOffer, { serviceId, kind }, miniAppServiceOfferSchema),
    [api, serviceId, kind],
  );
  const quote = async (option: { addonId: string | null; planId: string | null }) => {
    setError(null);
    try {
      const order = await api.post(
        MINIAPP_ROUTES.serviceQuote,
        { serviceId },
        miniAppOrderSchema,
        { kind, addonId: option.addonId, planId: option.planId },
      );
      navigate({ name: 'checkout', orderId: order.id });
    } catch (failure) {
      setError(errorText(failure));
    }
  };
  return (
    <Loading loaded={loaded} reload={reload}>
      {(offer) => (
        <div className="options">
          {offer.options.length === 0 && <p className="muted">{t('miniapp.service_offer_empty')}</p>}
          {offer.options.map((option) => (
            <button
              key={`${option.addonId ?? ''}:${option.planId ?? ''}`}
              type="button"
              className="method"
              onClick={() => void quote(option)}
            >
              <strong>{option.title}</strong>
              <span>{money(option.price)}</span>
            </button>
          ))}
          {error !== null && <p className="error">{error}</p>}
        </div>
      )}
    </Loading>
  );
}
