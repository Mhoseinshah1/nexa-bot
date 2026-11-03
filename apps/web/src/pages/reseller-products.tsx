import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PRODUCT_PAGE_MAX,
  RESELLER_TIER_GRANTS_MAX,
  type ProductCategorySummaryResponse,
  type ProductSummaryResponse,
  type ResellerPolicy,
  type ResellerTierGrant,
} from '@nexa/contracts';
import { fetchProductCategories, fetchProducts, replaceResellerOverrides } from '../api/client';
import { formatNumber } from '../format';
import { useSubmissionKey, type SubmissionKey } from '../submission-key';
import { t, type WebKey } from '../i18n/web.fa';
import { messageFor } from './settings';
import { keptOverrides } from './reseller-plans';
import {
  Banner,
  Button,
  FilterChip,
  FilterChips,
  Meter,
  SearchInput,
  Switch,
  useToast,
} from '../ui/kit';
import { Icon } from '../ui/icons';
import { ErrorRef } from '../ui/technical-details';

/**
 * «محصولات مجاز» — the catalogue dimension of one reseller's policy, drawn as chips.
 *
 * The chips edit exactly what the override editor's «کاتالوگ» dimension edits: the
 * reseller's own PRODUCT and CATEGORY grants, sent through the same
 * `replaceResellerOverrides` (same permission, same audit action). A chip is "on" when the
 * evaluator's catalogue rule grants the product — the product itself, its category, or
 * every product — so it never claims what the server would refuse. Panel, bot and
 * operation grants are not touched: they are carried over unchanged.
 *
 * The list is every product, followed page by page to its end (`useAllProducts`), so the
 * counts are totals of a complete list. When the end cannot be reached the tab says so and
 * edits nothing (`complete: false`) rather than drawing a page's count as the total.
 */

/** The most pages followed before the list is called incomplete. */
const PAGES_MAX = 40;

export interface AllProducts {
  readonly rows: readonly ProductSummaryResponse[];
  /** True only when the last page was reached. */
  readonly complete: boolean;
}

/** Every product (current and imported), following the cursor to the end. */
export function useAllProducts(enabled: boolean) {
  return useQuery({
    queryKey: ['products', 'reseller-allowed'],
    enabled,
    queryFn: async (): Promise<AllProducts> => {
      const rows: ProductSummaryResponse[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < PAGES_MAX; page += 1) {
        const answer = await fetchProducts({
          limit: PRODUCT_PAGE_MAX,
          ...(cursor === undefined ? {} : { cursor }),
        });
        rows.push(...answer.products);
        if (answer.nextCursor === null) return { rows, complete: true };
        cursor = answer.nextCursor;
      }
      return { rows, complete: false };
    },
  });
}

export function useCategories(enabled: boolean) {
  return useQuery({
    queryKey: ['product-categories'],
    queryFn: () => fetchProductCategories(),
    enabled,
  });
}

// ---------------------------------------------------------------------------
// Pure helpers (tested)
// ---------------------------------------------------------------------------

/** The imported products' group: every product the one-time import wrote. */
export function isLegacy(product: ProductSummaryResponse): boolean {
  return product.source === 'MIRZA';
}

/** The reseller's effective catalogue grants, as the evaluator reads them. */
function catalogueGrants(policy: ResellerPolicy): readonly ResellerTierGrant[] {
  return policy.dimensions.find((d) => d.dimension === 'CATALOGUE')?.effectiveGrants ?? [];
}

/**
 * The products the catalogue rule grants now: a product is granted when it, its category,
 * or every product of either kind is.
 */
export function allowedIdsOf(
  policy: ResellerPolicy,
  products: readonly ProductSummaryResponse[],
): ReadonlySet<string> {
  const grants = catalogueGrants(policy);
  const everything = grants.some((g) => g.subject === null);
  const productIds = new Set(grants.filter((g) => g.kind === 'PRODUCT').map((g) => g.subject));
  const categoryIds = new Set(grants.filter((g) => g.kind === 'CATEGORY').map((g) => g.subject));
  return new Set(
    products
      .filter(
        (p) =>
          everything ||
          productIds.has(p.id) ||
          (p.categoryId !== null && categoryIds.has(p.categoryId)),
      )
      .map((p) => p.id),
  );
}

/**
 * The catalogue grants that make exactly `wanted` allowed.
 *
 * A category or "every product" grant that still covers only wanted products is kept as it
 * is (a product added to that category later stays granted); one that would cover an
 * unwanted product is dropped and its wanted products are named one by one. Deterministic:
 * the same set is the same payload, and so the same idempotency fingerprint.
 */
export function catalogueGrantsFor(
  policy: ResellerPolicy,
  products: readonly ProductSummaryResponse[],
  wanted: ReadonlySet<string>,
): { grants: ResellerTierGrant[] } | { problem: WebKey } {
  const current = catalogueGrants(policy);
  const everyone = products.every((p) => wanted.has(p.id));
  const grants: ResellerTierGrant[] = [];
  const covered = new Set<string>();

  for (const kind of ['PRODUCT', 'CATEGORY'] as const) {
    if (current.some((g) => g.kind === kind && g.subject === null) && everyone) {
      grants.push({ kind, subject: null });
      products.forEach((p) => covered.add(p.id));
    }
  }
  const keptCategories = new Set<string>();
  for (const grant of current) {
    if (grant.kind !== 'CATEGORY' || grant.subject === null) continue;
    const inside = products.filter((p) => p.categoryId === grant.subject);
    if (inside.every((p) => wanted.has(p.id))) {
      keptCategories.add(grant.subject);
      inside.forEach((p) => covered.add(p.id));
    }
  }
  for (const subject of [...keptCategories].sort()) grants.push({ kind: 'CATEGORY', subject });
  const named = products
    .filter((p) => wanted.has(p.id) && !covered.has(p.id))
    .map((p) => p.id)
    .sort();
  for (const subject of named) grants.push({ kind: 'PRODUCT', subject });

  if (grants.length > RESELLER_TIER_GRANTS_MAX) {
    return { problem: 'web.reseller_grants_problem_too_many' };
  }
  return { grants };
}

export interface ProductGroup {
  readonly id: string;
  readonly title: string;
  readonly legacy: boolean;
  readonly products: readonly ProductSummaryResponse[];
}

/**
 * Products grouped by category, in the server's category order; the products filed under
 * nothing, then the imported ones in one group of their own. A group with no product is not
 * drawn.
 */
export function groupProducts(
  products: readonly ProductSummaryResponse[],
  categories: readonly ProductCategorySummaryResponse[],
): ProductGroup[] {
  const current = products.filter((p) => !isLegacy(p));
  const groups: ProductGroup[] = categories.map((category) => ({
    id: category.id,
    title: category.emoji === null ? category.name : `${category.emoji} ${category.name}`,
    legacy: false,
    products: current.filter((p) => p.categoryId === category.id),
  }));
  const known = new Set(categories.map((c) => c.id));
  groups.push({
    id: 'none',
    title: t('web.product_category_unset'),
    legacy: false,
    products: current.filter((p) => p.categoryId === null || !known.has(p.categoryId)),
  });
  groups.push({
    id: 'legacy',
    title: t('web.rs_group_legacy'),
    legacy: true,
    products: products.filter(isLegacy),
  });
  return groups.filter((group) => group.products.length > 0);
}

// ---------------------------------------------------------------------------
// The draft
// ---------------------------------------------------------------------------

export interface ProductDraft {
  /** The set shown: the operator's draft, else what the server grants. */
  readonly allowed: ReadonlySet<string>;
  readonly dirty: boolean;
  readonly set: (next: ReadonlySet<string>) => void;
  readonly reset: () => void;
}

/**
 * The unsaved choice of allowed products. Lives above the tabs, so leaving the tab keeps it
 * and the page's leave guard sees it. `null` follows the server, so a save (which refetches
 * the policy) leaves nothing to discard.
 */
export function useProductDraft(
  policy: ResellerPolicy | undefined,
  products: AllProducts | undefined,
): ProductDraft {
  const [draft, setDraft] = useState<ReadonlySet<string> | null>(null);
  const base =
    policy === undefined || products === undefined
      ? new Set<string>()
      : allowedIdsOf(policy, products.rows);
  const allowed = draft ?? base;
  const dirty =
    draft !== null && (draft.size !== base.size || [...draft].some((id) => !base.has(id)));
  return { allowed, dirty, set: setDraft, reset: () => setDraft(null) };
}

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------

type Filter = 'ALL' | 'ALLOWED' | 'DENIED';

/** "X of Y allowed" in one text node, so it reads as one phrase. */
function allowedText(allowed: number, total: number): string {
  return `${formatNumber(allowed)} ${t('web.progress_of')} ${formatNumber(total)} ${t('web.rs_allowed_word')}`;
}

export function ProductsTab({
  customerId,
  policy,
  products,
  categories,
  draft,
  mayEdit,
  held,
}: {
  customerId: string;
  policy: ResellerPolicy;
  products: AllProducts;
  categories: readonly ProductCategorySummaryResponse[];
  draft: ProductDraft;
  mayEdit: boolean;
  held?: SubmissionKey | undefined;
}) {
  const notify = useToast();
  const queries = useQueryClient();
  const own = useSubmissionKey();
  const submission = held ?? own;
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('ALL');
  const [open, setOpen] = useState<ReadonlyMap<string, boolean>>(new Map());

  const editable = mayEdit && products.complete;
  const groups = groupProducts(products.rows, categories);
  const allowed = draft.allowed;
  const total = products.rows.length;
  const count = [...allowed].filter((id) => products.rows.some((p) => p.id === id)).length;

  const needle = search.trim().toLowerCase();
  const shown = (group: ProductGroup) =>
    group.products.filter(
      (p) =>
        (needle === '' || p.title.toLowerCase().includes(needle)) &&
        (filter === 'ALL' || (filter === 'ALLOWED') === allowed.has(p.id)),
    );

  const change = (ids: readonly string[], on: boolean) => {
    const next = new Set(allowed);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    draft.set(next);
  };
  const ids = (list: readonly ProductSummaryResponse[]) => list.map((p) => p.id);
  const current = products.rows.filter((p) => !isLegacy(p));

  const checked = catalogueGrantsFor(policy, products.rows, allowed);
  const problem = 'problem' in checked ? checked.problem : null;

  const save = useMutation({
    mutationFn: () => {
      if ('problem' in checked) throw new Error('unreachable: guarded by the submit button');
      const overrides = [
        ...keptOverrides(policy, ['CATALOGUE']),
        { dimension: 'CATALOGUE' as const, grants: checked.grants },
      ];
      const idempotencyKey = submission.current({ customerId, overrides });
      return replaceResellerOverrides({ customerId, idempotencyKey, overrides });
    },
    onSuccess: (response) => {
      submission.settle();
      queries.setQueryData(['reseller-policy', customerId], response);
      void queries.invalidateQueries({ queryKey: ['reseller-policy', customerId] });
      void queries.invalidateQueries({ queryKey: ['reseller-history', customerId] });
      draft.reset();
      notify({ tone: 'ok', message: t('web.reseller_policy_saved') });
    },
    onError: (error) => submission.settleOn(error),
  });

  if (products.rows.length === 0) {
    return <Banner tone="info">{t('web.reseller_policy_products_empty')}</Banner>;
  }

  return (
    <div className="rs-products">
      {!products.complete && <Banner tone="info">{t('web.rs_products_partial')}</Banner>}
      {products.complete && (
        <Meter
          label={t('web.rs_products_total')}
          used={formatNumber(count)}
          total={formatNumber(total)}
          value={count}
          max={Math.max(total, 1)}
          tone="info"
        />
      )}

      <div className="rs-products-bar">
        <SearchInput
          value={search}
          onChange={setSearch}
          label={t('web.rs_products_search')}
          placeholder={t('web.rs_products_search')}
        />
        <FilterChips label={t('web.rs_products_filter')}>
          <FilterChip pressed={filter === 'ALL'} onClick={() => setFilter('ALL')}>
            {t('web.rs_filter_all')}
          </FilterChip>
          <FilterChip pressed={filter === 'ALLOWED'} onClick={() => setFilter('ALLOWED')}>
            {t('web.rs_filter_allowed')}
          </FilterChip>
          <FilterChip pressed={filter === 'DENIED'} onClick={() => setFilter('DENIED')}>
            {t('web.rs_filter_denied')}
          </FilterChip>
        </FilterChips>
      </div>

      {editable && (
        <div className="rs-products-bulk" role="group" aria-label={t('web.rs_products_bulk')}>
          <Button size="sm" onClick={() => change(ids(products.rows), true)}>
            {t('web.rs_bulk_all')}
          </Button>
          <Button size="sm" onClick={() => change(ids(products.rows), false)}>
            {t('web.rs_bulk_none')}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              const next = new Set(ids(current));
              draft.set(next);
            }}
          >
            {t('web.rs_bulk_current')}
          </Button>
        </div>
      )}

      {groups.map((group) => {
        const visible = shown(group);
        const inGroup = group.products.filter((p) => allowed.has(p.id)).length;
        // The imported group starts collapsed; a search opens it so a match is not hidden.
        const expanded = open.get(group.id) ?? (!group.legacy || needle !== '');
        const bodyId = `rs-group-${group.id}`;
        if ((needle !== '' || filter !== 'ALL') && visible.length === 0) return null;
        return (
          <section key={group.id} className="rs-group" aria-label={group.title}>
            <div className="rs-group-head">
              <button
                type="button"
                className="rs-group-toggle"
                aria-expanded={expanded}
                aria-controls={bodyId}
                onClick={() => setOpen((map) => new Map(map).set(group.id, !expanded))}
              >
                <Icon name="chevronLeft" size={14} className="rs-group-chevron" />
                <b>{group.title}</b>
                <span className="muted small">
                  {products.complete ? allowedText(inGroup, group.products.length) : ''}
                </span>
              </button>
              {editable && (
                <Switch
                  label={`${t('web.rs_group_switch')} ${group.title}`}
                  checked={inGroup === group.products.length}
                  onChange={(next) => change(ids(group.products), next)}
                />
              )}
            </div>
            {expanded && (
              <div id={bodyId} className="rs-pgrid">
                {visible.map((product) => (
                  <button
                    key={product.id}
                    type="button"
                    className={allowed.has(product.id) ? 'rs-pchip on' : 'rs-pchip'}
                    aria-pressed={allowed.has(product.id)}
                    disabled={!editable}
                    onClick={() => change([product.id], !allowed.has(product.id))}
                  >
                    {product.title}
                  </button>
                ))}
              </div>
            )}
          </section>
        );
      })}

      {problem !== null && <Banner tone="warn">{t(problem)}</Banner>}
      {mayEdit && (
        <div className="rs-products-save">
          {draft.dirty && (
            <span className="cb-dirty" role="status">
              <i className="dot" aria-hidden="true" />
              {t('web.unsaved_changes')}
            </span>
          )}
          <span className="spacer" />
          <Button size="sm" disabled={!draft.dirty || save.isPending} onClick={draft.reset}>
            {t('web.rule_cancel_edit')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon="check"
            disabled={!editable || !draft.dirty || problem !== null || save.isPending}
            onClick={() => save.mutate()}
          >
            {t('web.rs_products_save')}
          </Button>
        </div>
      )}
      {save.error !== null && (
        <Banner tone="danger">
          {messageFor(save.error)}
          <ErrorRef error={save.error} />
        </Banner>
      )}
    </div>
  );
}
