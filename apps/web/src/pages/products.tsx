import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PANEL_PAGE_MAX,
  SALES_CURRENCY_CODES,
  MAX_DEVICE_LIMIT,
  MAX_DURATION_DAYS,
  MAX_TRAFFIC_BYTES,
  PRODUCT_DESCRIPTION_MAX_LENGTH,
  PRODUCT_DISPLAY_FEATURE_MAX_LENGTH,
  PRODUCT_DISPLAY_LIST_MAX_ITEMS,
  PRODUCT_DISPLAY_LOCATION_MAX_LENGTH,
  PRODUCT_SERVICE_LOCATION_LABEL_MAX_LENGTH,
  PRODUCT_SORT_MAX,
  PRODUCT_SORT_MIN,
  PRODUCT_TITLE_MAX_LENGTH,
  UNLIMITED_DURATION_DAYS,
  UNLIMITED_TRAFFIC_BYTES,
  formatTrafficGb,
  parseTrafficGb,
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
import { formatNumber, formatTimestamp, formatTrafficGbText } from '../format';
import { useSubmissionKey } from '../submission-key';
import { mayRequest, queryState } from '../view-state';
import { t, type WebKey } from '../i18n/web.fa';
import { setQuery, useLinkHandler, type Route } from '../router';
import { messageFor } from './settings';
import {
  Badge,
  Banner,
  Button,
  Card,
  CellMain,
  ChipDivider,
  Copyable,
  CursorPager,
  DataTable,
  Empty,
  Field,
  FilterChip,
  FilterChips,
  KV,
  ListEditor,
  Ltr,
  Money,
  PageHead,
  StateSwitch,
  useToast,
  useUnsavedChanges,
  type Column,
  type Tone,
  Num,
} from '../ui/kit';
import { Icon } from '../ui/icons';
import { listRouteKey, useDebouncedApply } from '../ui/list-search';
import { FormSection, SaveBar, SectionNav, revealField } from './editor-layout';

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
 * RESELLERS_ONLY product, which an ordinary customer can neither see nor order by any
 * reference; since WP9-B it is listed and sold to a reseller whose tier grants it, and to
 * nobody else (`catalog-visibility.ts`, `docs/wp9-reseller-audit.md` R5). Collapsing them
 * would tell an operator their reseller product merely needs a link passed around, and it
 * does not.
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
  // the same. The others are configuration — `RESELLERS` included, because what makes
  // that one sellable is a reseller tier's grants, not a link.
  //
  // A sentence, not a badge: it says WHICH condition fails, and a badge that holds a
  // sentence would not wrap — it pushed every column after it off a dense list.
  return (
    <span className={`products-gap ${isUnlistedGap(gap) ? 'warn' : 'neutral'}`}>
      <i className="dot" aria-hidden="true" />
      <span>{t(GAP_LABELS[gap])}</span>
    </span>
  );
}

function Dash() {
  return <span className="faint">—</span>;
}

/** An ordered display list, numbered as the pre-invoice orders it; a dash when empty. */
function DisplayList({ lines }: { lines: readonly string[] }) {
  if (lines.length === 0) return <Dash />;
  return (
    <ol className="display-list">
      {lines.map((line, index) => (
        // Position IS the identity of a line in an ordered list; two equal lines are
        // two entries, and the operator sees them as such.
        <li key={`${String(index)}:${line}`}>{line}</li>
      ))}
    </ol>
  );
}

/** A traffic allowance, or the word for "no limit". Zero is a sentinel, not a quantity. */
function Traffic({ bytes }: { bytes: string }) {
  const value = BigInt(bytes);
  if (value === UNLIMITED_TRAFFIC_BYTES) return <span>{t('web.product_unlimited')}</span>;
  return (
    <span className="nowrap">
      <Num value={formatTrafficGbText(value)} /> {t('web.unit_gib')}
    </span>
  );
}

/** Days of validity, or the word for "no limit". Same sentinel rule. */
function Duration({ days }: { days: number }) {
  if (days === UNLIMITED_DURATION_DAYS) return <span>{t('web.product_unlimited')}</span>;
  return (
    <span className="nowrap">
      <Num value={days} /> {t('web.product_days_unit')}
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

  /*
   * FIX-01: typing or pasting searches by itself, debounced, as on /users. The automatic
   * apply sends the trimmed title and records it as the draft's own signature, so the URL
   * catching up does not reset the box under the caret (`ListSearchBox` records why).
   * The cursor trail is keyed by the title, so a new title starts at the first page.
   */
  const wantedTitle = draftTitle.trim();
  const debounce = useDebouncedApply({
    wanted: wantedTitle,
    applied: appliedTitle,
    routeKey: listRouteKey(route),
    ready: mayRequest(products, denied),
    apply: () => {
      setDraft({ signature: wantedTitle, title: draftTitle });
      setQuery(route, 'title', wantedTitle === '' ? null : wantedTitle);
    },
  });

  const columns: readonly Column<ProductSummaryResponse>[] = [
    {
      key: 'title',
      header: t('web.product_title'),
      render: (row) => {
        // The category rides under the title, as the reference lists a plan. Null is
        // UNCATEGORISED and is SHOWN, because such a product is refused at checkout —
        // hiding the absence would hide the reason a plan cannot be sold.
        const name = row.categoryId === null ? undefined : categoryNames.get(row.categoryId);
        return (
          <CellMain
            primary={
              <a
                href={`/products/${encodeURIComponent(row.id)}`}
                onClick={onLink}
                className="strong"
              >
                {row.title}
              </a>
            }
            secondary={
              row.categoryId === null ? (
                <Badge tone="warn">{t('web.product_category_unset')}</Badge>
              ) : name === undefined ? (
                <Dash />
              ) : (
                <span>{name}</span>
              )
            }
          />
        );
      },
    },
    {
      key: 'status',
      header: t('web.status'),
      render: (row) => (
        <Badge tone={STATUS_TONES[row.status]} dot>
          {t(STATUS_LABELS[row.status])}
        </Badge>
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
      key: 'audience',
      header: t('web.product_audience'),
      render: (row) => <span className="muted">{t(AUDIENCE_LABELS[row.audience])}</span>,
    },
    {
      key: 'specs',
      header: t('web.cb_section_volume'),
      render: (row) => (
        <span className="cb-specs">
          <Duration days={row.durationDays} />
          <span className="faint" aria-hidden="true">
            ·
          </span>
          <Traffic bytes={row.trafficBytes} />
        </span>
      ),
    },
    {
      key: 'price',
      header: t('web.product_price'),
      align: 'end',
      render: (row) => <Price row={row} />,
    },
    {
      key: 'sort',
      header: t('web.product_sort_order'),
      align: 'end',
      render: (row) => <Num value={row.sortOrder} />,
    },
  ];

  return (
    <>
      <PageHead
        title={t('web.products_title')}
        subtitle={t('web.products_intro')}
        actions={
          <>
            <a className="btn" href="/product-categories" onClick={onLink}>
              <Icon name="folder" />
              {t('web.nav_product_categories')}
            </a>
            {mayEdit && (
              <Button
                variant="primary"
                icon="plus"
                onClick={() => revealField('product-title-create')}
              >
                {t('web.cb_product_new')}
              </Button>
            )}
          </>
        }
      />

      <Card>
        {/* Hidden while the card below cannot answer: a control that mints a new query
            key is a fresh request against a question the server has just refused. */}
        <div className="cb-filters" hidden={!mayRequest(products, denied)}>
          <form className="toolbar" onSubmit={apply}>
            <div className="search cb-search">
              <label className="visually-hidden" htmlFor="products-title">
                {t('web.products_search_title')}
              </label>
              <Icon name="search" size={14} />
              <input
                id="products-title"
                className="input"
                type="search"
                value={draftTitle}
                maxLength={PRODUCT_TITLE_MAX_LENGTH}
                placeholder={t('web.products_search_title_hint')}
                onChange={(event) => {
                  setDraft({ signature: appliedTitle, title: event.target.value });
                  debounce.edited();
                }}
                {...debounce.composition}
              />
            </div>
            <button type="submit" className="btn primary sm">
              {t('web.users_search_apply')}
            </button>
            <button
              type="button"
              className="btn sm ghost"
              disabled={!clearable}
              onClick={() => {
                setDraft({ signature: appliedTitle, title: '' });
                setQuery(route, 'title', null);
              }}
            >
              {t('web.users_search_clear')}
            </button>
          </form>

          <FilterChips label={t('web.status')}>
            {(
              [
                ['ALL', 'web.users_filter_all'],
                ['ACTIVE', 'web.product_status_active'],
                ['INACTIVE', 'web.product_status_inactive'],
              ] as const
            ).map(([id, label]) => (
              <FilterChip
                key={id}
                pressed={(appliedStatus ?? 'ALL') === id}
                onClick={() => setQuery(route, 'status', id === 'ALL' ? null : id)}
              >
                {t(label)}
              </FilterChip>
            ))}
            <ChipDivider />
            {(
              [
                ['ALL', 'web.product_audience_all'],
                ['EVERYONE', 'web.product_audience_everyone'],
                ['RESELLERS_ONLY', 'web.product_audience_resellers'],
                ['HIDDEN', 'web.product_audience_hidden'],
              ] as const
            ).map(([id, label]) => (
              <FilterChip
                key={id}
                pressed={(appliedAudience ?? 'ALL') === id}
                onClick={() => setQuery(route, 'audience', id === 'ALL' ? null : id)}
              >
                {t(label)}
              </FilterChip>
            ))}
          </FilterChips>
          {/*
            Categories as chips on their own row. `none` is offered explicitly because it
            is the operator's most useful view — the plans that cannot be sold yet.
          */}
          <FilterChips label={t('web.product_category')}>
            {[
              { id: 'ALL', label: t('web.category_filter_all') },
              { id: 'none', label: t('web.category_filter_none') },
              ...(categories.data?.categories ?? []).map((category) => ({
                id: category.id,
                label: category.name,
              })),
            ].map((item) => (
              <FilterChip
                key={item.id}
                pressed={(appliedCategory === '' ? 'ALL' : appliedCategory) === item.id}
                onClick={() => setQuery(route, 'categoryId', item.id === 'ALL' ? null : item.id)}
              >
                {item.label}
              </FilterChip>
            ))}
          </FilterChips>
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
            dense
            sticky
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

      <Card title={t('web.products_scope_title')} tone="muted">
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
  /**
   * The allowance in GB as typed, at most two decimals (WP21). The one conversion to
   * bytes is `parseTrafficGb`, the rule the server applies to the same text.
   */
  trafficGb: string;
  /** "No traffic limit", said with its own control rather than with a zero. */
  trafficUnlimited: boolean;
  deviceLimit: string;
  priceAmount: string;
  priceCurrency: CurrencyCode;
  /** The category id, or empty for none. See the field's own comment in `ProductForm`. */
  categoryId: string;
  /**
   * The customer-facing display data (customer UX completion §C), one line per entry,
   * in the order the operator arranged. Marketing copy: the panel field above decides
   * where a purchase lands, and nothing typed here changes that.
   */
  displayLocations: readonly string[];
  displayFeatures: readonly string[];
  serviceLocationLabel: string;
}

const BLANK: FormState = {
  title: '',
  description: '',
  audience: 'EVERYONE',
  sortOrder: '0',
  panelId: '',
  durationDays: '30',
  trafficGb: '',
  trafficUnlimited: true,
  deviceLimit: '',
  priceAmount: '',
  priceCurrency: 'IRT',
  categoryId: '',
  displayLocations: [],
  displayFeatures: [],
  serviceLocationLabel: '',
};

function stateOf(row: ProductSummaryResponse): FormState {
  return {
    title: row.title,
    description: row.description ?? '',
    audience: row.audience,
    sortOrder: String(row.sortOrder),
    panelId: row.panelId ?? '',
    durationDays: String(row.durationDays),
    // A stored allowance reopens as the GB figure it was saved as: 10.25 is `10.25`.
    trafficGb:
      BigInt(row.trafficBytes) === UNLIMITED_TRAFFIC_BYTES
        ? ''
        : formatTrafficGb(BigInt(row.trafficBytes)),
    trafficUnlimited: BigInt(row.trafficBytes) === UNLIMITED_TRAFFIC_BYTES,
    deviceLimit: row.deviceLimit === null ? '' : String(row.deviceLimit),
    priceAmount: row.priceAmount ?? '',
    priceCurrency: row.priceCurrency ?? 'IRT',
    categoryId: row.categoryId ?? '',
    displayLocations: row.displayLocations,
    displayFeatures: row.displayFeatures,
    serviceLocationLabel: row.serviceLocationLabel ?? '',
  };
}

/**
 * A display list as the contract bounds it, or null when a line fails.
 *
 * Each line is TRIMMED and must survive trimming: a row the operator added and left
 * empty is reported rather than silently dropped, because a form that quietly removes
 * a row teaches nobody that it did. No line breaks — each entry renders as one line of
 * a Telegram message — and no more than the list bound, which is what keeps the
 * pre-invoice under the message cap.
 */
function displayListOf(lines: readonly string[], maxLength: number): string[] | null {
  if (lines.length > PRODUCT_DISPLAY_LIST_MAX_ITEMS) return null;
  const trimmed = lines.map((line) => line.trim());
  const valid = trimmed.every(
    (line) => line !== '' && line.length <= maxLength && !/[\r\n]/u.test(line),
  );
  return valid ? trimmed : null;
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

  /*
   * GB, at most two decimals, positive, within the contract's cap — or unlimited, which
   * is its own checkbox. A typed `0` is refused rather than read as unlimited.
   */
  const traffic = state.trafficGb.trim();
  const trafficBytes = state.trafficUnlimited ? null : parseTrafficGb(traffic);
  if (
    !state.trafficUnlimited &&
    (trafficBytes === null || trafficBytes <= 0n || trafficBytes > MAX_TRAFFIC_BYTES)
  ) {
    return { problem: 'web.product_problem_traffic' };
  }

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

  const displayLocations = displayListOf(
    state.displayLocations,
    PRODUCT_DISPLAY_LOCATION_MAX_LENGTH,
  );
  if (displayLocations === null) return { problem: 'web.product_display_problem_locations' };
  const displayFeatures = displayListOf(state.displayFeatures, PRODUCT_DISPLAY_FEATURE_MAX_LENGTH);
  if (displayFeatures === null) return { problem: 'web.product_display_problem_features' };
  const label = state.serviceLocationLabel.trim();
  if (label.length > PRODUCT_SERVICE_LOCATION_LABEL_MAX_LENGTH || /[\r\n]/u.test(label)) {
    return { problem: 'web.product_display_problem_label' };
  }

  return {
    body: {
      title,
      description: state.description.trim() === '' ? null : state.description.trim(),
      audience: state.audience,
      sortOrder,
      panelId: state.panelId.trim() === '' ? null : state.panelId.trim(),
      durationDays,
      trafficGb: state.trafficUnlimited ? null : traffic,
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
      // In the operator's order, which is the order the pre-invoice renders.
      displayLocations,
      displayFeatures,
      // Empty is ABSENT: the schema refuses a blank label, and null is what "no label" is.
      serviceLocationLabel: label === '' ? null : label,
    },
  };
}

type ProblemField =
  | 'title'
  | 'sort'
  | 'duration'
  | 'traffic'
  | 'devices'
  | 'price'
  | 'locations'
  | 'features'
  | 'label';

/** Which field each of `bodyFrom`'s problems belongs to, so it is said there. */
const PROBLEM_FIELDS: Partial<Record<WebKey, ProblemField>> = {
  'web.product_problem_title': 'title',
  'web.product_problem_sort': 'sort',
  'web.product_problem_duration': 'duration',
  'web.product_problem_traffic': 'traffic',
  'web.product_problem_devices': 'devices',
  'web.product_problem_price': 'price',
  'web.product_display_problem_locations': 'locations',
  'web.product_display_problem_features': 'features',
  'web.product_display_problem_label': 'label',
};

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

  /*
   * What the form was loaded with, or last saved as. The difference is what the leave
   * guard protects and what the save bar calls unsaved.
   */
  const [baseline, setBaseline] = useState<FormState>(() =>
    product === undefined ? BLANK : stateOf(product),
  );
  const dirty = JSON.stringify(state) !== JSON.stringify(baseline);
  useUnsavedChanges(dirty);

  /*
   * The problem is shown AT its field. A pristine create form is not an error — its
   * empty title is where the operator starts — so a new form only speaks once touched;
   * an edit form always does, because what it loaded should already be sendable.
   */
  const showProblem = problem !== null && (mode === 'edit' || dirty);
  const problemField = problem === null ? undefined : PROBLEM_FIELDS[problem];
  const errorAt = (field: ProblemField): { error?: string } =>
    showProblem && problem !== null && problemField === field ? { error: t(problem) } : {};

  const mutate = useMutation({
    mutationFn: (_snapshot: FormState) => {
      if ('problem' in checked) throw new Error('unreachable: guarded by the submit button');
      // The payload is the fingerprint the held key is bound to, so an edited field and
      // a second press is a NEW command rather than a replay the store would refuse.
      const idempotencyKey = submission.current({ mode, id: product?.id ?? null, ...checked.body });
      return mode === 'create'
        ? createProduct({ ...checked.body, idempotencyKey })
        : updateProduct({ ...checked.body, id: product?.id ?? '', idempotencyKey });
    },
    onSuccess: (response, snapshot) => {
      submission.settle();
      notify({
        tone: 'ok',
        message: mode === 'create' ? t('web.product_created') : t('web.product_saved'),
      });
      if (mode === 'create') {
        setState(BLANK);
        setBaseline(BLANK);
      } else {
        setBaseline(snapshot);
      }
      queries.setQueryData(['product', response.product.id], response);
      void queries.invalidateQueries({ queryKey: ['products'] });
    },
    // A 4xx is an answer and the next press is a new question; a 5xx or a dropped
    // connection is not, because the write may have committed.
    onError: (error) => submission.settleOn(error),
  });

  return (
    <Card
      className="cb-editor-card"
      title={mode === 'create' ? t('web.product_new_title') : t('web.product_edit_title')}
      tight
      foot={
        <SaveBar dirty={dirty}>
          {/* The one thing about this form that surprises: creating does not publish.
              Said once, beside the button that does it. */}
          {mode === 'create' && (
            <span className="muted small">{t('web.product_created_inactive')}</span>
          )}
          <Button
            variant="primary"
            icon="check"
            disabled={problem !== null || mutate.isPending}
            onClick={() => mutate.mutate(state)}
          >
            {mode === 'create' ? t('web.product_create') : t('web.product_save')}
          </Button>
        </SaveBar>
      }
    >
      <FormSection id={`product-${mode}-basic`} title={t('web.cb_section_basic')}>
        <Field
          label={t('web.product_title')}
          htmlFor={`product-title-${mode}`}
          {...errorAt('title')}
        >
          <input
            id={`product-title-${mode}`}
            value={state.title}
            maxLength={PRODUCT_TITLE_MAX_LENGTH}
            onChange={(event) => set('title', event.target.value)}
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

        <div className="full">
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
        </div>

        <Field
          label={t('web.product_sort_order')}
          hint={t('web.product_sort_hint')}
          htmlFor={`product-sort-${mode}`}
          {...errorAt('sort')}
        >
          <input
            id={`product-sort-${mode}`}
            dir="ltr"
            inputMode="numeric"
            value={state.sortOrder}
            onChange={(event) => set('sortOrder', event.target.value.trim())}
          />
        </Field>
      </FormSection>

      <FormSection id={`product-${mode}-pricing`} title={t('web.cb_section_pricing')}>
        <Field
          label={t('web.product_price')}
          hint={t('web.product_price_hint')}
          htmlFor={`product-price-${mode}`}
          {...errorAt('price')}
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
      </FormSection>

      <FormSection id={`product-${mode}-volume`} title={t('web.cb_section_volume')}>
        <Field
          label={t('web.product_duration')}
          hint={t('web.product_duration_hint')}
          htmlFor={`product-duration-${mode}`}
          {...errorAt('duration')}
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
          label={t('web.product_device_limit')}
          hint={t('web.product_device_limit_hint')}
          htmlFor={`product-devices-${mode}`}
          {...errorAt('devices')}
        >
          <input
            id={`product-devices-${mode}`}
            dir="ltr"
            inputMode="numeric"
            value={state.deviceLimit}
            onChange={(event) => set('deviceLimit', event.target.value.trim())}
          />
        </Field>

        <div className="full">
          <Field
            label={t('web.product_traffic_gb')}
            hint={t('web.product_traffic_hint')}
            htmlFor={`product-traffic-${mode}`}
            {...errorAt('traffic')}
          >
            <div className="cb-inline-controls">
              <label className="check">
                <input
                  type="checkbox"
                  checked={state.trafficUnlimited}
                  onChange={(event) => set('trafficUnlimited', event.target.checked)}
                />{' '}
                {t('web.product_traffic_unlimited')}
              </label>
              <input
                id={`product-traffic-${mode}`}
                dir="ltr"
                inputMode="decimal"
                disabled={state.trafficUnlimited}
                value={state.trafficGb}
                onChange={(event) => set('trafficGb', event.target.value.trim())}
              />
            </div>
          </Field>
        </div>
      </FormSection>

      <FormSection id={`product-${mode}-placement`} title={t('web.cb_section_placement')}>
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
            categoriesReadable
              ? t('web.product_category_hint')
              : t('web.product_category_unreadable')
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
      </FormSection>

      {/*
        The display lists (customer UX completion §C), as ORDERED editors.

        Ordered because the order is data: the pre-invoice renders these lines as the
        operator arranged them, so the editor has to be able to move a row, not only
        add and remove one. `ListEditor` is the same control the support handles and
        channels use, position-keyed for the same reason. Nothing here is routing — the
        panel field above is — and the hint says so where the operator is typing.
      */}
      <FormSection id={`product-${mode}-display`} title={t('web.cb_section_display')}>
        <Field
          label={t('web.product_display_locations')}
          hint={t('web.product_display_locations_hint')}
          {...errorAt('locations')}
        >
          <ListEditor
            items={state.displayLocations}
            onChange={(next) => set('displayLocations', next)}
            addLabel={t('web.product_display_add_location')}
            emptyHint={t('web.product_display_locations_empty')}
            onAdd={() => ''}
            renderRow={(item, index, update) => (
              <>
                <label className="visually-hidden" htmlFor={`product-location-${mode}-${index}`}>
                  {`${t('web.product_display_location_n')} ${formatNumber(index + 1)}`}
                </label>
                <input
                  id={`product-location-${mode}-${index}`}
                  className="input"
                  value={item}
                  maxLength={PRODUCT_DISPLAY_LOCATION_MAX_LENGTH}
                  onChange={(event) => update(event.target.value)}
                />
              </>
            )}
          />
        </Field>

        <Field
          label={t('web.product_display_features')}
          hint={t('web.product_display_features_hint')}
          {...errorAt('features')}
        >
          <ListEditor
            items={state.displayFeatures}
            onChange={(next) => set('displayFeatures', next)}
            addLabel={t('web.product_display_add_feature')}
            emptyHint={t('web.product_display_features_empty')}
            onAdd={() => ''}
            renderRow={(item, index, update) => (
              <>
                <label className="visually-hidden" htmlFor={`product-feature-${mode}-${index}`}>
                  {`${t('web.product_display_feature_n')} ${formatNumber(index + 1)}`}
                </label>
                <input
                  id={`product-feature-${mode}-${index}`}
                  className="input"
                  value={item}
                  maxLength={PRODUCT_DISPLAY_FEATURE_MAX_LENGTH}
                  onChange={(event) => update(event.target.value)}
                />
              </>
            )}
          />
        </Field>

        <div className="full">
          <Field
            label={t('web.product_display_location_label')}
            hint={t('web.product_display_location_label_hint')}
            htmlFor={`product-location-label-${mode}`}
            {...errorAt('label')}
          >
            <input
              id={`product-location-label-${mode}`}
              value={state.serviceLocationLabel}
              maxLength={PRODUCT_SERVICE_LOCATION_LABEL_MAX_LENGTH}
              onChange={(event) => set('serviceLocationLabel', event.target.value)}
            />
          </Field>
        </div>
      </FormSection>

      {problem !== null && showProblem && problemField === undefined && (
        <div className="cb-form-error">
          <Banner tone="warn">{t(problem)}</Banner>
        </div>
      )}

      {mutate.error !== null && (
        <div className="cb-form-error">
          <Banner tone="danger">{messageFor(mutate.error)}</Banner>
        </div>
      )}
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
        title={row?.title ?? t('web.product_detail')}
        {...(row === undefined
          ? {}
          : {
              badge: (
                <Badge tone={STATUS_TONES[row.status]} dot>
                  {t(STATUS_LABELS[row.status])}
                </Badge>
              ),
              subtitle: (
                <span className="cb-meta">
                  <span>{t('web.product_detail')}</span>
                  <Ltr>{row.id}</Ltr>
                </span>
              ),
            })}
      />

      <StateSwitch query={product} denied={denied}>
        {row === undefined ? null : (
          <>
            {gap !== null && (
              <Banner
                tone={isUnlistedGap(gap) ? 'info' : 'warn'}
                title={t('web.product_gap_banner_title')}
              >
                {t(GAP_LABELS[gap])}
              </Banner>
            )}

            <div className={mayEdit ? 'cb-editor' : 'cb-editor no-nav'}>
              {mayEdit && (
                <SectionNav
                  items={[
                    { id: 'product-edit-basic', label: t('web.cb_section_basic') },
                    { id: 'product-edit-pricing', label: t('web.cb_section_pricing') },
                    { id: 'product-edit-volume', label: t('web.cb_section_volume') },
                    { id: 'product-edit-placement', label: t('web.cb_section_placement') },
                    { id: 'product-edit-display', label: t('web.cb_section_display') },
                  ]}
                />
              )}

              <div className="cb-editor-main">
                {mayEdit ? (
                  // KEYED BY THE PRODUCT ID: React reconciles by position and type, so
                  // navigating between two product URLs would keep one instance mounted
                  // and every `useState` initialiser would hold the previous product's
                  // values — which here are the fields about to be written.
                  <ProductForm key={row.id} mode="edit" product={row} />
                ) : (
                  <Card title={t('web.product_edit_title')}>
                    <Banner tone="info">{t('web.product_edit_denied')}</Banner>
                  </Card>
                )}
              </div>

              <div className="cb-editor-side stack">
                <Card title={t('web.product_identity_title')}>
                  <KV
                    items={[
                      [t('web.product_title'), row.title],
                      [t('web.product_description'), row.description ?? <Dash key="d" />],
                      [
                        t('web.product_catalogue'),
                        <CatalogueBadge key="c" row={row} category={facts} />,
                      ],
                      [
                        t('web.product_category'),
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
                          <Num key="dl" value={row.deviceLimit} />
                        ),
                      ],
                      [t('web.product_sort_order'), <Num key="so" value={row.sortOrder} />],
                      [
                        t('web.product_panel'),
                        row.panelId === null ? (
                          <Dash key="pa" />
                        ) : (
                          <Copyable key="pa" value={row.panelId} />
                        ),
                      ],
                      [
                        t('web.product_display_locations'),
                        <DisplayList key="dloc" lines={row.displayLocations} />,
                      ],
                      [
                        t('web.product_display_features'),
                        <DisplayList key="dfeat" lines={row.displayFeatures} />,
                      ],
                      [
                        t('web.product_display_location_label'),
                        row.serviceLocationLabel === null ? (
                          <Dash key="dlabel" />
                        ) : (
                          <span key="dlabel">{row.serviceLocationLabel}</span>
                        ),
                      ],
                      [t('web.product_created_at'), formatTimestamp(row.createdAt)],
                      [t('web.updated_at'), formatTimestamp(row.updatedAt)],
                    ]}
                  />
                </Card>

                {mayEdit && (
                  <>
                    {/*
                      Moving a product between categories, on its OWN card.

                      A reassignment is not an edit of the product's properties: it writes
                      a different column, takes the destination category's row lock, and
                      leaves an audit row naming where it moved FROM. Folding it into the
                      edit form would make "who moved this plan" answerable only by
                      diffing payloads — the defect `payment-accounts.tsx` records from
                      the other end.
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
                      <div className="form-actions">
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={assign.isPending || chosen === '' || chosen === row.categoryId}
                          onClick={() => assign.mutate(chosen)}
                        >
                          {t('web.product_category_assign')}
                        </Button>
                      </div>
                      {assign.error != null && (
                        <Banner tone="danger">{messageFor(assign.error)}</Banner>
                      )}
                    </Card>

                    <Card
                      title={t('web.product_status_title')}
                      hint={t('web.product_status_hint')}
                      {...(row.status === 'ACTIVE' ? { tone: 'danger' as const } : {})}
                    >
                      <div className="form-actions">
                        {row.status === 'INACTIVE' ? (
                          <Button
                            variant="primary"
                            size="sm"
                            icon="play"
                            disabled={status.isPending}
                            onClick={() => status.mutate('ACTIVE')}
                          >
                            {t('web.product_activate')}
                          </Button>
                        ) : (
                          <Button
                            variant="danger"
                            size="sm"
                            icon="pause"
                            disabled={status.isPending}
                            onClick={() => status.mutate('INACTIVE')}
                          >
                            {t('web.product_deactivate')}
                          </Button>
                        )}
                      </div>
                      {/* The sentence that stops a withdrawal being feared: it changes what
                          can be bought NEXT and nothing about what was bought. */}
                      <p className="muted small">{t('web.product_deactivate_note')}</p>
                      {status.error !== null && (
                        <Banner tone="danger">{messageFor(status.error)}</Banner>
                      )}
                    </Card>
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </StateSwitch>
    </>
  );
}
