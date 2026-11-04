import { useState } from 'react';
import {
  MINIAPP_ROUTES,
  miniAppCategoriesResponseSchema,
  miniAppCategoryResponseSchema,
  miniAppOrderSchema,
  miniAppServersResponseSchema,
  type MiniAppServersResponse,
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
 * فروشگاه: step by step, like the bot — (server →) category → plan. The server step exists
 * only when `servers.step` is true (the setting on AND more than one server qualifies); with
 * one server or the setting off it starts at the categories. Each step is a list of cards
 * with a back control; the chosen `serverId` goes to the category and plan calls, and
 * changing the server resets the category. Categories are the tenant's own (never four fixed
 * period tabs), and each category's plans carry the bot's eligibility and visibility (a
 * reseller's tier included), decided by the server.
 *
 * Not drawn: the country chips (no structured country exists, only free display text), the
 * «پرفروش» badge (no best-seller signal), and a per-plan cashback percent (cashback is
 * quoted per order; the exact amount is on the pre-invoice). A plan's devices are shown
 * only when the plan has a limit. The custom-service tab arrives with its own screen.
 */
export function Store() {
  const { api } = useApp();
  // A servers read that fails reads as «no server step»: it is an optional narrowing, and the
  // whole catalogue is still sellable without it.
  const { loaded, reload } = useLoad(
    () => allServers(api).catch(() => ({ step: false, items: [] as ServerRow[] })),
    [api],
  );
  const [server, setServer] = useState<ServerRow | null>(null);
  const [category, setCategory] = useState<CategoryRow | null>(null);
  return (
    <main className="page">
      <Loading loaded={loaded} reload={reload}>
        {(servers) => {
          if (servers.step && server === null) {
            return (
              <>
                <h1 className="title">{t('miniapp.store_title')}</h1>
                <StepList
                  title={t('miniapp.store_step_server')}
                  items={servers.items.map((one) => ({ id: one.id, label: one.name }))}
                  onPick={(id) => {
                    setServer(servers.items.find((one) => one.id === id) ?? null);
                    setCategory(null);
                  }}
                />
              </>
            );
          }
          const serverId = servers.step ? (server?.id ?? null) : null;
          if (category === null) {
            return (
              <>
                <h1 className="title">{t('miniapp.store_title')}</h1>
                <Categories
                  key={serverId ?? 'all'}
                  serverId={serverId}
                  onBack={servers.step ? () => setServer(null) : null}
                  onPick={setCategory}
                />
              </>
            );
          }
          return (
            <>
              <h1 className="title">{t('miniapp.store_title')}</h1>
              <div className="step-head">
                <BackButton onClick={() => setCategory(null)} />
                <h2 className="step-title">{categoryLabel(category)}</h2>
              </div>
              <Category
                key={`${serverId ?? 'all'}:${category.id}`}
                categoryId={category.id}
                serverId={serverId}
              />
            </>
          );
        }}
      </Loading>
    </main>
  );
}

type ServerRow = MiniAppServersResponse['items'][number];
type CategoryRow = MiniAppCategoriesResponse['items'][number];

const categoryLabel = (category: CategoryRow) =>
  category.emoji === null ? category.name : `${category.emoji} ${category.name}`;

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <Button small onClick={onClick}>
      {t('miniapp.store_step_back')}
    </Button>
  );
}

function StepList({
  title,
  items,
  onPick,
  onBack,
}: {
  title: string;
  items: readonly { id: string; label: string }[];
  onPick: (id: string) => void;
  onBack?: (() => void) | null;
}) {
  return (
    <section className="section">
      <div className="step-head">
        {onBack !== undefined && onBack !== null && <BackButton onClick={onBack} />}
        <h2 className="step-title">{title}</h2>
      </div>
      <div className="step-list">
        {items.map((item) => (
          <button key={item.id} type="button" className="step-item" onClick={() => onPick(item.id)}>
            {item.label}
          </button>
        ))}
      </div>
    </section>
  );
}

/** The category step: the tenant's categories (on the chosen server, when there is one). */
function Categories({
  serverId,
  onBack,
  onPick,
}: {
  serverId: string | null;
  onBack: (() => void) | null;
  onPick: (category: CategoryRow) => void;
}) {
  const { api } = useApp();
  const { loaded, reload } = useLoad(() => allCategories(api, serverId), [api, serverId]);
  return (
    <Loading loaded={loaded} reload={reload}>
      {(categories) =>
        categories.items.length === 0 ? (
          <>
            {onBack !== null && <BackButton onClick={onBack} />}
            <p className="muted">{t('miniapp.store_empty')}</p>
          </>
        ) : (
          <StepList
            title={t('miniapp.store_step_category')}
            items={categories.items.map((one) => ({ id: one.id, label: categoryLabel(one) }))}
            onBack={onBack}
            onPick={(id) => {
              const picked = categories.items.find((one) => one.id === id);
              if (picked !== undefined) onPick(picked);
            }}
          />
        )
      }
    </Loading>
  );
}

/** Bounded paging, so a server that kept answering `hasMore` could not load forever. */
const CATALOGUE_PAGES_MAX = 50;

const withServer = (page: number, serverId: string | null) =>
  serverId === null ? `page=${String(page)}` : `page=${String(page)}&serverId=${serverId}`;

async function allServers(api: MiniAppApi) {
  const items: ServerRow[] = [];
  let step = false;
  for (let page = 0; page < CATALOGUE_PAGES_MAX; page += 1) {
    const result = await api.get(
      MINIAPP_ROUTES.servers,
      {},
      miniAppServersResponseSchema,
      `page=${String(page)}`,
    );
    step = result.step;
    items.push(...result.items);
    if (!result.step || !result.hasMore) break;
  }
  return { step, items };
}

/**
 * Every category, page after page: a tenant with more than one page of them must see all of
 * them, not the first page's.
 */
async function allCategories(api: MiniAppApi, serverId: string | null) {
  const items: CategoryRow[] = [];
  for (let page = 0; page < CATALOGUE_PAGES_MAX; page += 1) {
    const result = await api.get(
      MINIAPP_ROUTES.categories,
      {},
      miniAppCategoriesResponseSchema,
      withServer(page, serverId),
    );
    items.push(...result.items);
    if (!result.hasMore) break;
  }
  return { items };
}

function Category({ categoryId, serverId }: { categoryId: string; serverId: string | null }) {
  const { api, navigate } = useApp();
  const [page, setPage] = useState(0);
  // R12 F3 item 5: «بیشتر» adds the next page under the plans already shown.
  const [earlier, setEarlier] = useState<readonly MiniAppProduct[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The page each result answers, so «بیشتر» never advances from a result of an EARLIER
  // page still on screen while the requested one loads (two quick taps skipped a page).
  const { loaded, reload } = useLoad(
    async () => ({
      forPage: page,
      result: await api.get(
        MINIAPP_ROUTES.category,
        { categoryId },
        miniAppCategoryResponseSchema,
        withServer(page, serverId),
      ),
    }),
    [api, categoryId, serverId, page],
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

  const ready = loaded.state === 'ready' ? loaded.data.result : null;
  const current = loaded.state === 'ready' && loaded.data.forPage === page;
  const plans = appendPage(earlier, ready?.items ?? []);
  const list = (hasMore: boolean) => (
    <section className="section">
      {plans.length === 0 && <p className="muted">{t('miniapp.store_category_empty')}</p>}
      {plans.map((product) => (
        <Card key={product.id} className="plan">
          <div className="card-head">
            <strong className="plan-title">{product.title}</strong>
            {product.personalDiscount === null ? (
              <strong className="price">{money(product.price)}</strong>
            ) : (
              <PersonalPrice price={product.price} discount={product.personalDiscount} />
            )}
          </div>
          <div className="plan-foot">
            <p className="plan-figures muted">
              <span>{trafficLimit(product.trafficBytes)}</span>
              <span>{formatDurationDays(product.durationDays)}</span>
              {product.deviceLimit !== null && (
                <span>{t('miniapp.service_devices', { count: product.deviceLimit })}</span>
              )}
            </p>
            <Button primary small disabled={busy !== null} onClick={() => buy(product)}>
              {t('miniapp.store_continue')}
            </Button>
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
    list(current && ready?.hasMore === true)
  ) : (
    <Loading loaded={loaded} reload={reload}>
      {(loadedPage) => list(loadedPage.forPage === page && loadedPage.result.hasMore)}
    </Loading>
  );
}
