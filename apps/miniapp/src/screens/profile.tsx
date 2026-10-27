import { useState } from 'react';
import { MINIAPP_ROUTES, miniAppRemindersSchema, type MiniAppReminders } from '@nexa/contracts';
import { ApiError } from '../api.js';
import { useApp } from '../app.js';
import { t } from '../i18n/t.js';
import { Button, Card, Ltr, errorText, useLoad } from '../ui.js';
import { useTrialOffers } from './entry-points.js';

/**
 * پروفایل: who the bot knows the customer as (name and username from the Telegram profile
 * the launch carried), the reseller tier when the customer is an ACTIVE reseller, and the
 * ways into the wallet history, the referral program and — only while a panel offers one,
 * and only once that read succeeded — the free trial (a failed read hides that one row),
 * and — Round 11 B6, only while the installation offers it (`customer_reminder_opt_out`) —
 * the customer's own switch for the expiry and volume reminders.
 *
 * Not drawn, because nothing backs them: the default service username (the username is
 * chosen per order), the notifications row and its unread count (there is no in-app
 * notification store), «کدهای تخفیف من» (codes are typed at checkout, never listed), the
 * order count (no customer-own count), the marketing switch (no mini-app endpoint), the required-channels status (only missing
 * channels are returned), the terms row (the published terms are read only at the gate),
 * and the reseller panel (credit was removed; there is no sales or customer read) — the
 * tier is a label here, never a door.
 */
export function Profile() {
  const { me, navigate } = useApp();
  const { loaded } = useTrialOffers();
  const name = me.customer.firstName;
  const initial = (name ?? me.customer.username ?? '').trim().charAt(0);
  return (
    <main className="page">
      <h1 className="title">{t('miniapp.profile_title')}</h1>
      <Card className="identity">
        {initial !== '' && (
          <span className="avatar" aria-hidden="true">
            {initial}
          </span>
        )}
        <div>
          {name !== null && <strong className="lead">{name}</strong>}
          {me.customer.username !== null && (
            <p className="muted">
              <Ltr>@{me.customer.username}</Ltr>
            </p>
          )}
          {me.reseller !== null && (
            <span className="badge">
              {t('miniapp.profile_reseller', { tier: me.reseller.tierName })}
            </span>
          )}
        </div>
      </Card>
      <Card>
        <h2>{t('miniapp.profile_section_account')}</h2>
        <button type="button" className="menu-row" onClick={() => navigate({ name: 'wallet' })}>
          {t('miniapp.profile_wallet_history')}
        </button>
        <button type="button" className="menu-row" onClick={() => navigate({ name: 'referral' })}>
          {t('miniapp.profile_referral')}
        </button>
        {loaded.state === 'ready' && loaded.data.offers.length > 0 && (
          <button type="button" className="menu-row" onClick={() => navigate({ name: 'trial' })}>
            {t('miniapp.profile_trial')}
          </button>
        )}
        <button type="button" className="menu-row" onClick={() => navigate({ name: 'support' })}>
          {t('miniapp.support_title')}
        </button>
        <button type="button" className="menu-row" onClick={() => navigate({ name: 'apps' })}>
          {t('miniapp.apps_title')}
        </button>
      </Card>
      <Reminders />
    </main>
  );
}

/**
 * Round 11, B6: the customer's own expiry / volume reminder switch. Drawn only once the read
 * succeeded AND says it is offered — a failed read or an installation that does not offer the
 * choice shows nothing, like the trial row. The write names only the wanted state: the server
 * reads whose setting it is from the session.
 */
function Reminders() {
  const { api } = useApp();
  const { loaded } = useLoad(
    () => api.get(MINIAPP_ROUTES.reminders, {}, miniAppRemindersSchema),
    [api],
  );
  const [changed, setChanged] = useState<MiniAppReminders | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (loaded.state !== 'ready') return null;
  const state = changed ?? loaded.data;
  if (!state.offered) return null;
  const set = async (enabled: boolean) => {
    setError(null);
    setBusy(true);
    try {
      setChanged(await api.post(MINIAPP_ROUTES.reminders, {}, miniAppRemindersSchema, { enabled }));
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.code === 'miniapp.route_unavailable'
          ? t('miniapp.profile_reminders_unavailable')
          : errorText(failure),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <h2>{t('miniapp.profile_reminders_title')}</h2>
      <p>{t(state.enabled ? 'miniapp.profile_reminders_on' : 'miniapp.profile_reminders_off')}</p>
      <div className="actions">
        <Button disabled={busy} onClick={() => void set(!state.enabled)}>
          {t(
            state.enabled
              ? 'miniapp.profile_reminders_disable'
              : 'miniapp.profile_reminders_enable',
          )}
        </Button>
      </div>
      {error !== null && <p className="error">{error}</p>}
    </Card>
  );
}
