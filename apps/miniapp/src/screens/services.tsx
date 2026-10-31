import { useState } from 'react';
import {
  MINIAPP_ROUTES,
  miniAppServicesResponseSchema,
  type MiniAppServiceSummary,
} from '@nexa/contracts';
import { useApp } from '../app.js';
import { t } from '../i18n/t.js';
import { Button, Loading, appendPage, errorText, useLoad } from '../ui.js';
import { ServiceCard } from './service-card.js';

/**
 * The services list: the customer's services, the server's pages in the server's order.
 * «بیشتر» adds the next page under the ones already shown (R12 F3 item 5), and an empty list
 * leads to the store instead of ending on a sentence.
 */
export function Services() {
  const { api, navigate } = useApp();
  const [page, setPage] = useState(0);
  // What the pages before `page` showed; this page's rows are appended once they arrive.
  const [earlier, setEarlier] = useState<readonly ServiceRow[]>([]);
  const { loaded, reload } = useLoad(
    () =>
      api.get(MINIAPP_ROUTES.services, {}, miniAppServicesResponseSchema, `page=${String(page)}`),
    [api, page],
  );
  const now = new Date();
  const ready = loaded.state === 'ready' ? loaded.data : null;
  const shown = appendPage(earlier, ready?.items ?? []);
  const more = ready !== null && ready.page + 1 < ready.pages;
  return (
    <main className="page">
      <h1 className="title">{t('miniapp.services_title')}</h1>
      {shown.length === 0 ? (
        <Loading loaded={loaded} reload={reload}>
          {() => (
            <>
              <p className="muted">{t('miniapp.home_no_services')}</p>
              <Button primary onClick={() => navigate({ name: 'store' })}>
                {t('miniapp.home_buy')}
              </Button>
            </>
          )}
        </Loading>
      ) : (
        <>
          {shown.map((service) => (
            <ServiceCard
              key={service.id}
              service={service}
              now={now}
              onOpen={() => navigate({ name: 'service', serviceId: service.id })}
            />
          ))}
          {loaded.state === 'failed' && (
            <>
              <p className="error">{errorText(loaded.error)}</p>
              <Button onClick={reload}>{t('miniapp.retry')}</Button>
            </>
          )}
          {more && (
            <Button
              onClick={() => {
                setEarlier(shown);
                setPage(page + 1);
              }}
            >
              {t('miniapp.store_more')}
            </Button>
          )}
        </>
      )}
    </main>
  );
}

type ServiceRow = MiniAppServiceSummary;
