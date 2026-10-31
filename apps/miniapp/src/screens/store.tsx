import { useState } from 'react';
import {
  MINIAPP_ROUTES,
  miniAppCategoriesResponseSchema,
  miniAppCategoryResponseSchema,
  miniAppOrderSchema,
  type MiniAppCategoriesResponse,
  type MiniAppProduct,
} from '@nexa/contracts';
import { formatDurationDays } from '@nexa/i18n';
import type { MiniAppApi } from '../api.js';
import { useApp } from '../app.js';
import { t } from '../i18n/t.js';
import { money, trafficLimit } from '../format.js';
import { Button, Card, Loading, PersonalPrice, appendPage, errorText, useLoad } from '../ui.js';

/**
 * فروشگاه: the tenant's own categories as tabs (never four fixed period tabs — Nexa has
 * operator-defined categories), and each category's plans with the bot's eligibility and
 * visibility (a reseller's tier included), decided by the server.
 *
 * Not drawn: the country chips (no structured country exists, only free display text), the
 * «پرفروش» badge (no best-seller signal), and a per-plan cashback percent (cashback is
 * quoted per order; the exact amount is on the pre-invoice). A plan's devices are shown
 * only when the plan has a limit. The custom-service tab arrives with its own screen.
 */
export function Store() {
  const { api } = useApp();
  const { loaded, reload } = useLoad(() => allCategories(api), [api]);
  const [chosen, setChosen] = useState<string | null>(null);
  return (
    <main className="page">
      <h1 className="title">{t('miniapp.store_title')}</h1>
      <Loading loaded={loaded} reload={reload}>
        {(categories) => {
          if (categories.items.length === 0)
            return <p className="muted">{t('miniapp.store_empty')}</p>;
          const current = chosen ?? categories.items[0]?.id ?? null;
          return (
            <>
              <div className="chips" role="tablist">
                {categories.items.map((category) => (
                  <button
                    key={category.id}
                    type="button"
                    role="tab"
                    aria-selected={category.id === current}
                    className={category.id === current ? 'chip chip-on' : 'chip'}
                    onClick={() => setChosen(category.id)}
                  >
                    {category.emoji === null ? category.name : `${category.emoji} ${category.name}`}
                  </button>
                ))}
              </div>
              {current !== null && <Category key={current} categoryId={current} />}
            </>
          );
        }}
      </Loading>
    </main>
  );
}

/**
 * Every category, page after page: they are the store's tabs, so a tenant with more than one
 * page of them must see all of them, not the first page's. Bounded, so a server that kept
 * answering `hasMore` could not keep the store loading forever.
 */
const CATEGORY_PAGES_MAX = 50;

async function allCategories(api: MiniAppApi) {
  const items: MiniAppCategoriesResponse['items'][number][] = [];
  for (let page = 0; page < CATEGORY_PAGES_MAX; page += 1) {
    const result = await api.get(
      MINIAPP_ROUTES.categories,
      {},
      miniAppCategoriesResponseSchema,
      `page=${String(page)}`,
    );
    items.push(...result.items);
    if (!result.hasMore) break;
  }
  return { items };
}

function Category({ categoryId }: { categoryId: string }) {
  const { api, navigate } = useApp();
  const [page, setPage] = useState(0);
  // R12 F3 item 5: «بیشتر» adds the next page under the plans already shown.
  const [earlier, setEarlier] = useState<readonly MiniAppProduct[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { loaded, reload } = useLoad(
    () =>
      api.get(
        MINIAPP_ROUTES.category,
        { categoryId },
        miniAppCategoryResponseSchema,
        `page=${String(page)}`,
      ),
    [api, categoryId, page],
  );

  const buy = async (product: MiniAppProduct) => {
    setBusy(product.id);
    setError(null);
    try {
      const order = await api.post(MINIAPP_ROUTES.orders, {}, miniAppOrderSchema, {
        productId: product.id,
      });
      navigate({ name: 'checkout', orderId: order.id });
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  const ready = loaded.state === 'ready' ? loaded.data : null;
  const plans = appendPage(earlier, ready?.items ?? []);
  const list = (hasMore: boolean) => (
    <section className="section">
      {plans.length === 0 && <p className="muted">{t('miniapp.store_category_empty')}</p>}
      {plans.map((product) => (
        <Card key={product.id} className="plan">
          <div className="card-head">
            <strong>{product.title}</strong>
            {product.personalDiscount === null ? (
              <strong className="price">{money(product.price)}</strong>
            ) : (
              <PersonalPrice price={product.price} discount={product.personalDiscount} />
            )}
          </div>
          <div className="card-figures">
            <span>{trafficLimit(product.trafficBytes)}</span>
            <span>{formatDurationDays(product.durationDays)}</span>
            {product.deviceLimit !== null && (
              <span>{t('miniapp.service_devices', { count: product.deviceLimit })}</span>
            )}
          </div>
          {product.locations.length > 0 && (
            <p className="muted">{product.locations.join(t('miniapp.list_separator'))}</p>
          )}
          {product.features.length > 0 && (
            <ul className="features">
              {product.features.map((feature) => (
                <li key={feature}>{feature}</li>
              ))}
            </ul>
          )}
          <Button primary disabled={busy !== null} onClick={() => buy(product)}>
            {t('miniapp.store_continue')}
          </Button>
        </Card>
      ))}
      {error !== null && <p className="error">{error}</p>}
      {loaded.state === 'failed' && (
        <>
          <p className="error">{errorText(loaded.error)}</p>
          <Button onClick={reload}>{t('miniapp.retry')}</Button>
        </>
      )}
      {hasMore && (
        <Button
          onClick={() => {
            setEarlier(plans);
            setPage(page + 1);
          }}
        >
          {t('miniapp.store_more')}
        </Button>
      )}
    </section>
  );

  // The first page waits on its read; once a page is shown, «بیشتر» keeps it on screen.
  return earlier.length > 0 ? (
    list(ready?.hasMore === true)
  ) : (
    <Loading loaded={loaded} reload={reload}>
      {(result) => list(result.hasMore)}
    </Loading>
  );
}
