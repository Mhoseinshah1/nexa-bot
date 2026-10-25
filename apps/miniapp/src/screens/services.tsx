import { useState } from 'react';
import { MINIAPP_ROUTES, miniAppServicesResponseSchema } from '@nexa/contracts';
import { useApp } from '../app.js';
import { t } from '../i18n/t.js';
import { Button, Loading, useLoad } from '../ui.js';
import { ServiceCard } from './service-card.js';

/** The services list: the customer's services, the server's pages in the server's order. */
export function Services() {
  const { api, navigate } = useApp();
  const [page, setPage] = useState(0);
  const { loaded, reload } = useLoad(
    () => api.get(MINIAPP_ROUTES.services, {}, miniAppServicesResponseSchema, `page=${String(page)}`),
    [api, page],
  );
  const now = new Date();
  return (
    <main className="page">
      <h1 className="title">{t('miniapp.services_title')}</h1>
      <Loading loaded={loaded} reload={reload}>
        {(result) => (
          <>
            {result.items.length === 0 && <p className="muted">{t('miniapp.home_no_services')}</p>}
            {result.items.map((service) => (
              <ServiceCard
                key={service.id}
                service={service}
                now={now}
                onOpen={() => navigate({ name: 'service', serviceId: service.id })}
              />
            ))}
            {result.page + 1 < result.pages && (
              <Button onClick={() => setPage(result.page + 1)}>{t('miniapp.store_more')}</Button>
            )}
          </>
        )}
      </Loading>
    </main>
  );
}
