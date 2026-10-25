import { MINIAPP_ROUTES, miniAppServicesResponseSchema } from '@nexa/contracts';
import { useApp } from '../app.js';
import { t } from '../i18n/t.js';
import { money } from '../format.js';
import { Button, Card, Loading, useLoad } from '../ui.js';
import { ServiceCard } from './service-card.js';

/**
 * خانه: the greeting, the wallet balance, «خرید سرویس», and the customer's services.
 *
 * Not drawn, because nothing backs them: the cashback-earned chip (no customer-own cashback
 * total), the outage strip with its compensation extension (no such feature; the incident
 * banner is the operators'), and the bell (there is no in-app notification store). The
 * top-up, trial, referral and support tiles arrive with their screens.
 */
export function Home() {
  const { api, me, navigate } = useApp();
  const { loaded, reload } = useLoad(
    () => api.get(MINIAPP_ROUTES.services, {}, miniAppServicesResponseSchema, 'page=0'),
    [api],
  );
  const name = me.customer.firstName;
  const now = new Date();
  return (
    <main className="page">
      <header className="hero">
        <h1 className="title">
          {name === null ? t('miniapp.home_greeting_plain') : t('miniapp.home_greeting', { name })}
        </h1>
        {me.reseller !== null && (
          <span className="badge">{t('miniapp.home_reseller', { tier: me.reseller.tierName })}</span>
        )}
      </header>
      <Card className="balance">
        <span className="muted">{t('miniapp.home_balance')}</span>
        <strong className="figure">{money(me.wallet?.balance)}</strong>
        <Button primary onClick={() => navigate({ name: 'store' })}>
          {t('miniapp.home_buy')}
        </Button>
      </Card>
      <Loading loaded={loaded} reload={reload}>
        {(page) => (
          <section className="section">
            <div className="section-head">
              <h2>{t('miniapp.home_my_services')}</h2>
              {page.total > page.items.length && (
                <button type="button" className="link" onClick={() => navigate({ name: 'services' })}>
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
