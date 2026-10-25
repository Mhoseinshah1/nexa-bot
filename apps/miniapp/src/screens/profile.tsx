import { useApp } from '../app.js';
import { t } from '../i18n/t.js';
import { Card, Ltr } from '../ui.js';
import { useTrialOffers } from './entry-points.js';

/**
 * پروفایل: who the bot knows the customer as (name and username from the Telegram profile
 * the launch carried), the reseller tier when the customer is an ACTIVE reseller, and the
 * ways into the wallet history, the referral program and — only while a panel offers one,
 * and only once that read succeeded — the free trial (a failed read hides that one row).
 *
 * Not drawn, because nothing backs them: the default service username (the username is
 * chosen per order), the notifications row and its unread count (there is no in-app
 * notification store), «کدهای تخفیف من» (codes are typed at checkout, never listed), the
 * order count (no customer-own count), the reminder switch (no per-customer preference), the
 * marketing switch (no mini-app endpoint), the required-channels status (only missing
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
    </main>
  );
}
