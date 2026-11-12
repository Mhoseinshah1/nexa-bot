import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  RESELLER_PURCHASE_MAX_QUANTITY,
  type MoneyWire,
  type ResellerCustomOffer,
  type ResellerPlan,
  type ResellerPurchaseBatch,
  type ResellerPurchaseQuote,
  type ResellerPurchaseQuoteRequest,
} from '@nexa/contracts';
import { ApiError } from '../../api/client';
import { errorText, hasErrorText } from '../../error-text';
import { formatMoneyText, formatNumber, formatTrafficGbText } from '../../format';
import { t } from '../../i18n/web.fa';
import { useSubmissionKey } from '../../submission-key';
import {
  Badge,
  Banner,
  Button,
  Empty,
  Field,
  Input,
  Select,
  StateSwitch,
  Skeleton,
  useCopyText,
  useToast,
  type Tone,
} from '../../ui/kit';
import { queryState } from '../../view-state';
import {
  ME_KEY,
  fetchCatalogueCategories,
  fetchCatalogueCustom,
  fetchCataloguePlans,
  fetchCatalogueServers,
  fetchClients,
  fetchMe,
  fetchPurchase,
  confirmPurchase,
  quotePurchase,
  sendPurchaseLinks,
} from '../api';
import { SCREEN_PATHS, goTo } from '../route';
import { RpCard } from '../view';
import { DASHBOARD_KEY } from './dashboard';
import { CLIENTS_KEY, SERVICES_KEY } from './services';
import { WALLET_KEY } from './wallet-topup';

const CUSTOM_TAB = 'custom';

/** How often the result is read again while a service is still being made or its link is due. */
export const PURCHASE_POLL_MS = 2500;
/** After this many reads a missing link is left alone (a files-only panel never has one). */
export const PURCHASE_POLL_LIMIT = 12;

// --- Money, in minor units ----------------------------------------------------------------

function times(money: MoneyWire, quantity: number): MoneyWire {
  return { ...money, amountMinor: (BigInt(money.amountMinor) * BigInt(quantity)).toString() };
}

/** `list × quantity − price × quantity`, never below zero; null when there is no list price. */
function savingOf(plan: ResellerPlan, quantity: number): MoneyWire | null {
  if (plan.listPrice === null || plan.listPrice.currency !== plan.price.currency) return null;
  const each = BigInt(plan.listPrice.amountMinor) - BigInt(plan.price.amountMinor);
  return { ...plan.price, amountMinor: (each > 0n ? each * BigInt(quantity) : 0n).toString() };
}

function afterOf(balance: MoneyWire | undefined, total: MoneyWire): MoneyWire | null {
  if (balance === undefined || balance.currency !== total.currency) return null;
  return {
    ...total,
    amountMinor: (BigInt(balance.amountMinor) - BigInt(total.amountMinor)).toString(),
  };
}

/** The text of a failed item's `reason`: a code the panel knows, else one general sentence. */
export function itemReasonText(reason: string | null): string {
  if (reason !== null && hasErrorText(reason)) {
    return errorText(new ApiError(409, reason, reason));
  }
  return t('web.rp_buy_reason_other');
}

function planSize(plan: ResellerPlan): string {
  const traffic =
    BigInt(plan.trafficBytes) === 0n
      ? t('web.rp_unlimited')
      : `${formatTrafficGbText(BigInt(plan.trafficBytes))} ${t('web.unit_gib')}`;
  return traffic;
}

/** A paged catalogue read that keeps asking while the API says there is more. */
function usePaged<T>(
  key: readonly unknown[],
  load: (page: number) => Promise<{ items: T[]; hasMore: boolean }>,
  enabled: boolean,
) {
  const query = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => load(pageParam),
    initialPageParam: 0,
    getNextPageParam: (last, all) => (last.hasMore ? all.length : undefined),
    enabled,
  });
  return {
    query,
    items: query.data?.pages.flatMap((page) => page.items) ?? [],
  };
}

type Step = 'form' | 'review' | 'result';

/**
 * «خرید سرویس»: the bot's own catalogue for this reseller (server step only when the API says
 * so, categories in the tenant's order, plan cards, «سرویس دلخواه» only when offered), then
 * quantity, username mode, client and note, a quote on the review step, and the per-service
 * result. Nothing here is a rule of its own: prices, ranges and refusals are the API's.
 */
export function BuyPage({ search = '' }: { search?: string }) {
  const client = useQueryClient();
  const toast = useToast();
  const me = useQuery({ queryKey: ME_KEY, queryFn: fetchMe, staleTime: 30_000 });
  const servers = useQuery({
    queryKey: ['reseller', 'catalogue', 'servers'],
    queryFn: () => fetchCatalogueServers(),
  });
  const clients = useQuery({ queryKey: [...CLIENTS_KEY, 'active'], queryFn: () => fetchClients() });
  const custom = useQuery({
    queryKey: ['reseller', 'catalogue', 'custom'],
    queryFn: fetchCatalogueCustom,
  });

  const [step, setStep] = useState<Step>('form');
  const [serverId, setServerId] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [plan, setPlan] = useState<ResellerPlan | null>(null);
  const [customForm, setCustomForm] = useState({ panelId: '', volume: '', days: '' });
  const [quantity, setQuantity] = useState(1);
  const [wantedMode, setWantedMode] = useState<'AUTOMATIC' | 'CUSTOM'>('AUTOMATIC');
  const [username, setUsername] = useState('');
  const [clientId, setClientId] = useState(() => new URLSearchParams(search).get('client') ?? '');
  const [note, setNote] = useState('');
  const [quote, setQuote] = useState<ResellerPurchaseQuote | null>(null);
  const [batch, setBatch] = useState<ResellerPurchaseBatch | null>(null);
  const [shortfall, setShortfall] = useState<MoneyWire | null>(null);
  const quoteKey = useSubmissionKey();
  const confirmKey = useSubmissionKey();

  const needsServer = servers.data?.step === true;
  const serverReady = servers.data !== undefined && (!needsServer || serverId !== null);
  const categories = usePaged(
    ['reseller', 'catalogue', 'categories', serverId],
    (page) => fetchCatalogueCategories(serverId, page),
    serverReady,
  );
  const customOffer: ResellerCustomOffer | undefined = custom.data;
  const customOffered = customOffer?.offered === true;

  // The first category is the tab shown until one is chosen.
  const firstCategory = categories.items[0]?.id ?? null;
  const activeCategory =
    category === CUSTOM_TAB && customOffered
      ? CUSTOM_TAB
      : category !== null && categories.items.some((one) => one.id === category)
        ? category
        : firstCategory;
  const plans = usePaged(
    ['reseller', 'catalogue', 'plans', activeCategory, serverId],
    (page) => fetchCataloguePlans(activeCategory ?? '', serverId, page),
    serverReady && activeCategory !== null && activeCategory !== CUSTOM_TAB,
  );

  // «دلخواه» is for one service only: more than one is always AUTOMATIC, whatever was chosen.
  const mode: 'AUTOMATIC' | 'CUSTOM' = quantity > 1 ? 'AUTOMATIC' : wantedMode;
  const effectiveClient =
    clients.data?.items.some((one) => one.id === clientId) === true ? clientId : '';
  const locations = customOffer?.locations ?? [];
  const location =
    locations.find((one) => one.panelId === customForm.panelId) ??
    (locations.length === 1 ? locations[0] : undefined);

  const customBody = useMemo(() => {
    if (location === undefined) return null;
    const volume = Number(customForm.volume.replace(',', '.'));
    const days = Number(customForm.days);
    const volumeHundredths = Math.round(volume * 100);
    if (
      !Number.isFinite(volume) ||
      !Number.isInteger(days) ||
      volumeHundredths < Number(location.volume.min) ||
      volumeHundredths > Number(location.volume.max) ||
      days < Number(location.days.min) ||
      days > Number(location.days.max)
    ) {
      return null;
    }
    return {
      kind: 'CUSTOM' as const,
      panelId: location.panelId,
      volume: customForm.volume.trim(),
      days: customForm.days.trim(),
    };
  }, [location, customForm.volume, customForm.days]);

  const planBody: ResellerPurchaseQuoteRequest['plan'] | null =
    activeCategory === CUSTOM_TAB
      ? customBody
      : plan === null
        ? null
        : { kind: 'PLAN', productId: plan.id };
  const usernameOk = mode === 'AUTOMATIC' || username.trim() !== '';
  const body: ResellerPurchaseQuoteRequest | null =
    planBody === null || !usernameOk
      ? null
      : {
          plan: planBody,
          quantity,
          username:
            mode === 'AUTOMATIC'
              ? { mode: 'AUTOMATIC' }
              : { mode: 'CUSTOM', value: username.trim() },
          clientId: effectiveClient === '' ? null : effectiveClient,
          note: note.trim() === '' ? null : note.trim(),
        };

  const refreshAfterBuy = () => {
    for (const key of [
      ME_KEY,
      DASHBOARD_KEY,
      SERVICES_KEY,
      WALLET_KEY,
      CLIENTS_KEY,
      ['reseller', 'client-services'],
    ]) {
      void client.invalidateQueries({ queryKey: [...key] });
    }
  };

  const makeQuote = useMutation({
    mutationFn: (request: ResellerPurchaseQuoteRequest) =>
      quotePurchase(request, quoteKey.current(request)),
    onSuccess: (next) => {
      quoteKey.settle();
      setQuote(next);
      setShortfall(null);
      setStep('review');
    },
    onError: (error) => {
      quoteKey.settleOn(error);
      toast({ tone: 'danger', message: errorText(error), error });
    },
  });

  const confirm = useMutation({
    mutationFn: (batchId: string) => confirmPurchase(batchId, confirmKey.current(batchId)),
    onSuccess: (done) => {
      confirmKey.settle();
      setBatch(done);
      setStep('result');
      refreshAfterBuy();
    },
    onError: (error) => {
      confirmKey.settleOn(error);
      if (error instanceof ApiError && error.code === 'commerce.wallet_insufficient_funds') {
        const minor = error.details?.['shortfallMinor'];
        if (typeof minor === 'string' && /^\d+$/u.test(minor) && quote !== null) {
          setShortfall({ ...quote.total, amountMinor: minor });
        }
        void client.invalidateQueries({ queryKey: ME_KEY });
        return;
      }
      toast({ tone: 'danger', message: errorText(error), error });
    },
  });

  function startOver() {
    setStep('form');
    setQuote(null);
    setBatch(null);
    setShortfall(null);
    setPlan(null);
    setQuantity(1);
    setUsername('');
    setNote('');
    setWantedMode('AUTOMATIC');
  }

  if (step === 'result' && batch !== null) {
    return <ResultStep initial={batch} onAgain={startOver} />;
  }
  if (step === 'review' && quote !== null) {
    return (
      <ReviewStep
        quote={quote}
        shortfall={shortfall}
        busy={confirm.isPending}
        onBack={() => setStep('form')}
        onConfirm={() => confirm.mutate(quote.batchId)}
      />
    );
  }

  // --- The form ----------------------------------------------------------------------------
  const unit = plan?.price ?? null;
  const total = unit === null || activeCategory === CUSTOM_TAB ? null : times(unit, quantity);
  const saving = plan === null || activeCategory === CUSTOM_TAB ? null : savingOf(plan, quantity);
  const after = total === null ? null : afterOf(me.data?.balance, total);
  const serverName = servers.data?.items.find((one) => one.id === serverId)?.name;
  const categoryState = queryState(
    categories.query,
    categories.items.length === 0 && !customOffered,
  );

  return (
    <div className="rp-split">
      <div className="rp-grow">
        {needsServer && (
          <RpCard title={t('web.rp_buy_server_title')} hint={t('web.rp_buy_server_hint')}>
            <div className="rp-chips" role="radiogroup" aria-label={t('web.rp_buy_server_title')}>
              {servers.data?.items.map((one) => (
                <button
                  key={one.id}
                  type="button"
                  role="radio"
                  aria-checked={one.id === serverId}
                  className={`rp-chip${one.id === serverId ? ' on' : ''}`}
                  onClick={() => {
                    setServerId(one.id);
                    setCategory(null);
                    setPlan(null);
                  }}
                >
                  {one.name}
                </button>
              ))}
            </div>
          </RpCard>
        )}
        <RpCard title={t('web.rp_buy_plan_title')} hint={t('web.rp_buy_plan_hint')}>
          <StateSwitch query={servers}>
            {!serverReady ? (
              <p className="muted">{t('web.rp_buy_server_first')}</p>
            ) : categoryState === 'loading' ? (
              <Skeleton rows={3} cols={3} />
            ) : categoryState === 'error' ? (
              <StateSwitch query={categories.query}>{null}</StateSwitch>
            ) : categoryState === 'empty' ? (
              <Empty variant="compact" title={t('web.rp_buy_no_categories')} />
            ) : (
              <>
                <div
                  className="rp-chips rp-tabs-gap"
                  role="tablist"
                  aria-label={t('web.rp_buy_categories_label')}
                >
                  {categories.items.map((one) => (
                    <button
                      key={one.id}
                      type="button"
                      role="tab"
                      aria-selected={one.id === activeCategory}
                      className={`rp-chip${one.id === activeCategory ? ' on' : ''}`}
                      onClick={() => {
                        setCategory(one.id);
                        setPlan(null);
                      }}
                    >
                      {one.emoji !== null && one.emoji !== '' ? `${one.emoji} ` : ''}
                      {one.name}
                    </button>
                  ))}
                  {categories.query.hasNextPage && (
                    <Button size="sm" onClick={() => void categories.query.fetchNextPage()}>
                      {t('web.rp_buy_more')}
                    </Button>
                  )}
                  {customOffered && (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={activeCategory === CUSTOM_TAB}
                      className={`rp-chip${activeCategory === CUSTOM_TAB ? ' on' : ''}`}
                      onClick={() => {
                        setCategory(CUSTOM_TAB);
                        setPlan(null);
                      }}
                    >
                      {t('web.rp_buy_custom_tab')}
                    </button>
                  )}
                </div>
                {activeCategory === CUSTOM_TAB ? (
                  <CustomFields offer={customOffer} value={customForm} onChange={setCustomForm} />
                ) : (
                  <PlanGrid paged={plans} selected={plan?.id ?? null} onPick={setPlan} />
                )}
              </>
            )}
          </StateSwitch>
        </RpCard>
        <RpCard title={t('web.rp_buy_details_title')} hint={t('web.rp_buy_details_hint')}>
          <div className="rp-form-grid">
            <Field label={t('web.rp_buy_quantity')} htmlFor="rp-buy-qty">
              <div className="rp-stepper">
                <button
                  type="button"
                  aria-label={t('web.rp_buy_qty_dec')}
                  disabled={quantity <= 1}
                  onClick={() => setQuantity(Math.max(1, quantity - 1))}
                >
                  −
                </button>
                <input
                  id="rp-buy-qty"
                  className="rp-stepper-value"
                  inputMode="numeric"
                  dir="ltr"
                  value={String(quantity)}
                  onChange={(event) => {
                    const next = Number.parseInt(event.target.value.replace(/\D/gu, ''), 10);
                    setQuantity(
                      Number.isNaN(next)
                        ? 1
                        : Math.min(RESELLER_PURCHASE_MAX_QUANTITY, Math.max(1, next)),
                    );
                  }}
                />
                <button
                  type="button"
                  aria-label={t('web.rp_buy_qty_inc')}
                  disabled={quantity >= RESELLER_PURCHASE_MAX_QUANTITY}
                  onClick={() =>
                    setQuantity(Math.min(RESELLER_PURCHASE_MAX_QUANTITY, quantity + 1))
                  }
                >
                  +
                </button>
              </div>
            </Field>
            <Field
              label={t('web.rp_buy_username')}
              hint={quantity > 1 ? t('web.rp_buy_username_multi') : t('web.rp_buy_username_hint')}
            >
              <div className="rp-chips" role="radiogroup" aria-label={t('web.rp_buy_username')}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={mode === 'AUTOMATIC'}
                  className={`rp-chip${mode === 'AUTOMATIC' ? ' on' : ''}`}
                  onClick={() => setWantedMode('AUTOMATIC')}
                >
                  {t('web.rp_buy_username_auto')}
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={mode === 'CUSTOM'}
                  disabled={quantity > 1}
                  className={`rp-chip${mode === 'CUSTOM' ? ' on' : ''}`}
                  onClick={() => setWantedMode('CUSTOM')}
                >
                  {t('web.rp_buy_username_custom')}
                </button>
              </div>
              {mode === 'CUSTOM' && (
                <Input
                  dir="ltr"
                  value={username}
                  maxLength={64}
                  placeholder={t('web.rp_buy_username_custom_ph')}
                  aria-label={t('web.rp_buy_username_custom_label')}
                  onChange={(event) => setUsername(event.target.value)}
                />
              )}
            </Field>
            <Field
              label={t('web.rp_buy_client')}
              hint={t('web.rp_buy_client_hint')}
              htmlFor="rp-buy-client"
            >
              <Select
                id="rp-buy-client"
                value={effectiveClient}
                onChange={(event) => setClientId(event.target.value)}
              >
                <option value="">{t('web.rp_buy_client_none')}</option>
                {clients.data?.items.map((one) => (
                  <option key={one.id} value={one.id}>
                    {one.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label={t('web.rp_buy_note')}
              hint={t('web.rp_buy_note_hint')}
              htmlFor="rp-buy-note"
            >
              <Input
                id="rp-buy-note"
                value={note}
                maxLength={500}
                onChange={(event) => setNote(event.target.value)}
              />
            </Field>
          </div>
        </RpCard>
      </div>
      <div className="rp-aside">
        <RpCard title={t('web.rp_buy_sum_title')} className="rp-sum">
          <dl className="rp-kv">
            <dt>{t('web.rp_buy_sum_product')}</dt>
            <dd>
              {activeCategory === CUSTOM_TAB ? t('web.rp_buy_custom_tab') : (plan?.title ?? '—')}
            </dd>
            {needsServer && (
              <>
                <dt>{t('web.rp_buy_sum_server')}</dt>
                <dd>{serverName ?? '—'}</dd>
              </>
            )}
            <dt>{t('web.rp_buy_sum_unit')}</dt>
            <dd>{unit === null ? t('web.rp_buy_sum_pending') : formatMoneyText(unit)}</dd>
            <dt>{t('web.rp_buy_sum_qty')}</dt>
            <dd>{formatNumber(quantity)}</dd>
            <dt>{t('web.rp_buy_sum_saving')}</dt>
            <dd className="ok">{saving === null ? '—' : formatMoneyText(saving)}</dd>
            <dt>{t('web.rp_buy_sum_total')}</dt>
            <dd>
              <b>{total === null ? '—' : formatMoneyText(total)}</b>
            </dd>
            <dt>{t('web.rp_buy_sum_after')}</dt>
            <dd>{after === null ? '—' : formatMoneyText(after)}</dd>
          </dl>
          {planBody === null && <p className="muted small">{t('web.rp_buy_pick_plan')}</p>}
          <Button
            variant="primary"
            disabled={body === null || makeQuote.isPending}
            onClick={() => {
              if (body !== null) makeQuote.mutate(body);
            }}
          >
            {t('web.rp_buy_review')}
          </Button>
          <p className="muted small">{t('web.rp_buy_money_note')}</p>
        </RpCard>
      </div>
    </div>
  );
}

// --- The plan cards and the custom service -------------------------------------------------

function PlanGrid({
  paged,
  selected,
  onPick,
}: {
  paged: ReturnType<typeof usePaged<ResellerPlan>>;
  selected: string | null;
  onPick: (plan: ResellerPlan) => void;
}) {
  const view = queryState(paged.query, paged.items.length === 0);
  if (view === 'loading') return <Skeleton rows={2} cols={3} />;
  if (view === 'error') return <StateSwitch query={paged.query}>{null}</StateSwitch>;
  if (view === 'empty') return <Empty variant="compact" title={t('web.rp_buy_no_plans')} />;
  return (
    <>
      <div className="rp-pgrid" role="radiogroup" aria-label={t('web.rp_buy_plans_label')}>
        {paged.items.map((one) => (
          <button
            key={one.id}
            type="button"
            role="radio"
            aria-checked={one.id === selected}
            className={`rp-plan${one.id === selected ? ' on' : ''}`}
            onClick={() => onPick(one)}
          >
            <span className="rp-line rp-between">
              <b>{one.title}</b>
              <Badge tone="neutral">
                {t('web.rp_days').replace('{n}', formatNumber(one.durationDays))}
              </Badge>
            </span>
            <span className="muted small">{planSize(one)}</span>
            {one.listPrice !== null &&
              BigInt(one.listPrice.amountMinor) > BigInt(one.price.amountMinor) && (
                <span className="rp-struck muted small">{formatMoneyText(one.listPrice)}</span>
              )}
            <b className="rp-plan-price">{formatMoneyText(one.price)}</b>
          </button>
        ))}
      </div>
      {paged.query.hasNextPage && (
        <div className="rp-gap">
          <Button
            size="sm"
            disabled={paged.query.isFetchingNextPage}
            onClick={() => void paged.query.fetchNextPage()}
          >
            {t('web.rp_buy_more')}
          </Button>
        </div>
      )}
    </>
  );
}

function CustomFields({
  offer,
  value,
  onChange,
}: {
  offer: ResellerCustomOffer | undefined;
  value: { panelId: string; volume: string; days: string };
  onChange: (next: { panelId: string; volume: string; days: string }) => void;
}) {
  const locations = offer?.locations ?? [];
  const chosen =
    locations.find((one) => one.panelId === value.panelId) ??
    (locations.length === 1 ? locations[0] : undefined);
  return (
    <div className="rp-form-grid">
      {locations.length > 1 && (
        <Field label={t('web.rp_buy_custom_location')} htmlFor="rp-custom-location">
          <Select
            id="rp-custom-location"
            value={value.panelId}
            onChange={(event) => onChange({ ...value, panelId: event.target.value })}
          >
            <option value="" />
            {locations.map((one) => (
              <option key={one.panelId} value={one.panelId}>
                {one.label}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field
        label={t('web.rp_buy_custom_volume')}
        htmlFor="rp-custom-volume"
        {...(chosen === undefined
          ? {}
          : {
              hint: t('web.rp_buy_custom_range')
                .replace('{min}', formatNumber(Number(chosen.volume.min) / 100))
                .replace('{max}', formatNumber(Number(chosen.volume.max) / 100)),
            })}
      >
        <Input
          id="rp-custom-volume"
          dir="ltr"
          inputMode="decimal"
          value={value.volume}
          onChange={(event) => onChange({ ...value, volume: event.target.value })}
        />
      </Field>
      <Field
        label={t('web.rp_buy_custom_days')}
        htmlFor="rp-custom-days"
        {...(chosen === undefined
          ? {}
          : {
              hint: t('web.rp_buy_custom_range')
                .replace('{min}', formatNumber(Number(chosen.days.min)))
                .replace('{max}', formatNumber(Number(chosen.days.max))),
            })}
      >
        <Input
          id="rp-custom-days"
          dir="ltr"
          inputMode="numeric"
          value={value.days}
          onChange={(event) => onChange({ ...value, days: event.target.value })}
        />
      </Field>
      <p className="muted small">{t('web.rp_buy_custom_note')}</p>
    </div>
  );
}

// --- Review ----------------------------------------------------------------------------------

function ReviewStep({
  quote,
  shortfall,
  busy,
  onBack,
  onConfirm,
}: {
  quote: ResellerPurchaseQuote;
  shortfall: MoneyWire | null;
  busy: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const short = !quote.sufficient || shortfall !== null;
  const missing = shortfall ?? quote.shortfall;
  return (
    <RpCard title={t('web.rp_buy_review_title')} className="rp-review">
      <dl className="rp-kv">
        <dt>{t('web.rp_buy_sum_product')}</dt>
        <dd>{quote.title}</dd>
        <dt>{t('web.rp_buy_sum_unit')}</dt>
        <dd>{formatMoneyText(quote.unitPrice)}</dd>
        <dt>{t('web.rp_buy_sum_qty')}</dt>
        <dd>{formatNumber(quote.quantity)}</dd>
        <dt>{t('web.rp_buy_sum_saving')}</dt>
        <dd className="ok">{formatMoneyText(quote.saving)}</dd>
        <dt>{t('web.rp_buy_sum_total')}</dt>
        <dd>
          <b>{formatMoneyText(quote.total)}</b>
        </dd>
        <dt>{t('web.rp_buy_sum_after')}</dt>
        <dd>{formatMoneyText(quote.balanceAfter)}</dd>
        {quote.usernameMode === 'CUSTOM' && quote.username !== null && (
          <>
            <dt>{t('web.rp_buy_username')}</dt>
            <dd dir="ltr">{quote.username}</dd>
          </>
        )}
        {quote.note !== null && (
          <>
            <dt>{t('web.rp_buy_note')}</dt>
            <dd>{quote.note}</dd>
          </>
        )}
      </dl>
      {short && (
        <Banner tone="warn">
          {missing === null
            ? t('web.rp_buy_short').replace('{amount}', '—')
            : t('web.rp_buy_short').replace('{amount}', formatMoneyText(missing))}
        </Banner>
      )}
      <div className="rp-line">
        {short ? (
          <Button variant="primary" onClick={() => goTo(SCREEN_PATHS.wallet)}>
            {t('web.rp_buy_charge')}
          </Button>
        ) : (
          <Button variant="primary" disabled={busy} onClick={onConfirm}>
            {t('web.rp_buy_confirm').replace('{n}', formatNumber(quote.quantity))}
          </Button>
        )}
        <Button disabled={busy} onClick={onBack}>
          {t('web.rp_buy_edit')}
        </Button>
      </div>
      <p className="muted small">{t('web.rp_buy_money_note')}</p>
    </RpCard>
  );
}

// --- Result ----------------------------------------------------------------------------------

const ITEM_TONE: Readonly<Record<string, Tone>> = {
  CREATED: 'ok',
  FAILED: 'danger',
  PAID: 'info',
  QUOTED: 'neutral',
};
const ITEM_LABEL = {
  CREATED: 'web.rp_buy_item_created',
  FAILED: 'web.rp_buy_item_failed',
  PAID: 'web.rp_buy_item_paid',
  QUOTED: 'web.rp_buy_item_quoted',
} as const;

function stillMoving(batch: ResellerPurchaseBatch): boolean {
  return batch.items.some(
    (item) =>
      item.status === 'PAID' ||
      item.status === 'QUOTED' ||
      (item.status === 'CREATED' && item.subscriptionUrl === null),
  );
}

/**
 * The per-service result of a confirmed purchase: each service created or failed with its
 * reason, re-read while one is still being made (PAID) or its link is not yet delivered.
 */
export function ResultStep({
  initial,
  onAgain,
}: {
  initial: ResellerPurchaseBatch;
  onAgain: () => void;
}) {
  const toast = useToast();
  const copyText = useCopyText();
  const [reads, setReads] = useState(0);
  const query = useQuery({
    queryKey: ['reseller', 'purchase', initial.batchId],
    queryFn: () => fetchPurchase(initial.batchId),
    initialData: initial,
    staleTime: 0,
    refetchInterval: (current) => {
      const data = current.state.data;
      return data !== undefined && stillMoving(data) && reads < PURCHASE_POLL_LIMIT
        ? PURCHASE_POLL_MS
        : false;
    },
  });
  useEffect(() => {
    if (query.dataUpdatedAt > 0) setReads((count) => count + 1);
  }, [query.dataUpdatedAt]);
  const batch = query.data;
  const created = batch.items.filter((item) => item.status === 'CREATED').length;
  const links = batch.items.flatMap((item) =>
    item.subscriptionUrl === null ? [] : [item.subscriptionUrl],
  );
  const polling = stillMoving(batch) && reads < PURCHASE_POLL_LIMIT;

  const send = useMutation({
    mutationFn: () => sendPurchaseLinks(batch.batchId),
    onSuccess: (done) =>
      toast({
        tone: done.failed > 0 ? 'warn' : 'ok',
        message: t(done.failed > 0 ? 'web.rp_buy_sent_failed' : 'web.rp_buy_sent')
          .replace('{sent}', formatNumber(done.sent))
          .replace('{failed}', formatNumber(done.failed)),
      }),
    onError: (error) => toast({ tone: 'danger', message: errorText(error), error }),
  });

  return (
    <RpCard
      title={t('web.rp_buy_result_title')}
      hint={t('web.rp_buy_result_summary')
        .replace('{ok}', formatNumber(created))
        .replace('{n}', formatNumber(batch.items.length))}
    >
      {batch.clientName !== null && (
        <p className="muted small">
          {t('web.rp_buy_client_line').replace('{name}', batch.clientName)}
        </p>
      )}
      <div className="rp-table-wrap">
        <table className="rp-table">
          <thead>
            <tr>
              <th>{t('web.rp_buy_col_user')}</th>
              <th>{t('web.rp_buy_col_order')}</th>
              <th>{t('web.rp_buy_col_status')}</th>
              <th>{t('web.rp_buy_col_link')}</th>
            </tr>
          </thead>
          <tbody>
            {batch.items.map((item) => (
              <tr key={item.orderId}>
                <td dir="ltr" className="rp-mono">
                  {item.username ?? '—'}
                </td>
                <td dir="ltr" className="rp-mono">
                  {item.orderCode ?? '—'}
                </td>
                <td>
                  <div className="rp-stack">
                    <Badge tone={ITEM_TONE[item.status] ?? 'neutral'} dot>
                      {t(ITEM_LABEL[item.status])}
                    </Badge>
                    {item.status === 'FAILED' && (
                      <span className="danger small">{itemReasonText(item.reason)}</span>
                    )}
                  </div>
                </td>
                <td>
                  {item.subscriptionUrl !== null ? (
                    <span dir="ltr" className="rp-mono rp-clip">
                      {item.subscriptionUrl}
                    </span>
                  ) : item.status === 'CREATED' && polling ? (
                    <span className="muted small">{t('web.rp_buy_link_pending')}</span>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="rp-line rp-gap">
        <Button
          variant="primary"
          disabled={created === 0 || send.isPending}
          onClick={() => send.mutate()}
        >
          {t('web.rp_buy_send')}
        </Button>
        <Button
          disabled={links.length === 0}
          onClick={() => copyText(links.join('\n'), t('web.rp_buy_copied'))}
        >
          {t('web.rp_buy_copy')}
        </Button>
        <Button variant="ghost" onClick={onAgain}>
          {t('web.rp_buy_again')}
        </Button>
      </div>
    </RpCard>
  );
}
