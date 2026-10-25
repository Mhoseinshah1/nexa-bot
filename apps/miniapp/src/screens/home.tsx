import { useEffect } from 'react';
import { MINIAPP_ROUTES, miniAppServicesResponseSchema } from '@nexa/contracts';
import { useApp } from '../app.js';
import { t } from '../i18n/t.js';
import { money } from '../format.js';
import { Button, Card, Loading, useLoad } from '../ui.js';
import { ServiceCard } from './service-card.js';
import { useTrialOffers } from './entry-points.js';

/**
 * خانه: the greeting, the wallet balance, «خرید سرویس», and the customer's services.
 *
 * Not drawn, because nothing backs them: the cashback-earned chip (no customer-own cashback
 * total), the outage strip with its compensation extension (no such feature; the incident
 * banner is the operators'), and the bell (there is no in-app notification store). The
 * support tile arrives with its screen. The top-up button and the trial shortcut (drawn only
 * while a panel offers a trial) are here; the referral entry lives in the profile.
 */
export function Home() {
  const { api, me, navigate, refreshMe } = useApp();
  // The balance is `me`'s, and `me` is otherwise the sign-in snapshot: a top-up settled or a
  // purchase paid on another screen must show when the customer comes back here. Home is
  // mounted afresh every time it becomes the screen, so this runs on each return. A failed
  // refresh keeps the figure already drawn rather than replacing the screen with an error.
  useEffect(() => {
    refreshMe().catch(() => undefined);
  }, [refreshMe]);
  const { loaded, reload } = useLoad(
    () => api.get(MINIAPP_ROUTES.services, {}, miniAppServicesResponseSchema, 'page=0'),
    [api],
  );
  const trial = useTrialOffers();
  const name = me.customer.firstName;
  const now = new Date();
  return (
    <main className="page">
      <header className="hero">
        <h1 className="title">
          {name === null ? t('miniapp.home_greeting_plain') : t('miniapp.home_greeting', { name })}
        </h1>
        {me.reseller !== null && (
          <span className="badge">
            {t('miniapp.home_reseller', { tier: me.reseller.tierName })}
          </span>
        )}
      </header>
      <Card className="balance">
        <span className="muted">{t('miniapp.home_balance')}</span>
        <strong className="figure">{money(me.wallet?.balance)}</strong>
        <Button primary onClick={() => navigate({ name: 'store' })}>
          {t('miniapp.home_buy')}
        </Button>
        <Button onClick={() => navigate({ name: 'wallet' })}>{t('miniapp.home_topup')}</Button>
      </Card>
      {trial.loaded.state === 'ready' && trial.loaded.data.offers.length > 0 && (
        <Button onClick={() => navigate({ name: 'trial' })}>
          {t('miniapp.home_shortcut_trial')}
        </Button>
      )}
      <Loading loaded={loaded} reload={reload}>
        {(page) => (
          <section className="section">
            <div className="section-head">
              <h2>{t('miniapp.home_my_services')}</h2>
              {page.total > page.items.length && (
                <button
                  type="button"
                  className="link"
                  onClick={() => navigate({ name: 'services' })}
                >
                  {t('miniapp.home_all_services', { count: page.total })}
                </button>
              )}
            </div>
            {page.items.length === 0 ? (
              <p className="muted">{t('miniapp.home_no_services')}</p>
            ) : (
              page.items
                .slice(0, 3)
                .map((service) => (
                  <ServiceCard
                    key={service.id}
                    service={service}
                    now={now}
                    onOpen={() => navigate({ name: 'service', serviceId: service.id })}
                  />
                ))
            )}
          </section>
        )}
      </Loading>
    </main>
  );
}
