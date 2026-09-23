import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PANEL_PAGE_MAX,
  SALES_CURRENCY_CODES,
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
  type ProductCategoryListingResponse,
  type ProductStatus,
  type ProductSummaryResponse,
} from '@nexa/contracts';
import {
  activateProduct,
  createProduct,
  assignProductCategory,
  deactivateProduct,
  fetchProductCategories,
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
 * There is no pricing-rule or discount control on this page. Categories have their own
 * page and discounts and cashback have `/discounts` (WP8); a price here is the LIST price
 * those rules are applied on top of, and nothing on this form edits them.
 */

export const STATUS_LABELS: Readonly<Record<ProductStatus, WebKey>> = {
  ACTIVE: 'web.product_status_active',
  INACTIVE: 'web.product_status_inactive',
};

export const STATUS_TONES: Readonly<Record<ProductStatus, Tone>> = {
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
export type CatalogueGap =
  | 'INACTIVE'
  | 'UNLISTED'
  | 'RESELLERS'
  | 'UNPRICED'
  | 'NO_PANEL'
  | 'UNCATEGORISED'
  | 'CATEGORY_INACTIVE'
  | 'CATEGORY_HIDDEN'
  | 'CATEGORY_UNKNOWN';

/**
 * The two facts about a product's category the badge needs, or `UNKNOWN` when the
 * category list has not answered — still loading, refused, or the id is not in it.
 *
 * A REQUIRED argument, so no caller can forget the category and fall back to a green
 * "in catalogue" for a product the server will not sell. That is exactly what the first
 * version did: it read the product's own four predicates, so an uncategorised product
 * showed an "uncategorised" warning in one column and "in catalogue" in the next. Found
 * by the Codex review of this branch.
 */
export type CategoryFacts =
  | {
      readonly status: ProductCategoryListingResponse['status'];
      readonly visibility: ProductCategoryListingResponse['visibility'];
    }
  | 'UNKNOWN';

export function catalogueGap(
  row: ProductSummaryResponse,
  category: CategoryFacts,
): CatalogueGap | null {
  if (row.status !== 'ACTIVE') return 'INACTIVE';
  if (row.audience === 'HIDDEN') return 'UNLISTED';
  if (row.audience === 'RESELLERS_ONLY') return 'RESELLERS';
  if (row.priceAmount === null) return 'UNPRICED';
  if (row.panelId === null) return 'NO_PANEL';
  /*
   * The category, in the order the server refuses: none at all is refused at checkout
   * (`PRODUCT_NOT_CATEGORISED`), an INACTIVE one is refused even by direct reference, and
   * a HIDDEN one is unlisted but still orderable — the same standing a HIDDEN audience
   * has, and the same amber. An answer we could not read is said, not guessed.
   */
  if (row.categoryId === null) return 'UNCATEGORISED';
  if (category === 'UNKNOWN') return 'CATEGORY_UNKNOWN';
  if (category.status !== 'ACTIVE') return 'CATEGORY_INACTIVE';
  if (category.visibility !== 'VISIBLE') return 'CATEGORY_HIDDEN';
  return null;
}

/** The facts for one product, from the category list the page already holds. */
function categoryFactsFor(
  row: ProductSummaryResponse,
  categories: readonly ProductCategoryListingResponse[] | undefined,
): CategoryFacts {
  const found = categories?.find((category) => category.id === row.categoryId);
  return found === undefined ? 'UNKNOWN' : { status: found.status, visibility: found.visibility };
}

/** Orderable by anybody holding the reference, just not listed: amber, not red. */
function isUnlistedGap(gap: CatalogueGap): boolean {
  return gap === 'UNLISTED' || gap === 'CATEGORY_HIDDEN';
}

const GAP_LABELS: Readonly<Record<CatalogueGap, WebKey>> = {
  INACTIVE: 'web.product_gap_inactive',
  UNLISTED: 'web.product_gap_unlisted',
  RESELLERS: 'web.product_gap_resellers',
  UNPRICED: 'web.product_gap_unpriced',
  NO_PANEL: 'web.product_gap_no_panel',
  UNCATEGORISED: 'web.product_gap_uncategorised',
  CATEGORY_INACTIVE: 'web.product_gap_category_inactive',
  CATEGORY_HIDDEN: 'web.product_gap_category_hidden',
  CATEGORY_UNKNOWN: 'web.product_gap_category_unknown',
};

function CatalogueBadge({
  row,
  category,
}: {
  row: ProductSummaryResponse;
  category: CategoryFacts;
}) {
  const gap = catalogueGap(row, category);
  if (gap === null) return <Badge tone="ok">{t('web.product_in_catalogue')}</Badge>;
  // `UNLISTED` is amber and not red: a HIDDEN product is still ORDERABLE by anybody
  // holding its link, which is what the audience means — and a HIDDEN category means
  // the same. The others are configuration — `RESELLERS` included, because that one is
  // not orderable at all in this phase.
  return <Badge tone={isUnlistedGap(gap) ? 'warn' : 'neutral'}>{t(GAP_LABELS[gap])}</Badge>;
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
   * The category filter, and `'none'` is one of its values.
   *
   * A bare id could not express "the products with NO category", which is the filter
   * that matters most here: such a product is refused at checkout by
   * `PRODUCT_NOT_CATEGORISED`, so this is the list of plans that cannot be sold until
   * somebody files them. The server validates the same union.
   */
  const appliedCategory = route.query.get('categoryId') ?? '';

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
  const searchSignature = [
    appliedStatus ?? '',
    appliedAudience ?? '',
    // Before the title, which must stay last: a category id cannot contain `|`, and the
    // title can contain anything.
    appliedCategory,
    appliedTitle,
  ].join('|');
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
        ...(appliedCategory === '' ? {} : { categoryId: appliedCategory }),
      }),
    enabled: !denied,
  });

  /*
   * The categories, loaded for NAMES and for the filter.
   *
   * The product summary carries `categoryId` and not the name, deliberately: a name
   * copied onto every product row is a second copy that goes stale the moment a
   * category is renamed. The join happens here, where one list answers every row.
   *
   * A product whose id is not in this list renders as unknown rather than blank —
   * which is what a category deleted between the two reads looks like, and saying so
   * is better than an empty cell that reads as "uncategorised".
   */
  const categories = useQuery({
    queryKey: ['product-categories'],
    queryFn: () => fetchProductCategories(),
    enabled: !denied,
  });
  const categoryNames = new Map(
    (categories.data?.categories ?? []).map((category) => [
      category.id,
      category.emoji === null ? category.name : `${category.emoji} ${category.name}`,
    ]),
  );

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
      render: (row) => (
        <CatalogueBadge row={row} category={categoryFactsFor(row, categories.data?.categories)} />
      ),
    },
    {
      key: 'category',
      header: t('web.product_category'),
      render: (row) => {
        // Null is UNCATEGORISED and is SHOWN, because such a product is refused at
        // checkout — hiding the absence would hide the reason a plan cannot be sold.
        if (row.categoryId === null) {
          return <Badge tone="warn">{t('web.product_category_unset')}</Badge>;
        }
        const name = categoryNames.get(row.categoryId);
        return name === undefined ? <Dash /> : <span>{name}</span>;
      },
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
            {/*
              Categories as pills rather than a select, matching the two filters beside
              it. `none` is offered explicitly because it is the operator's most useful
              view — the plans that cannot be sold yet.
            */}
            <Pills
              value={appliedCategory === '' ? 'ALL' : appliedCategory}
              onChange={(next) => setQuery(route, 'categoryId', next === 'ALL' ? null : next)}
              items={[
                { id: 'ALL', label: t('web.category_filter_all') },
                { id: 'none', label: t('web.category_filter_none') },
                ...(categories.data?.categories ?? []).map((category) => ({
                  id: category.id,
                  label: category.name,
                })),
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
  /** The category id, or empty for none. See the field's own comment in `ProductForm`. */
  categoryId: string;
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
  categoryId: '',
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
    categoryId: row.categoryId ?? '',
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
      /*
       * ALWAYS sent, and `null` when none is chosen. The contract requires the field and
       * permits the value to be empty; this form omitted it, so every create and every
       * edit from the Web Admin was refused with a 400 before reaching the service.
       * Found by the Codex review of this branch. An edit that left it out would also
       * have been an edit that could never keep a category, since the write replaces the
       * whole product.
       */
      categoryId: state.categoryId.trim() === '' ? null : state.categoryId.trim(),
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
  const panels = useQuery({
    queryKey: ['panels', 'for-product'],
    // `PANEL_PAGE_MAX`, not the endpoint's default of 50. This picker does not page —
    // it ignored `nextCursor` and a successful first page switched the field to a
    // select, so a tenant's fifty-first panel simply could not be chosen. Found by the
    // Codex review of this branch.
    queryFn: () => fetchPanels({ limit: PANEL_PAGE_MAX }),
  });
  const panelOptions = panels.data?.panels ?? [];
  /*
   * A select ONLY when the list is complete.
   *
   * Raising the limit moves the cliff from 50 to 200; it does not remove it, and a
   * select that silently omits a panel is worse than a box asking for an id, because
   * nothing on screen says a choice is missing. So a `nextCursor` means there are more
   * than this page holds, and the field falls back to the same free-text input an
   * operator without `panels.view` gets — with its own sentence, so the two cases are
   * not confused. `no silent caps` is the rule this obeys.
   */
  const panelsComplete = (panels.data?.nextCursor ?? null) === null;
  const panelsReadable = queryState(panels) === 'ready' && panelsComplete;

  /*
   * The categories, for a select — the same list and the same cache key the product list
   * and the detail page read, so a category created a moment ago is here too.
   *
   * The whole list: `/product-categories` is not paged, which is what makes a select
   * complete rather than a first page of one. When it cannot answer, the field falls back
   * to a typed id and says so, for the reason the panel field does.
   */
  const categories = useQuery({
    queryKey: ['product-categories'],
    queryFn: () => fetchProductCategories(),
  });
  const categoriesReadable = queryState(categories) === 'ready';

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
        hint={
          panelsReadable
            ? t('web.product_panel_hint')
            : queryState(panels) === 'ready'
              ? t('web.product_panel_too_many')
              : t('web.product_panel_denied')
        }
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
        label={t('web.product_category')}
        hint={
          categoriesReadable ? t('web.product_category_hint') : t('web.product_category_unreadable')
        }
        htmlFor={`product-category-${mode}`}
      >
        {categoriesReadable ? (
          <select
            id={`product-category-${mode}`}
            value={state.categoryId}
            onChange={(event) => set('categoryId', event.target.value)}
          >
            {/*
              "None" is a choice and stays on the list: an operator may stage a product
              before filing it. It is not a silent default — the catalogue badge on the
              row names what it costs.
            */}
            <option value="">{t('web.product_category_unset')}</option>
            {(categories.data?.categories ?? []).map((category) => (
              <option key={category.id} value={category.id}>
                {category.emoji === null ? category.name : `${category.emoji} ${category.name}`}
              </option>
            ))}
          </select>
        ) : (
          <input
            id={`product-category-${mode}`}
            dir="ltr"
            value={state.categoryId}
            onChange={(event) => set('categoryId', event.target.value.trim())}
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

      {/*
        `SALES_CURRENCY_CODES`, NOT the whole money catalogue.

        This offered all five until the Codex review of this branch, three of which no
        store can sell in: USD, EUR and USDT exist in `CURRENCY_CODES` because a
        CONVERTED payment quote will need them, which is a different question from what
        a shop prices in. Offering them made a refusal the only way to discover they
        were not real options. The hint names the setting that decides which of the two
        is right, because that is where an operator changes it.
      */}
      <Field
        label={t('web.product_currency')}
        hint={t('web.product_currency_hint')}
        htmlFor={`product-currency-${mode}`}
      >
        <select
          id={`product-currency-${mode}`}
          value={state.priceCurrency}
          onChange={(event) => set('priceCurrency', event.target.value as CurrencyCode)}
        >
          {SALES_CURRENCY_CODES.map((code) => (
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

  /*
   * The categories, for the name this product is filed under and for the move control.
   *
   * Loaded here rather than joined on the server, for the reason the list page states:
   * the product carries the id and not the name, so one read answers both questions
   * without a copy of the name that can go stale.
   */
  const categories = useQuery({
    queryKey: ['product-categories'],
    queryFn: () => fetchProductCategories(),
    enabled: !denied,
  });
  const categoryList = categories.data?.categories ?? [];

  /** The id the select is showing. Follows the product until the operator changes it. */
  const [moveTo, setMoveTo] = useState<string>('');
  const chosen = moveTo === '' ? (row?.categoryId ?? '') : moveTo;

  const assign = useMutation({
    mutationFn: (categoryId: string) =>
      assignProductCategory({
        categoryId,
        productId: id,
        idempotencyKey: submission.current({ assign: id, categoryId }),
      }),
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.product_category_assigned') });
      setMoveTo('');
      void queries.invalidateQueries({ queryKey: ['product', id] });
      void queries.invalidateQueries({ queryKey: ['products'] });
      // The counts on the category screen moved, in two categories at once.
      void queries.invalidateQueries({ queryKey: ['product-categories'] });
    },
    onError: (error) => submission.settleOn(error),
  });

  const facts = row === undefined ? 'UNKNOWN' : categoryFactsFor(row, categories.data?.categories);
  const gap = row === undefined ? null : catalogueGap(row, facts);

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
                tone={isUnlistedGap(gap) ? 'info' : 'warn'}
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
                  [
                    t('web.product_catalogue'),
                    <CatalogueBadge key="c" row={row} category={facts} />,
                  ],
                  [
                    t('web.product_category'),
                    // Absence is shown as a warning rather than a dash: an uncategorised
                    // product is refused at checkout, which is a state an operator has
                    // to act on rather than merely notice.
                    row.categoryId === null ? (
                      <Badge key="cat" tone="warn">
                        {t('web.product_category_unset')}
                      </Badge>
                    ) : (
                      (categoryList.find((c) => c.id === row.categoryId)?.name ?? (
                        <Dash key="cat" />
                      ))
                    ),
                  ],
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
                {/*
                  Moving a product between categories, on its OWN card.
                  A reassignment is not an edit of the product's properties: it writes a
                  different column, takes the destination category's row lock, and leaves
                  an audit row naming where it moved FROM. Folding it into the edit form
                  would make "who moved this plan" answerable only by diffing payloads —
                  the defect `payment-accounts.tsx` records from the other end.
                */}
                <Card
                  title={t('web.product_category_assign')}
                  hint={t('web.product_category_assign_hint')}
                >
                  <Field label={t('web.product_category')} htmlFor="pd-category">
                    <select
                      id="pd-category"
                      value={chosen}
                      onChange={(event) => setMoveTo(event.target.value)}
                    >
                      {/*
                        No blank option. Every sellable product belongs to exactly one
                        category, so "move to nothing" is not an operation this offers —
                        the product would become unsellable and nothing would say why.
                      */}
                      {row.categoryId === null && (
                        <option value="">{t('web.product_category_unset')}</option>
                      )}
                      {categoryList.map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <div className="toolbar">
                    <button
                      type="button"
                      className="btn primary sm"
                      disabled={assign.isPending || chosen === '' || chosen === row.categoryId}
                      onClick={() => assign.mutate(chosen)}
                    >
                      {t('web.product_category_assign')}
                    </button>
                  </div>
                  {assign.error != null && (
                    <Banner tone="danger">{messageFor(assign.error)}</Banner>
                  )}
                </Card>

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
