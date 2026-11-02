import { useState } from 'react';
import {
  MINIAPP_ROUTES,
  miniAppAutoRenewSchema,
  miniAppOrderSchema,
  miniAppServiceDetailSchema,
  miniAppServiceOfferSchema,
  type MiniAppAutoRenew,
  type MiniAppServiceAction,
  type MiniAppServiceDetail,
} from '@nexa/contracts';
import { useApp } from '../app.js';
import { t } from '../i18n/t.js';
import { dateTime, money, traffic } from '../format.js';
import { Button, Card, Loading, Ltr, PersonalPrice, errorText, useLoad } from '../ui.js';
import { ServiceCard } from './service-card.js';
import { QrSheet } from './qr-sheet.js';
import { LocationSheet } from './location-sheet.js';

/**
 * جزئیات سرویس: the same facts the bot's service card shows — usage with the moment it was
 * read, expiry, the device limit, the location label — the subscription link (copy, QR),
 * and the renew / extra traffic / extra time the server offers now, each quoted into a
 * DRAFT and paid through the same checkout as a purchase.
 *
 * Not drawn: the seven-day usage chart and a connected-device count (only the stored usage
 * and the device LIMIT exist), «افزودن خودکار به برنامه» (client apps carry no import
 * link), and «حذف سرویس» (a customer can suspend or resume, never delete). Suspend, rotate,
 * transfer, files, note and refund request arrive with their screens; the QR and the
 * location change are sheets over this page, and the connection guide and support are links.
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
  const { navigate } = useApp();
  const [copied, setCopied] = useState(false);
  const [sheet, setSheet] = useState<'qr' | 'location' | null>(null);
  const [action, setAction] = useState<MiniAppServiceAction | null>(null);
  const left =
    BigInt(service.trafficLimitBytes) > 0n
      ? BigInt(service.trafficLimitBytes) - BigInt(service.trafficUsedBytes)
      : null;
  return (
    <>
      <ServiceCard service={service} now={new Date()} />
      <Card>
        {left !== null && left >= 0n && <p>{t('miniapp.service_left', { left: traffic(left) })}</p>}
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
          {service.qr && (
            <Button onClick={() => setSheet('qr')}>{t('miniapp.service_show_qr')}</Button>
          )}
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
      {(service.autoRenew.offered || service.autoRenew.enabled) && (
        <AutoRenew serviceId={service.id} initial={service.autoRenew} />
      )}
      <Card>
        {service.locationRemaining !== null && (
          <p className="muted">
            {t('miniapp.location_remaining', {
              remaining: service.locationRemaining.remaining,
              max: service.locationRemaining.max,
            })}
          </p>
        )}
        <div className="actions">
          {service.canChangeLocation && (
            <Button onClick={() => setSheet('location')}>{t('miniapp.location_open')}</Button>
          )}
          <Button onClick={() => navigate({ name: 'apps' })}>{t('miniapp.service_guide')}</Button>
          <Button onClick={() => navigate({ name: 'support' })}>
            {t('miniapp.service_support')}
          </Button>
        </div>
      </Card>
      {sheet === 'qr' && service.subscriptionUrl !== null && (
        <QrSheet
          serviceId={service.id}
          link={service.subscriptionUrl}
          kinds={service.qrKinds}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === 'location' && (
        <LocationSheet serviceId={service.id} onClose={() => setSheet(null)} />
      )}
    </>
  );
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
      const order = await api.post(MINIAPP_ROUTES.serviceQuote, { serviceId }, miniAppOrderSchema, {
        kind,
        addonId: option.addonId,
        planId: option.planId,
      });
      navigate({ name: 'checkout', orderId: order.id });
    } catch (failure) {
      setError(errorText(failure));
    }
  };
  return (
    <Loading loaded={loaded} reload={reload}>
      {(offer) => (
        <div className="options">
          {offer.options.length === 0 && (
            <p className="muted">{t('miniapp.service_offer_empty')}</p>
          )}
          {offer.options.map((option) => (
            <button
              key={`${option.addonId ?? ''}:${option.planId ?? ''}`}
              type="button"
              className="method"
              onClick={() => void quote(option)}
            >
              <strong>{option.title}</strong>
              {option.personalDiscount === null ? (
                <span>{money(option.price)}</span>
              ) : (
                <PersonalPrice price={option.price} discount={option.personalDiscount} />
              )}
            </button>
          ))}
          {error !== null && <p className="error">{error}</p>}
        </div>
      )}
    </Loading>
  );
}

/**
 * Round 10, D1: «تمدید خودکار». Switching on asks first, naming the renewal total the server
 * quoted (the most it will charge); the confirm sends that figure back, and the server quotes
 * again and records its quote only when it is no higher. A higher one is recorded nowhere: the
 * answer carries the new price and the question stays open on it, to be confirmed again.
 * Switching off acts at once. Every refusal is the server's, in Persian.
 */
function AutoRenew({ serviceId, initial }: { serviceId: string; initial: MiniAppAutoRenew }) {
  const { api } = useApp();
  const [state, setState] = useState<MiniAppAutoRenew>(initial);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = async (enabled: boolean) => {
    setError(null);
    setBusy(true);
    try {
      const next = await api.post(
        MINIAPP_ROUTES.serviceAutoRenew,
        { serviceId },
        miniAppAutoRenewSchema,
        enabled && state.price !== null ? { enabled, expected: state.price } : { enabled },
      );
      setState(next);
      // Not recorded because the price moved: still asking, now at the new figure.
      setAsking(enabled && !next.enabled && next.offered);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  const values = { price: money(state.price), hours: String(state.leadHours) };
  return (
    <Card>
      <h2>{t('miniapp.auto_renew_title')}</h2>
      <p>{t(state.enabled ? 'miniapp.auto_renew_on' : 'miniapp.auto_renew_off', values)}</p>
      <div className="actions">
        {state.enabled ? (
          <Button disabled={busy} onClick={() => void set(false)}>
            {t('miniapp.auto_renew_disable')}
          </Button>
        ) : asking ? (
          <Button primary disabled={busy} onClick={() => void set(true)}>
            {t('miniapp.auto_renew_confirm', values)}
          </Button>
        ) : (
          state.offered && (
            <Button onClick={() => setAsking(true)}>{t('miniapp.auto_renew_enable')}</Button>
          )
        )}
      </div>
      {error !== null && <p className="error">{error}</p>}
    </Card>
  );
}
