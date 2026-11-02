import { useState } from 'react';
import {
  MINIAPP_ROUTES,
  miniAppServiceLocationResultSchema,
  miniAppServiceLocationsSchema,
  type MiniAppServiceLocations,
} from '@nexa/contracts';
import { useApp } from '../app.js';
import { t, type MiniAppKey } from '../i18n/t.js';
import { money } from '../format.js';
import { Sheet } from '../sheet.js';
import { ApiError } from '../api.js';
import { Button, errorText, useLoad } from '../ui.js';

/**
 * تغییر لوکیشن: where the service is and the configured targets it may be moved to, each
 * priced. A free target is requested at once (the customer confirms on this sheet first); a
 * priced one becomes the ordinary pre-invoice and goes through checkout.
 *
 * R11 B4 draws the changes left («۲ از ۳») when a limit is set. Not drawn, because the service
 * exposes nothing behind them: the cooldown (enforced, and it arrives as a refusal), a
 * «پیشنهادی» tag, and a «ظرفیت تکمیل» state per target (a full target is refused on request).
 */
const LOCATION_ERRORS: Readonly<Record<string, MiniAppKey>> = {
  'commerce.service_action_unavailable': 'miniapp.location_unavailable',
  'commerce.service_action_not_allowed': 'miniapp.location_not_allowed',
  'commerce.service_action_in_progress': 'miniapp.location_in_progress',
  'commerce.panel_not_operable': 'miniapp.location_unavailable',
  'commerce.location_change_same_location': 'miniapp.location_same',
  'commerce.location_change_cooldown': 'miniapp.location_cooldown',
  'commerce.location_change_limit_reached': 'miniapp.location_limit',
};

export function locationErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    const key = LOCATION_ERRORS[error.code];
    if (key !== undefined) return t(key);
  }
  return errorText(error);
}

export function LocationSheet({ serviceId, onClose }: { serviceId: string; onClose: () => void }) {
  const { api, navigate } = useApp();
  const { loaded, reload } = useLoad(
    () => api.get(MINIAPP_ROUTES.serviceLocations, { serviceId }, miniAppServiceLocationsSchema),
    [api, serviceId],
  );
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);

  const move = async (locationId: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post(
        MINIAPP_ROUTES.serviceLocation,
        { serviceId },
        miniAppServiceLocationResultSchema,
        { locationId },
      );
      if (result.outcome === 'ORDER') navigate({ name: 'checkout', orderId: result.order.id });
      else setRequested(true);
    } catch (failure) {
      setError(locationErrorText(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title={t('miniapp.location_title')} onClose={onClose}>
      {requested ? (
        <>
          <p className="prose">{t('miniapp.location_requested')}</p>
          <Button primary onClick={onClose}>
            {t('miniapp.sheet_close')}
          </Button>
        </>
      ) : loaded.state === 'loading' ? (
        <p className="muted">{t('miniapp.loading')}</p>
      ) : loaded.state === 'failed' ? (
        <>
          <p className="error">{locationErrorText(loaded.error)}</p>
          <div className="sheet-actions">
            <Button onClick={reload}>{t('miniapp.retry')}</Button>
            <Button onClick={onClose}>{t('miniapp.sheet_close')}</Button>
          </div>
        </>
      ) : (
        <Choice
          offer={loaded.data}
          picked={picked}
          busy={busy}
          error={error}
          onPick={setPicked}
          onMove={(id) => void move(id)}
          onCancel={onClose}
        />
      )}
    </Sheet>
  );
}

function Choice({
  offer,
  picked,
  busy,
  error,
  onPick,
  onMove,
  onCancel,
}: {
  offer: MiniAppServiceLocations;
  picked: string | null;
  busy: boolean;
  error: string | null;
  onPick: (id: string) => void;
  onMove: (id: string) => void;
  onCancel: () => void;
}) {
  const target = offer.targets.find((candidate) => candidate.id === picked) ?? null;
  const free = target !== null && BigInt(target.price.amountMinor) === 0n;
  return (
    <>
      <ul className="targets">
        <li>
          <div className="target target-here" aria-current="true">
            <strong>{offer.current.label}</strong>
            <small>{t('miniapp.location_current')}</small>
          </div>
        </li>
        {offer.targets.map((candidate) => (
          <li key={candidate.id}>
            <button
              type="button"
              className={candidate.id === picked ? 'target target-on' : 'target'}
              aria-pressed={candidate.id === picked}
              onClick={() => onPick(candidate.id)}
            >
              <strong>{candidate.label}</strong>
              <small>
                {BigInt(candidate.price.amountMinor) === 0n
                  ? t('miniapp.location_free')
                  : money(candidate.price)}
              </small>
            </button>
          </li>
        ))}
      </ul>
      {offer.remaining !== null && (
        <p className="muted">
          {t('miniapp.location_remaining', {
            remaining: offer.remaining.remaining,
            max: offer.remaining.max,
          })}
        </p>
      )}
      <p className="muted">{t('miniapp.location_note')}</p>
      {error !== null && <p className="error">{error}</p>}
      <div className="sheet-actions">
        <Button onClick={onCancel}>{t('miniapp.sheet_cancel')}</Button>
        <Button
          primary
          disabled={target === null || busy}
          onClick={() => target && onMove(target.id)}
        >
          {target === null
            ? t('miniapp.location_pick')
            : free
              ? t('miniapp.location_move', { location: target.label })
              : t('miniapp.location_pay', { price: money(target.price) })}
        </Button>
      </div>
    </>
  );
}
