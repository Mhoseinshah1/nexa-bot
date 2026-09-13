import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CURRENCY_CODES,
  MAX_DEVICE_LIMIT,
  MAX_DURATION_DAYS,
  PRODUCT_DESCRIPTION_MAX_LENGTH,
  PRODUCT_SORT_MAX,
  PRODUCT_SORT_MIN,
  PRODUCT_TITLE_MAX_LENGTH,
  UNLIMITED_DURATION_DAYS,
  UNLIMITED_TRAFFIC_BYTES,
  type CurrencyCode,
  type ProductAudience,
  type ProductStatus,
  type ProductSummaryResponse,
} from '@nexa/contracts';
import {
  activateProduct,
  createProduct,
  deactivateProduct,
  fetchPanels,
  fetchProduct,
  fetchProducts,
  updateProduct,
  type ProductWriteInput,
} from '../api/client';
import { formatNumber, formatTimestamp, splitBytes } from '../format';
import { useSubmissionKey } from '../submission-key';
import { mayRequest, queryState } from '../view-state';
import { t, type WebKey } from '../i18n/web.fa';
import { setQuery, useLinkHandler, type Route } from '../router';
import { messageFor } from './settings';
import {
  Badge,
  Banner,
  Card,
  Copyable,
  CursorPager,
  DataTable,
  Empty,
  Field,
  KV,
  Ltr,
  Money,
  PageHead,
  Pills,
  StateSwitch,
  useToast,
  type Column,
  type Tone,
} from '../ui/kit';

/**
 * Products — the tenant's catalogue, as the operator curates it.
 *
 * This list is NOT the customer catalogue and the difference is the thing the page
 * exists to make visible. `listCatalog` admits a product only when it is ACTIVE, not
 * HIDDEN, priced and bound to a panel; this list shows everything, because curating the
 * ones that fail is the work. So every row carries a second badge saying whether a
 * customer can see it and, when not, WHICH of the four it fails — the question an
 * operator otherwise answers by publishing a plan and waiting for nobody to buy it.
 *
 * Those predicates are re-derived here from the response rather than imported: the
 * server's are in SQL and in `catalog-visibility.ts`, both behind the seam, and the
 * fields this needs are exactly the ones `productSummarySchema` declares. A test asserts
 * this page's answer against the same table the server's two copies are checked with.
 *
 * There is no pricing-rule editor, no discount and no category. Each belongs to a phase
 * that has not shipped, and a disabled control for one would claim the feature exists.
 */

const STATUS_LABELS: Readonly<Record<ProductStatus, WebKey>> = {
  ACTIVE: 'web.product_status_active',
  INACTIVE: 'web.product_status_inactive',
};

const STATUS_TONES: Readonly<Record<ProductStatus, Tone>> = {
  ACTIVE: 'ok',
  INACTIVE: 'neutral',
};

const AUDIENCE_LABELS: Readonly<Record<ProductAudience, WebKey>> = {
  EVERYONE: 'web.product_audience_everyone',
  RESELLERS_ONLY: 'web.product_audience_resellers',
  HIDDEN: 'web.product_audience_hidden',
};

/**
 * Why a customer cannot see this product, or null when they can.
 *
 * The ORDER matters and matches the server's: status first, then audience, then price,
 * then panel. An operator fixing them one at a time is told the next thing wrong rather
 * than all four at once, and the first is the one they most likely did on purpose.
 *
 * The two audience gaps are NOT the same thing and are deliberately separate badges.
 * `UNLISTED` is a HIDDEN product, which is out of the listing and still ORDERABLE by
 * anybody holding its reference — that is what the audience is for. `RESELLERS` is a
 * RESELLERS_ONLY product, which Phase 4B can neither list nor sell, because no reseller
 * identity exists to check a customer against; `catalog-visibility.ts` carries the whole
 * argument. Collapsing them would tell an operator their reseller product merely needs a
 * link passed around, and it does not.
 */
export type CatalogueGap = 'INACTIVE' | 'UNLISTED' | 'RESELLERS' | 'UNPRICED' | 'NO_PANEL';

export function catalogueGap(row: ProductSummaryResponse): CatalogueGap | null {
  if (row.status !== 'ACTIVE') return 'INACTIVE';
  if (row.audience === 'HIDDEN') return 'UNLISTED';
  if (row.audience === 'RESELLERS_ONLY') return 'RESELLERS';
  if (row.priceAmount === null) return 'UNPRICED';
  if (row.panelId === null) return 'NO_PANEL';
  return null;
}

const GAP_LABELS: Readonly<Record<CatalogueGap, WebKey>> = {
  INACTIVE: 'web.product_gap_inactive',
  UNLISTED: 'web.product_gap_unlisted',
  RESELLERS: 'web.product_gap_resellers',
  UNPRICED: 'web.product_gap_unpriced',
  NO_PANEL: 'web.product_gap_no_panel',
};

function CatalogueBadge({ row }: { row: ProductSummaryResponse }) {
  const gap = catalogueGap(row);
  if (gap === null) return <Badge tone="ok">{t('web.product_in_catalogue')}</Badge>;
  // `UNLISTED` is amber and not red: a HIDDEN product is still ORDERABLE by anybody
  // holding its link, which is what the audience means. The others are configuration —
  // `RESELLERS` included, because that one is not orderable at all in this phase.
  return <Badge tone={gap === 'UNLISTED' ? 'warn' : 'neutral'}>{t(GAP_LABELS[gap])}</Badge>;
}

function Dash() {
  return <span className="faint">—</span>;
}

/** A traffic allowance, or the word for "no limit". Zero is a sentinel, not a quantity. */
function Traffic({ bytes }: { bytes: string }) {
  const value = BigInt(bytes);
  if (value === UNLIMITED_TRAFFIC_BYTES) return <span>{t('web.product_unlimited')}</span>;
  const { value: amount, unit } = splitBytes(value);
  return (
    <span className="nowrap">
      <Ltr>{amount}</Ltr> {t(unit)}
    </span>
  );
}

/** Days of validity, or the word for "no limit". Same sentinel rule. */
function Duration({ days }: { days: number }) {
  if (days === UNLIMITED_DURATION_DAYS) return <span>{t('web.product_unlimited')}</span>;
  return (
    <span className="nowrap">
      <Ltr>{formatNumber(days)}</Ltr> {t('web.product_days_unit')}
    </span>
  );
}

function Price({ row }: { row: ProductSummaryResponse }) {
  if (row.priceAmount === null || row.priceCurrency === null) return <Dash />;
  return <Money value={{ amountMinor: row.priceAmount, currency: row.priceCurrency }} />;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function ProductsPage({
  route,
  mayEdit,
  denied,
}: {
  route: Route;
  /** `catalog.edit` — a separate server permission from `catalog.view`, which `denied` carries. */
  mayEdit: boolean;
  denied: boolean;
}) {
  const onLink = useLinkHandler();

  const appliedStatus = statusFromQuery(route.query.get('status'));
  const appliedAudience = audienceFromQuery(route.query.get('audience'));
  const appliedTitle = route.query.get('title') ?? '';

  /*
   * The draft FOLLOWS the applied value, derived rather than initialised — the shape
   * `users.tsx` records in full. The sidebar's own link re-renders this component with
   * an empty query instead of remounting it, so a `useState` initialiser would leave the
   * box showing a search that is no longer applied.
   */
  const [draft, setDraft] = useState<{ signature: string; title: string }>({
    signature: appliedTitle,
    title: appliedTitle,
  });
  const draftTitle = draft.signature === appliedTitle ? draft.title : appliedTitle;

  /*
   * The cursor trail, keyed by the SEARCH it was minted under.
   *
   * A cursor minted under one filter strands every row before it under another. Joined
   * on `|`, which cannot appear in a status or an audience; the title can contain
   * anything, so it goes LAST — no other field can absorb its separator.
   */
  const searchSignature = [appliedStatus ?? '', appliedAudience ?? '', appliedTitle].join('|');
  const [trail, setTrail] = useState<{ signature: string; cursors: readonly string[] }>({
    signature: searchSignature,
    cursors: [],
  });
  const cursors = trail.signature === searchSignature ? trail.cursors : [];
  const cursor = cursors.length > 0 ? cursors[cursors.length - 1] : undefined;
  const pushCursor = (next: string) =>
    setTrail({ signature: searchSignature, cursors: [...cursors, next] });
  const popCursor = () => setTrail({ signature: searchSignature, cursors: cursors.slice(0, -1) });

  const products = useQuery({
    queryKey: ['products', searchSignature, cursor ?? null],
    queryFn: () =>
      fetchProducts({
        ...(cursor === undefined ? {} : { cursor }),
        ...(appliedStatus === null ? {} : { status: appliedStatus }),
        ...(appliedAudience === null ? {} : { audience: appliedAudience }),
        ...(appliedTitle === '' ? {} : { title: appliedTitle }),
      }),
    enabled: !denied,
  });

  const rows = products.data?.products ?? [];
  const nextCursor = products.data?.nextCursor ?? null;
  const searching = appliedTitle !== '';
  const clearable = searching || draftTitle !== '';

  const apply = (event: FormEvent) => {
    event.preventDefault();
    setQuery(route, 'title', draftTitle === '' ? null : draftTitle);
  };

  const columns: readonly Column<ProductSummaryResponse>[] = [
    {
      key: 'title',
      header: t('web.product_title'),
      render: (row) => (
        <a href={`/products/${encodeURIComponent(row.id)}`} onClick={onLink} className="strong">
          {row.title}
        </a>
      ),
    },
    {
      key: 'status',
      header: t('web.status'),
      render: (row) => (
        <Badge tone={STATUS_TONES[row.status]}>{t(STATUS_LABELS[row.status])}</Badge>
      ),
    },
    {
      key: 'catalogue',
      header: t('web.product_catalogue'),
      render: (row) => <CatalogueBadge row={row} />,
    },
    {
      key: 'audience',
      header: t('web.product_audience'),
      render: (row) => <span>{t(AUDIENCE_LABELS[row.audience])}</span>,
    },
    { key: 'price', header: t('web.product_price'), render: (row) => <Price row={row} /> },
    {
      key: 'duration',
      header: t('web.product_duration'),
      render: (row) => <Duration days={row.durationDays} />,
    },
    {
      key: 'traffic',
      header: t('web.product_traffic'),
      render: (row) => <Traffic bytes={row.trafficBytes} />,
    },
    {
      key: 'sort',
      header: t('web.product_sort_order'),
      render: (row) => <Ltr>{formatNumber(row.sortOrder)}</Ltr>,
    },
  ];

  return (
    <>
      <PageHead title={t('web.products_title')} subtitle={t('web.products_intro')} maturity="now" />

      <Card>
        {/* Hidden while the card below cannot answer: a control that mints a new query
            key is a fresh request against a question the server has just refused. */}
        <div hidden={!mayRequest(products, denied)}>
          <form className="toolbar" onSubmit={apply}>
            <Field
              label={t('web.products_search_title')}
              hint={t('web.products_search_title_hint')}
              htmlFor="products-title"
            >
              <input
                id="products-title"
                value={draftTitle}
                maxLength={PRODUCT_TITLE_MAX_LENGTH}
                onChange={(event) =>
                  setDraft({ signature: appliedTitle, title: event.target.value })
                }
              />
            </Field>
            <button type="submit" className="btn primary sm">
              {t('web.users_search_apply')}
            </button>
            <button
              type="button"
              className="btn sm"
              disabled={!clearable}
              onClick={() => {
                setDraft({ signature: appliedTitle, title: '' });
                setQuery(route, 'title', null);
              }}
            >
              {t('web.users_search_clear')}
            </button>
          </form>

          <div className="toolbar">
            <Pills
              value={appliedStatus ?? 'ALL'}
              onChange={(next) => setQuery(route, 'status', next === 'ALL' ? null : next)}
              items={[
                { id: 'ALL' as const, label: t('web.users_filter_all') },
                { id: 'ACTIVE' as const, label: t('web.product_status_active') },
                { id: 'INACTIVE' as const, label: t('web.product_status_inactive') },
              ]}
            />
            <Pills
              value={appliedAudience ?? 'ALL'}
              onChange={(next) => setQuery(route, 'audience', next === 'ALL' ? null : next)}
              items={[
                { id: 'ALL' as const, label: t('web.product_audience_all') },
                { id: 'EVERYONE' as const, label: t('web.product_audience_everyone') },
                { id: 'RESELLERS_ONLY' as const, label: t('web.product_audience_resellers') },
                { id: 'HIDDEN' as const, label: t('web.product_audience_hidden') },
              ]}
            />
          </div>
        </div>

        <StateSwitch
          query={products}
          denied={denied}
          isEmpty={rows.length === 0}
          empty={
            searching ? (
              <Empty
                title={t('web.products_search_empty')}
                hint={t('web.products_search_empty_hint')}
                icon="inbox"
              />
            ) : (
              <Empty
                title={t('web.products_empty')}
                hint={t('web.products_empty_hint')}
                icon="products"
              />
            )
          }
        >
          <DataTable
            caption={t('web.products_title')}
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
          />
        </StateSwitch>

        {!denied && queryState(products) === 'ready' && (
          <CursorPager
            shown={rows.length}
            hasPrevious={cursors.length > 0}
            hasNext={nextCursor !== null}
            onPrevious={popCursor}
            onNext={() => nextCursor !== null && pushCursor(nextCursor)}
            // `GET /products` pages an ASCENDING keyset — the earliest product first —
            // so "next" is NEWER here, as on `/users`.
            nextLabel="web.newer"
            previousLabel="web.older"
          />
        )}
      </Card>

      {mayEdit ? (
        <ProductForm mode="create" />
      ) : (
        // A sentence, not a disabled form. Both make the same claim and only one names
        // the permission an operator would have to ask for.
        <Card title={t('web.product_new_title')}>
          <Banner tone="info">{t('web.product_edit_denied')}</Banner>
        </Card>
      )}

      <Card title={t('web.products_scope_title')}>
        <p className="muted">{t('web.products_scope_body')}</p>
        {/* Owner revision 10, which used to live on the planned page this route
            replaced. A decision recorded only on a screen nobody can open is a decision
            nobody reads before breaking it. */}
        <p className="muted">{t('web.products_panel_rule')}</p>
      </Card>
    </>
  );
}

function statusFromQuery(raw: string | null): ProductStatus | null {
  return raw === 'ACTIVE' || raw === 'INACTIVE' ? raw : null;
}

function audienceFromQuery(raw: string | null): ProductAudience | null {
  return raw === 'EVERYONE' || raw === 'RESELLERS_ONLY' || raw === 'HIDDEN' ? raw : null;
}

// ---------------------------------------------------------------------------
// The write form, shared by create and edit
// ---------------------------------------------------------------------------

interface FormState {
  title: string;
  description: string;
  audience: ProductAudience;
  sortOrder: string;
  panelId: string;
  durationDays: string;
  trafficBytes: string;
  deviceLimit: string;
  priceAmount: string;
  priceCurrency: CurrencyCode;
}

const BLANK: FormState = {
  title: '',
  description: '',
  audience: 'EVERYONE',
  sortOrder: '0',
  panelId: '',
  durationDays: '30',
  trafficBytes: '0',
  deviceLimit: '',
  priceAmount: '',
  priceCurrency: 'IRT',
};

function stateOf(row: ProductSummaryResponse): FormState {
  return {
    title: row.title,
    description: row.description ?? '',
    audience: row.audience,
    sortOrder: String(row.sortOrder),
    panelId: row.panelId ?? '',
    durationDays: String(row.durationDays),
    trafficBytes: row.trafficBytes,
    deviceLimit: row.deviceLimit === null ? '' : String(row.deviceLimit),
    priceAmount: row.priceAmount ?? '',
    priceCurrency: row.priceCurrency ?? 'IRT',
  };
}

/**
 * The form body, or the reason it cannot be sent.
 *
 * Validated HERE as well as on the server, and the two are not redundant: the server's
 * refusal is a 400 that an operator reads as "something is wrong", while this names the
 * field. The rules are read from the CONTRACT's own constants, so there is one
 * definition of each bound and no chance of this form accepting what the schema refuses.
 */
export function bodyFrom(
  state: FormState,
): { body: Omit<ProductWriteInput, 'idempotencyKey'> } | { problem: WebKey } {
  const title = state.title.trim();
  if (title === '') return { problem: 'web.product_problem_title' };

  const sortOrder = Number(state.sortOrder);
  if (
    !Number.isInteger(sortOrder) ||
    sortOrder < PRODUCT_SORT_MIN ||
    sortOrder > PRODUCT_SORT_MAX
  ) {
    return { problem: 'web.product_problem_sort' };
  }

  const durationDays = Number(state.durationDays);
  if (!Number.isInteger(durationDays) || durationDays < 0 || durationDays > MAX_DURATION_DAYS) {
    return { problem: 'web.product_problem_duration' };
  }

  const traffic = state.trafficBytes.trim();
  if (!/^\d{1,19}$/u.test(traffic)) return { problem: 'web.product_problem_traffic' };

  const deviceLimit = state.deviceLimit.trim() === '' ? null : Number(state.deviceLimit);
  if (
    deviceLimit !== null &&
    (!Number.isInteger(deviceLimit) || deviceLimit < 1 || deviceLimit > MAX_DEVICE_LIMIT)
  ) {
    return { problem: 'web.product_problem_devices' };
  }

  /*
   * An empty price is ABSENT, not zero.
   *
   * `catalog.ts` is explicit that free is not a concept here: a product with no price is
   * unsellable, and `products_price_positive_check` refuses a zero outright. So the box
   * being empty means "not for sale yet" and the operator is told the difference by the
   * catalogue badge on the row, not by a zero that looks like a giveaway.
   */
  const amount = state.priceAmount.trim();
  if (amount !== '' && (!/^\d{1,19}$/u.test(amount) || BigInt(amount) <= 0n)) {
    return { problem: 'web.product_problem_price' };
  }

  return {
    body: {
      title,
      description: state.description.trim() === '' ? null : state.description.trim(),
      audience: state.audience,
      sortOrder,
      panelId: state.panelId.trim() === '' ? null : state.panelId.trim(),
      durationDays,
      trafficBytes: traffic,
      deviceLimit,
      priceAmount: amount === '' ? null : amount,
      // The pair moves together. An amount with no currency is the shape the schema,
      // the service and a CHECK constraint each refuse.
      priceCurrency: amount === '' ? null : state.priceCurrency,
    },
  };
}

function ProductForm({
  mode,
  product,
}: {
  mode: 'create' | 'edit';
  product?: ProductSummaryResponse;
}) {
  const notify = useToast();
  const queries = useQueryClient();
  const submission = useSubmissionKey();
  const [state, setState] = useState<FormState>(product === undefined ? BLANK : stateOf(product));
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setState((current) => ({ ...current, [key]: value }));

  /*
   * The panel list, for a select rather than a typed uuid.
   *
   * `panels.view` is a SEPARATE permission from `catalog.edit`, so an operator may
   * legitimately hold the second and not the first. When this query cannot answer, the
   * field falls back to a text input and says why — rather than rendering an empty
   * select, which would read as "this tenant has no panels".
   */
  const panels = useQuery({ queryKey: ['panels', 'for-product'], queryFn: () => fetchPanels({}) });
  const panelOptions = panels.data?.panels ?? [];
  const panelsReadable = queryState(panels) === 'ready';

  const checked = bodyFrom(state);
  const problem = 'problem' in checked ? checked.problem : null;

  const mutate = useMutation({
    mutationFn: () => {
      if ('problem' in checked) throw new Error('unreachable: guarded by the submit button');
      // The payload is the fingerprint the held key is bound to, so an edited field and
      // a second press is a NEW command rather than a replay the store would refuse.
      const idempotencyKey = submission.current({ mode, id: product?.id ?? null, ...checked.body });
      return mode === 'create'
        ? createProduct({ ...checked.body, idempotencyKey })
        : updateProduct({ ...checked.body, id: product?.id ?? '', idempotencyKey });
    },
    onSuccess: (response) => {
      submission.settle();
      notify({
        tone: 'ok',
        message: mode === 'create' ? t('web.product_created') : t('web.product_saved'),
      });
      if (mode === 'create') setState(BLANK);
      queries.setQueryData(['product', response.product.id], response);
      void queries.invalidateQueries({ queryKey: ['products'] });
    },
    // A 4xx is an answer and the next press is a new question; a 5xx or a dropped
    // connection is not, because the write may have committed.
    onError: (error) => submission.settleOn(error),
  });

  return (
    <Card title={mode === 'create' ? t('web.product_new_title') : t('web.product_edit_title')}>
      <Field label={t('web.product_title')} htmlFor={`product-title-${mode}`}>
        <input
          id={`product-title-${mode}`}
          value={state.title}
          maxLength={PRODUCT_TITLE_MAX_LENGTH}
          onChange={(event) => set('title', event.target.value)}
        />
      </Field>

      <Field
        label={t('web.product_description')}
        hint={t('web.product_description_hint')}
        htmlFor={`product-description-${mode}`}
      >
        <textarea
          id={`product-description-${mode}`}
          rows={2}
          value={state.description}
          maxLength={PRODUCT_DESCRIPTION_MAX_LENGTH}
          onChange={(event) => set('description', event.target.value)}
        />
      </Field>

      <Field
        label={t('web.product_audience')}
        hint={t('web.product_audience_hint')}
        htmlFor={`product-audience-${mode}`}
      >
        <select
          id={`product-audience-${mode}`}
          value={state.audience}
          onChange={(event) => set('audience', event.target.value as ProductAudience)}
        >
          <option value="EVERYONE">{t('web.product_audience_everyone')}</option>
          <option value="RESELLERS_ONLY">{t('web.product_audience_resellers')}</option>
          <option value="HIDDEN">{t('web.product_audience_hidden')}</option>
        </select>
      </Field>

      <Field
        label={t('web.product_panel')}
        hint={panelsReadable ? t('web.product_panel_hint') : t('web.product_panel_denied')}
        htmlFor={`product-panel-${mode}`}
      >
        {panelsReadable ? (
          <select
            id={`product-panel-${mode}`}
            value={state.panelId}
            onChange={(event) => set('panelId', event.target.value)}
          >
            <option value="">{t('web.product_panel_none')}</option>
            {panelOptions.map((panel) => (
              <option key={panel.id} value={panel.id}>
                {panel.name}
              </option>
            ))}
          </select>
        ) : (
          <input
            id={`product-panel-${mode}`}
            dir="ltr"
            value={state.panelId}
            onChange={(event) => set('panelId', event.target.value.trim())}
          />
        )}
      </Field>

      <Field
        label={t('web.product_duration')}
        hint={t('web.product_duration_hint')}
        htmlFor={`product-duration-${mode}`}
      >
        <input
          id={`product-duration-${mode}`}
          dir="ltr"
          inputMode="numeric"
          value={state.durationDays}
          onChange={(event) => set('durationDays', event.target.value.trim())}
        />
      </Field>

      <Field
        label={t('web.product_traffic_bytes')}
        hint={t('web.product_traffic_hint')}
        htmlFor={`product-traffic-${mode}`}
      >
        <input
          id={`product-traffic-${mode}`}
          dir="ltr"
          inputMode="numeric"
          value={state.trafficBytes}
          onChange={(event) => set('trafficBytes', event.target.value.trim())}
        />
      </Field>

      <Field
        label={t('web.product_device_limit')}
        hint={t('web.product_device_limit_hint')}
        htmlFor={`product-devices-${mode}`}
      >
        <input
          id={`product-devices-${mode}`}
          dir="ltr"
          inputMode="numeric"
          value={state.deviceLimit}
          onChange={(event) => set('deviceLimit', event.target.value.trim())}
        />
      </Field>

      <Field
        label={t('web.product_price')}
        hint={t('web.product_price_hint')}
        htmlFor={`product-price-${mode}`}
      >
        <input
          id={`product-price-${mode}`}
          dir="ltr"
          inputMode="numeric"
          value={state.priceAmount}
          onChange={(event) => set('priceAmount', event.target.value.trim())}
        />
      </Field>

      <Field label={t('web.product_currency')} htmlFor={`product-currency-${mode}`}>
        <select
          id={`product-currency-${mode}`}
          value={state.priceCurrency}
          onChange={(event) => set('priceCurrency', event.target.value as CurrencyCode)}
        >
          {CURRENCY_CODES.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label={t('web.product_sort_order')}
        hint={t('web.product_sort_hint')}
        htmlFor={`product-sort-${mode}`}
      >
        <input
          id={`product-sort-${mode}`}
          dir="ltr"
          inputMode="numeric"
          value={state.sortOrder}
          onChange={(event) => set('sortOrder', event.target.value.trim())}
        />
      </Field>

      {problem !== null && <Banner tone="warn">{t(problem)}</Banner>}

      <div className="toolbar">
        <button
          type="button"
          className="btn primary sm"
          disabled={problem !== null || mutate.isPending}
          onClick={() => mutate.mutate()}
        >
          {mode === 'create' ? t('web.product_create') : t('web.product_save')}
        </button>
      </div>

      {mode === 'create' && (
        // Stated where the button is, because it is the one thing about this form that
        // surprises: creating a product does NOT publish it.
        <p className="muted small">{t('web.product_created_inactive')}</p>
      )}

      {mutate.error !== null && <Banner tone="danger">{messageFor(mutate.error)}</Banner>}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export function ProductDetailPage({
  id,
  mayEdit,
  denied,
}: {
  id: string;
  mayEdit: boolean;
  denied: boolean;
}) {
  const notify = useToast();
  const queries = useQueryClient();
  const submission = useSubmissionKey();

  const product = useQuery({
    queryKey: ['product', id],
    queryFn: () => fetchProduct(id),
    enabled: !denied,
  });
  const row = product.data?.product;

  const status = useMutation({
    mutationFn: (to: ProductStatus) => {
      const idempotencyKey = submission.current({ id, to });
      return to === 'ACTIVE'
        ? activateProduct({ id, idempotencyKey })
        : deactivateProduct({ id, idempotencyKey });
    },
    onSuccess: (response, to) => {
      submission.settle();
      notify({
        tone: 'ok',
        message: to === 'ACTIVE' ? t('web.product_activated') : t('web.product_deactivated'),
      });
      queries.setQueryData(['product', id], response);
      void queries.invalidateQueries({ queryKey: ['products'] });
    },
    onError: (error) => submission.settleOn(error),
  });

  const gap = row === undefined ? null : catalogueGap(row);

  return (
    <>
      <PageHead
        title={t('web.product_detail')}
        {...(row === undefined ? {} : { subtitle: row.title })}
        maturity="now"
      />

      <StateSwitch query={product} denied={denied}>
        {row === undefined ? null : (
          <>
            {gap !== null && (
              /*
               * Why a customer cannot see this, said once and plainly.
               *
               * The legacy system has no equivalent: an operator publishes a plan, sees
               * it in their own list, and finds out it was invisible when nobody buys
               * it. `UNLISTED` is INFO rather than a warning — a hidden product is
               * hidden on purpose and is still orderable by link.
               */
              <Banner
                tone={gap === 'UNLISTED' ? 'info' : 'warn'}
                title={t('web.product_gap_banner_title')}
              >
                {t(GAP_LABELS[gap])}
              </Banner>
            )}

            <Card title={t('web.product_identity_title')}>
              <KV
                items={[
                  [t('web.product_title'), row.title],
                  [t('web.product_description'), row.description ?? <Dash key="d" />],
                  [
                    t('web.status'),
                    <Badge key="s" tone={STATUS_TONES[row.status]}>
                      {t(STATUS_LABELS[row.status])}
                    </Badge>,
                  ],
                  [t('web.product_catalogue'), <CatalogueBadge key="c" row={row} />],
                  [t('web.product_audience'), t(AUDIENCE_LABELS[row.audience])],
                  [t('web.product_price'), <Price key="p" row={row} />],
                  [t('web.product_duration'), <Duration key="dur" days={row.durationDays} />],
                  [t('web.product_traffic'), <Traffic key="tr" bytes={row.trafficBytes} />],
                  [
                    t('web.product_device_limit'),
                    row.deviceLimit === null ? (
                      <span key="dl">{t('web.product_devices_provider_default')}</span>
                    ) : (
                      <Ltr key="dl">{formatNumber(row.deviceLimit)}</Ltr>
                    ),
                  ],
                  [t('web.product_sort_order'), <Ltr key="so">{formatNumber(row.sortOrder)}</Ltr>],
                  [
                    t('web.product_panel'),
                    row.panelId === null ? (
                      <Dash key="pa" />
                    ) : (
                      <Copyable key="pa" value={row.panelId} />
                    ),
                  ],
                  [t('web.product_created_at'), formatTimestamp(row.createdAt)],
                  [t('web.updated_at'), formatTimestamp(row.updatedAt)],
                ]}
              />
            </Card>

            {mayEdit ? (
              <>
                <Card title={t('web.product_status_title')} hint={t('web.product_status_hint')}>
                  <div className="toolbar">
                    {row.status === 'INACTIVE' ? (
                      <button
                        type="button"
                        className="btn primary sm"
                        disabled={status.isPending}
                        onClick={() => status.mutate('ACTIVE')}
                      >
                        {t('web.product_activate')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn danger sm"
                        disabled={status.isPending}
                        onClick={() => status.mutate('INACTIVE')}
                      >
                        {t('web.product_deactivate')}
                      </button>
                    )}
                  </div>
                  {/* The sentence that stops a withdrawal being feared: it changes what
                      can be bought NEXT and nothing about what was bought. */}
                  <p className="muted small">{t('web.product_deactivate_note')}</p>
                  {status.error !== null && (
                    <Banner tone="danger">{messageFor(status.error)}</Banner>
                  )}
                </Card>

                {/* KEYED BY THE PRODUCT ID: React reconciles by position and type, so
                    navigating between two product URLs would keep one instance mounted
                    and every `useState` initialiser would hold the previous product's
                    values — which here are the fields about to be written. */}
                <ProductForm key={row.id} mode="edit" product={row} />
              </>
            ) : (
              <Card title={t('web.product_edit_title')}>
                <Banner tone="info">{t('web.product_edit_denied')}</Banner>
              </Card>
            )}
          </>
        )}
      </StateSwitch>
    </>
  );
}
