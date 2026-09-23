import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CASHBACK_PERCENT_MAX,
  CASHBACK_PERCENT_MIN,
  DISCOUNT_CODE_MAX_LENGTH,
  DISCOUNT_CODE_MIN_LENGTH,
  DISCOUNT_LABEL_MAX_LENGTH,
  DISCOUNT_PERCENTAGE_MAX,
  DISCOUNT_PERCENTAGE_MIN,
  DISCOUNT_PRIORITY_MAX,
  DISCOUNT_PRIORITY_MIN,
  DISCOUNTABLE_PURPOSES,
  MAX_MONEY_AMOUNT_MINOR,
  PRODUCT_PAGE_MAX,
  SALES_CURRENCY_CODES,
  uuidV7Schema,
  type CashbackRuleSummaryResponse,
  type CurrencyCode,
  type DiscountKind,
  type DiscountRefusalReason,
  type DiscountStatus,
  type DiscountSummaryResponse,
  type DiscountType,
  type DiscountablePurpose,
  type PricePreviewResponse,
  type PricePreviewRuleOutcome,
  type ProductCategoryListingResponse,
  type ProductSummaryResponse,
} from '@nexa/contracts';
import {
  createCashbackRule,
  createDiscount,
  fetchCashbackRules,
  fetchDiscounts,
  fetchPricePreview,
  fetchProductCategories,
  fetchProducts,
  transitionCashbackRule,
  transitionDiscount,
  updateCashbackRule,
  updateDiscount,
  type CashbackRuleWriteInput,
  type DiscountWriteInput,
} from '../api/client';
import { formatTimestamp } from '../format';
import { useSubmissionKey } from '../submission-key';
import { mayRequest, queryState } from '../view-state';
import { t, type WebKey } from '../i18n/web.fa';
import { useLinkHandler } from '../router';
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
  Num,
  PageHead,
  Pills,
  StateSwitch,
  useToast,
  type Column,
  type Tone,
} from '../ui/kit';

/**
 * Discounts, cashback rules and the price preview (WP8).
 *
 * Three sections on one page because they answer one question from three sides — what
 * a customer will be charged, and what they will get back — and each is drawn on the
 * permission the SERVER charges for it: `catalog.view` to read either list and to run
 * the preview, `catalog.discounts.edit` to write a discount, `catalog.pricing.edit` to
 * write a cashback rule. A section the actor may not write says so by naming the key
 * rather than drawing a disabled form, the rule `products.tsx` states.
 *
 * What the page says because the server does it, and would be easy to render wrongly:
 *
 * - **A rule is created INACTIVE** and goes live through its own command. The create
 *   form says so beside its button, and activate and deactivate are separate buttons on
 *   the row — so "who switched this code on, and when" is its own audit row.
 * - **A discount's `kind` and `code` never change.** The edit form shows them as text,
 *   not as inputs, and sends the STORED values back: the server accepts them only when
 *   they match, and a code customers were given must keep meaning the rule it named.
 * - **There is no delete.** A redemption and an order's quote both name the rule.
 * - **`liveRedemptions` is what the limits are decided against** — redemptions whose
 *   order is AWAITING_PAYMENT or PAID — so it is shown against the limits, not as a
 *   lifetime counter.
 *
 * Every figure is the server's. The browser computes no price: the preview is the
 * engine's own answer, and a second opinion here would be the one nobody tests.
 */
export function DiscountsPage({
  denied,
  mayEditDiscounts,
  mayEditCashback,
}: {
  /** No `catalog.view`: neither list, no edit (it opens from a row), and no preview. */
  denied: boolean;
  /** `catalog.discounts.edit` — its own server permission, never derived from `denied`. */
  mayEditDiscounts: boolean;
  /** `catalog.pricing.edit` — likewise. */
  mayEditCashback: boolean;
}) {
  const options = useScopeOptions(!denied);
  return (
    <>
      <PageHead
        title={t('web.discounts_title')}
        subtitle={t('web.discounts_intro')}
        maturity="now"
      />
      <DiscountRules denied={denied} mayEdit={mayEditDiscounts} options={options} />
      <CashbackRules denied={denied} mayEdit={mayEditCashback} options={options} />
      <PricePreview denied={denied} options={options} />
      <Card title={t('web.discounts_scope_title')}>
        <p className="muted">{t('web.discounts_rule_no_delete')}</p>
        <p className="muted">{t('web.discounts_rule_usage')}</p>
        <p className="muted">{t('web.discounts_rule_cashback')}</p>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

export const PURPOSE_LABELS: Readonly<Record<DiscountablePurpose, WebKey>> = {
  NEW_SERVICE: 'web.purpose_new_service',
  RENEW: 'web.purpose_renew',
  ADD_TRAFFIC: 'web.purpose_add_traffic',
  ADD_TIME: 'web.purpose_add_time',
};

const KIND_LABELS: Readonly<Record<DiscountKind, WebKey>> = {
  CODE: 'web.discount_kind_code',
  AUTOMATIC: 'web.discount_kind_automatic',
};

/** ACTIVE and INACTIVE, the same two words for both rule tables. */
const STATUS_LABELS: Readonly<Record<DiscountStatus, WebKey>> = {
  ACTIVE: 'web.rule_status_active',
  INACTIVE: 'web.rule_status_inactive',
};

const STATUS_TONES: Readonly<Record<DiscountStatus, Tone>> = {
  ACTIVE: 'ok',
  INACTIVE: 'neutral',
};

const OUTCOME_LABELS: Readonly<Record<PricePreviewRuleOutcome, WebKey>> = {
  APPLIED: 'web.preview_outcome_applied',
  SKIPPED: 'web.preview_outcome_skipped',
  INELIGIBLE: 'web.preview_outcome_ineligible',
  CUSTOMER_DEPENDENT: 'web.preview_outcome_customer_dependent',
};

const OUTCOME_TONES: Readonly<Record<PricePreviewRuleOutcome, Tone>> = {
  APPLIED: 'ok',
  SKIPPED: 'warn',
  INELIGIBLE: 'neutral',
  CUSTOMER_DEPENDENT: 'info',
};

/**
 * Why a rule did not apply — for the OPERATOR, never for the customer.
 *
 * A `Record` over the frozen `DISCOUNT_REFUSAL_REASONS`, so a reason added to the
 * contract is a compile error here rather than a blank cell.
 */
export const REASON_LABELS: Readonly<Record<DiscountRefusalReason, WebKey>> = {
  UNKNOWN_CODE: 'web.discount_reason_unknown_code',
  INACTIVE: 'web.discount_reason_inactive',
  NOT_STARTED: 'web.discount_reason_not_started',
  ENDED: 'web.discount_reason_ended',
  PURPOSE: 'web.discount_reason_purpose',
  PRODUCT: 'web.discount_reason_product',
  CATEGORY: 'web.discount_reason_category',
  CUSTOMER: 'web.discount_reason_customer',
  FIRST_PURCHASE: 'web.discount_reason_first_purchase',
  MINIMUM_SUBTOTAL: 'web.discount_reason_minimum_subtotal',
  CURRENCY: 'web.discount_reason_currency',
  TOTAL_LIMIT: 'web.discount_reason_total_limit',
  CUSTOMER_LIMIT: 'web.discount_reason_customer_limit',
  NOT_COMBINABLE: 'web.discount_reason_not_combinable',
};

function Dash() {
  return <span className="faint">—</span>;
}

function purposesText(purposes: readonly DiscountablePurpose[]): string {
  return purposes.map((purpose) => t(PURPOSE_LABELS[purpose])).join(t('web.list_separator'));
}

// ---------------------------------------------------------------------------
// The catalogue, for pickers and for names
// ---------------------------------------------------------------------------

interface ScopeOptions {
  /** The COMPLETE product list, or null when it cannot be offered as a select. */
  readonly products: readonly ProductSummaryResponse[] | null;
  /** Every category, or null when the list did not answer. */
  readonly categories: readonly ProductCategoryListingResponse[] | null;
  /** Names for whatever did arrive, complete or not. */
  readonly productNames: ReadonlyMap<string, string>;
  readonly categoryNames: ReadonlyMap<string, string>;
}

/**
 * Products and categories, read once for every section on the page.
 *
 * A select ONLY when the list is complete, the rule `products.tsx` gives for its panel
 * picker: a select that silently omits the hundred-and-first product is worse than a
 * box asking for an id, because nothing on screen says a choice is missing. So a
 * `nextCursor`, a refusal or a failure all fall back to a typed id, and the field says
 * why.
 */
function useScopeOptions(enabled: boolean): ScopeOptions {
  const products = useQuery({
    queryKey: ['products', 'for-pricing'],
    queryFn: () => fetchProducts({ limit: PRODUCT_PAGE_MAX }),
    enabled,
  });
  const categories = useQuery({
    queryKey: ['product-categories'],
    queryFn: () => fetchProductCategories(),
    enabled,
  });
  const productRows = products.data?.products ?? [];
  const categoryRows = categories.data?.categories ?? [];
  return {
    products:
      queryState(products) === 'ready' && (products.data?.nextCursor ?? null) === null
        ? productRows
        : null,
    categories: queryState(categories) === 'ready' ? categoryRows : null,
    productNames: new Map(productRows.map((row) => [row.id, row.title])),
    categoryNames: new Map(categoryRows.map((row) => [row.id, row.name])),
  };
}

/** A product or category reference: its name when known, and its id either way. */
function Reference({ id, name }: { id: string; name: string | undefined }) {
  return name === undefined ? <Copyable value={id} /> : <Copyable value={id} display={name} />;
}

/** The scope of a rule, in one cell: purposes, then what it is narrowed to. */
function ScopeCell({
  appliesTo,
  productId,
  categoryId,
  options,
  extra,
}: {
  appliesTo: readonly DiscountablePurpose[];
  productId: string | null;
  categoryId: string | null;
  options: ScopeOptions;
  extra?: ReactNode;
}) {
  return (
    <div>
      <div>{purposesText(appliesTo)}</div>
      <div className="muted small">
        {productId !== null ? (
          <>
            {t('web.rule_scope_product')}:{' '}
            <Reference id={productId} name={options.productNames.get(productId)} />
          </>
        ) : categoryId !== null ? (
          <>
            {t('web.rule_scope_category')}:{' '}
            <Reference id={categoryId} name={options.categoryNames.get(categoryId)} />
          </>
        ) : (
          t('web.rule_scope_all')
        )}
      </div>
      {extra}
    </div>
  );
}

function WindowCell({ startsAt, endsAt }: { startsAt: string | null; endsAt: string | null }) {
  if (startsAt === null && endsAt === null) return <span>{t('web.rule_window_always')}</span>;
  return (
    <div className="small">
      {startsAt !== null && (
        <div className="nowrap">
          {t('web.rule_window_from')} {formatTimestamp(startsAt)}
        </div>
      )}
      {endsAt !== null && (
        <div className="nowrap">
          {t('web.rule_window_until')} {formatTimestamp(endsAt)}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ value }: { value: DiscountStatus }) {
  return <Badge tone={STATUS_TONES[value]}>{t(STATUS_LABELS[value])}</Badge>;
}

// ---------------------------------------------------------------------------
// Keyset paging, keyed by the filter it was minted under
// ---------------------------------------------------------------------------

/**
 * The cursor trail, reset when the filter changes.
 *
 * A cursor minted under one filter strands every row before it under another — the
 * reason `products.tsx` keys its trail by a search signature. Derived rather than reset
 * in an effect, so there is no render in which the old cursor meets the new filter.
 */
function useTrail(signature: string) {
  const [trail, setTrail] = useState<{ signature: string; cursors: readonly string[] }>({
    signature,
    cursors: [],
  });
  const cursors = trail.signature === signature ? trail.cursors : [];
  return {
    cursor: cursors.length > 0 ? cursors[cursors.length - 1] : undefined,
    depth: cursors.length,
    push: (next: string) => setTrail({ signature, cursors: [...cursors, next] }),
    pop: () => setTrail({ signature, cursors: cursors.slice(0, -1) }),
  };
}

// ---------------------------------------------------------------------------
// Discount rules
// ---------------------------------------------------------------------------

type KindFilter = 'ALL' | DiscountKind;
type StatusFilter = 'ALL' | DiscountStatus;

function DiscountRules({
  denied,
  mayEdit,
  options,
}: {
  denied: boolean;
  mayEdit: boolean;
  options: ScopeOptions;
}) {
  const onLink = useLinkHandler();
  const queries = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();

  const [kind, setKind] = useState<KindFilter>('ALL');
  const [status, setStatus] = useState<StatusFilter>('ALL');
  const signature = `${kind}|${status}`;
  const trail = useTrail(signature);

  const discounts = useQuery({
    queryKey: ['discounts', signature, trail.cursor ?? null],
    queryFn: () =>
      fetchDiscounts({
        ...(trail.cursor === undefined ? {} : { cursor: trail.cursor }),
        ...(kind === 'ALL' ? {} : { kind }),
        ...(status === 'ALL' ? {} : { status }),
      }),
    enabled: !denied,
  });
  const rows = discounts.data?.discounts ?? [];
  const nextCursor = discounts.data?.nextCursor ?? null;
  const filtered = kind !== 'ALL' || status !== 'ALL';

  /** The rule whose edit form is open, as the server last described it. */
  const [editing, setEditing] = useState<DiscountSummaryResponse | null>(null);

  const transition = useMutation({
    mutationFn: (input: { id: string; which: 'activate' | 'deactivate' }) =>
      transitionDiscount({ ...input, idempotencyKey: submission.current(input) }),
    onSuccess: (_response, input) => {
      submission.settle();
      notify({
        tone: 'ok',
        message:
          input.which === 'activate' ? t('web.discount_activated') : t('web.discount_deactivated'),
      });
      void queries.invalidateQueries({ queryKey: ['discounts'] });
    },
    // A 5xx may have committed. A fresh key on the next press would be a second command.
    onError: (error) => submission.settleOn(error),
  });

  const columns: readonly Column<DiscountSummaryResponse>[] = [
    {
      key: 'label',
      header: t('web.rule_label'),
      render: (row) => (
        <div>
          <strong>{row.label}</strong>
          {row.code !== null && (
            <div>
              <Ltr>{row.code}</Ltr>
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'kind',
      header: t('web.discount_kind'),
      render: (row) => <Badge tone="neutral">{t(KIND_LABELS[row.kind])}</Badge>,
    },
    {
      key: 'value',
      header: t('web.discount_value'),
      render: (row) => <DiscountValue row={row} />,
    },
    {
      key: 'scope',
      header: t('web.rule_scope'),
      render: (row) => (
        <ScopeCell
          appliesTo={row.appliesTo}
          productId={row.productId}
          categoryId={row.categoryId}
          options={options}
          extra={
            <>
              {row.customerId !== null && (
                <div className="muted small">
                  {t('web.discount_customer')}:{' '}
                  <a href={`/users/${encodeURIComponent(row.customerId)}`} onClick={onLink}>
                    <Ltr>{row.customerId}</Ltr>
                  </a>
                </div>
              )}
              {row.firstPurchaseOnly && (
                <div className="muted small">{t('web.discount_first_purchase')}</div>
              )}
              {row.minimumSubtotalAmount !== null && (
                <div className="muted small">
                  {t('web.discount_minimum')}: <Minimum row={row} />
                </div>
              )}
            </>
          }
        />
      ),
    },
    {
      key: 'window',
      header: t('web.rule_window'),
      render: (row) => <WindowCell startsAt={row.startsAt} endsAt={row.endsAt} />,
    },
    {
      key: 'usage',
      header: t('web.discount_usage'),
      /*
       * Live redemptions AGAINST the limits, because that is the comparison the server
       * makes. A lifetime counter beside a limit would read as "nearly exhausted" for a
       * code whose orders mostly expired.
       */
      render: (row) => (
        <div className="small">
          <div className="nowrap">
            <Num value={row.liveRedemptions} /> {t('web.discount_usage_of')}{' '}
            {row.totalRedemptionsLimit === null ? (
              t('web.discount_unlimited')
            ) : (
              <Num value={row.totalRedemptionsLimit} />
            )}
          </div>
          <div className="muted nowrap">
            {t('web.discount_per_customer')}:{' '}
            {row.perCustomerLimit === null ? (
              t('web.discount_unlimited')
            ) : (
              <Num value={row.perCustomerLimit} />
            )}
          </div>
        </div>
      ),
    },
    {
      key: 'priority',
      header: t('web.discount_priority'),
      render: (row) => (
        <div>
          <Num value={row.priority} />{' '}
          <Badge tone={row.stackable ? 'teal' : 'neutral'}>
            {t(row.stackable ? 'web.discount_stackable' : 'web.discount_exclusive')}
          </Badge>
        </div>
      ),
    },
    {
      key: 'status',
      header: t('web.status'),
      render: (row) => <StatusBadge value={row.status} />,
    },
    {
      key: 'actions',
      header: t('web.rule_actions'),
      align: 'end',
      // Nothing for a reader. The header stays, so two operators describe one table.
      render: (row) =>
        !mayEdit ? null : (
          <div className="toolbar">
            <button
              type="button"
              className="btn sm"
              disabled={transition.isPending}
              onClick={() => setEditing(row)}
            >
              {t('web.rule_edit')}
            </button>
            <button
              type="button"
              className={row.status === 'ACTIVE' ? 'btn danger sm' : 'btn primary sm'}
              disabled={transition.isPending}
              onClick={() =>
                transition.mutate({
                  id: row.id,
                  which: row.status === 'ACTIVE' ? 'deactivate' : 'activate',
                })
              }
            >
              {t(row.status === 'ACTIVE' ? 'web.rule_deactivate' : 'web.rule_activate')}
            </button>
          </div>
        ),
    },
  ];

  return (
    <>
      <Card title={t('web.discounts_rules_title')} hint={t('web.discounts_rules_hint')}>
        {/* Hidden while the list cannot answer: a filter mints a request the server has
            just refused. */}
        <div className="toolbar" hidden={!mayRequest(discounts, denied)}>
          <Pills
            value={kind}
            onChange={setKind}
            items={[
              { id: 'ALL' as const, label: t('web.discount_kind_all') },
              { id: 'CODE' as const, label: t('web.discount_kind_code') },
              { id: 'AUTOMATIC' as const, label: t('web.discount_kind_automatic') },
            ]}
          />
          <Pills
            value={status}
            onChange={setStatus}
            items={[
              { id: 'ALL' as const, label: t('web.rule_status_all') },
              { id: 'ACTIVE' as const, label: t('web.rule_status_active') },
              { id: 'INACTIVE' as const, label: t('web.rule_status_inactive') },
            ]}
          />
        </div>

        <StateSwitch
          query={discounts}
          denied={denied}
          isEmpty={rows.length === 0 && trail.depth === 0}
          empty={
            filtered ? (
              <Empty title={t('web.discounts_filter_empty')} icon="inbox" />
            ) : (
              <Empty
                title={t('web.discounts_empty')}
                hint={t('web.discounts_empty_hint')}
                icon="discounts"
              />
            )
          }
        >
          <DataTable
            caption={t('web.discounts_rules_title')}
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
          />
          <CursorPager
            shown={rows.length}
            hasPrevious={trail.depth > 0}
            hasNext={nextCursor !== null}
            onPrevious={trail.pop}
            onNext={() => nextCursor !== null && trail.push(nextCursor)}
            // `GET /discounts` pages an ASCENDING keyset, so the next page is NEWER.
            nextLabel="web.newer"
            previousLabel="web.older"
          />
        </StateSwitch>

        {transition.error !== null && <Banner tone="danger">{messageFor(transition.error)}</Banner>}
      </Card>

      {!mayEdit ? (
        <Card title={t('web.discount_new_title')}>
          <Banner tone="info">{t('web.discount_edit_denied')}</Banner>
        </Card>
      ) : editing !== null ? (
        // KEYED BY THE RULE: every `useState` initialiser must read the rule now open,
        // not the one open before it.
        <DiscountForm
          key={editing.id}
          rule={editing}
          options={options}
          onDone={() => setEditing(null)}
        />
      ) : (
        <DiscountForm options={options} onDone={() => undefined} />
      )}
    </>
  );
}

function DiscountValue({ row }: { row: DiscountSummaryResponse }) {
  if (row.type === 'PERCENTAGE') {
    return (
      <span className="nowrap">
        <Ltr>{row.value}</Ltr> {t('web.discount_percent_unit')}
      </span>
    );
  }
  if (row.currency === null) return <Ltr>{row.value}</Ltr>;
  return <Money value={{ amountMinor: row.value, currency: row.currency }} />;
}

/**
 * The floor is in the ORDER's minor units and carries no currency of its own. A fixed
 * rule names one, and then the floor is drawn as money in it; a percentage rule does
 * not, so the digits are shown as they are rather than dressed in a guessed unit.
 */
function Minimum({ row }: { row: DiscountSummaryResponse }) {
  if (row.minimumSubtotalAmount === null) return <Dash />;
  if (row.currency === null) return <Ltr>{row.minimumSubtotalAmount}</Ltr>;
  return <Money value={{ amountMinor: row.minimumSubtotalAmount, currency: row.currency }} />;
}

// ---------------------------------------------------------------------------
// Shared form pieces
// ---------------------------------------------------------------------------

type ScopeKind = 'ALL' | 'PRODUCT' | 'CATEGORY';

interface ScopeState {
  appliesTo: readonly DiscountablePurpose[];
  scopeKind: ScopeKind;
  productId: string;
  categoryId: string;
  startsAt: string;
  endsAt: string;
}

/**
 * An ISO instant as the value of a `datetime-local` input, in the browser's zone.
 *
 * The input has no zone of its own, and the field's hint says whose clock it is.
 */
export function localInputOf(iso: string | null): string {
  if (iso === null) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(
    at.getHours(),
  )}:${pad(at.getMinutes())}`;
}

/**
 * The instant to SEND for a window bound: null for empty, undefined when unreadable.
 *
 * `stored` is the value the server holds. When the input still shows exactly what
 * `localInputOf(stored)` drew, the stored instant is sent back unchanged — the input
 * is minute-precise, and an edit that touched nothing else must not quietly move a
 * bound by its seconds.
 */
export function instantOf(local: string, stored: string | null): string | null | undefined {
  if (local.trim() === '') return null;
  if (stored !== null && local === localInputOf(stored)) return stored;
  const at = new Date(local);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

function isUuid(value: string): boolean {
  return uuidV7Schema.safeParse(value).success;
}

/** A whole number in `[min, max]`, or null. Digits only: no sign, point or exponent. */
function wholeIn(raw: string, min: number, max: number): number | null {
  const text = raw.trim();
  if (!/^\d{1,10}$/u.test(text)) return null;
  const value = Number(text);
  return value >= min && value <= max ? value : null;
}

/**
 * The scope half of both write bodies, or the field that is wrong.
 *
 * Checked with the CONTRACT's constants and the same rules its schema refines, so the
 * operator is told which field to fix rather than receiving a 400 — and the server
 * decides again regardless.
 */
function scopeBody(
  state: ScopeState,
  stored: { startsAt: string | null; endsAt: string | null } | undefined,
):
  | {
      body: {
        appliesTo: DiscountablePurpose[];
        productId: string | null;
        categoryId: string | null;
        startsAt: string | null;
        endsAt: string | null;
      };
    }
  | { problem: WebKey } {
  if (state.appliesTo.length === 0) return { problem: 'web.rule_problem_applies_to' };
  const productId = state.scopeKind === 'PRODUCT' ? state.productId.trim() : '';
  const categoryId = state.scopeKind === 'CATEGORY' ? state.categoryId.trim() : '';
  if (state.scopeKind === 'PRODUCT' && !isUuid(productId)) {
    return { problem: 'web.rule_problem_product' };
  }
  if (state.scopeKind === 'CATEGORY' && !isUuid(categoryId)) {
    return { problem: 'web.rule_problem_category' };
  }
  const startsAt = instantOf(state.startsAt, stored?.startsAt ?? null);
  const endsAt = instantOf(state.endsAt, stored?.endsAt ?? null);
  if (startsAt === undefined || endsAt === undefined) return { problem: 'web.rule_problem_window' };
  if (startsAt !== null && endsAt !== null && Date.parse(startsAt) >= Date.parse(endsAt)) {
    return { problem: 'web.rule_problem_window_order' };
  }
  return {
    body: {
      // In the contract's order, whatever order they were ticked in: the same set is the
      // same payload, and so the same idempotency fingerprint.
      appliesTo: DISCOUNTABLE_PURPOSES.filter((purpose) => state.appliesTo.includes(purpose)),
      productId: productId === '' ? null : productId,
      categoryId: categoryId === '' ? null : categoryId,
      startsAt,
      endsAt,
    },
  };
}

function scopeStateOf(rule: {
  appliesTo: readonly DiscountablePurpose[];
  productId: string | null;
  categoryId: string | null;
  startsAt: string | null;
  endsAt: string | null;
}): ScopeState {
  return {
    appliesTo: rule.appliesTo,
    scopeKind: rule.productId !== null ? 'PRODUCT' : rule.categoryId !== null ? 'CATEGORY' : 'ALL',
    productId: rule.productId ?? '',
    categoryId: rule.categoryId ?? '',
    startsAt: localInputOf(rule.startsAt),
    endsAt: localInputOf(rule.endsAt),
  };
}

const BLANK_SCOPE: ScopeState = {
  appliesTo: ['NEW_SERVICE'],
  scopeKind: 'ALL',
  productId: '',
  categoryId: '',
  startsAt: '',
  endsAt: '',
};

/**
 * Purposes, product or category, and the window — the fields both forms share.
 *
 * The prop is `value`, not `state`: `state-switch-contract.test.tsx` forbids `state={`
 * anywhere in this tree, for the reason `orders.tsx`'s `StateBadge` records.
 */
function ScopeFields({
  prefix,
  value: state,
  onChange,
  options,
}: {
  prefix: string;
  value: ScopeState;
  onChange: (next: ScopeState) => void;
  options: ScopeOptions;
}) {
  const set = <K extends keyof ScopeState>(key: K, value: ScopeState[K]) =>
    onChange({ ...state, [key]: value });

  return (
    <>
      <fieldset className="field">
        <legend>{t('web.rule_applies_to')}</legend>
        {DISCOUNTABLE_PURPOSES.map((purpose) => (
          <label key={purpose} className="nowrap">
            <input
              type="checkbox"
              checked={state.appliesTo.includes(purpose)}
              onChange={(event) =>
                set(
                  'appliesTo',
                  event.target.checked
                    ? [...state.appliesTo, purpose]
                    : state.appliesTo.filter((one) => one !== purpose),
                )
              }
            />{' '}
            {t(PURPOSE_LABELS[purpose])}
          </label>
        ))}
      </fieldset>

      <Field
        label={t('web.rule_scope_kind')}
        hint={t('web.rule_scope_hint')}
        htmlFor={`${prefix}-scope`}
      >
        <select
          id={`${prefix}-scope`}
          value={state.scopeKind}
          onChange={(event) => set('scopeKind', event.target.value as ScopeKind)}
        >
          <option value="ALL">{t('web.rule_scope_all')}</option>
          <option value="PRODUCT">{t('web.rule_scope_product')}</option>
          <option value="CATEGORY">{t('web.rule_scope_category')}</option>
        </select>
      </Field>

      {state.scopeKind === 'PRODUCT' && (
        <Field
          label={t('web.rule_scope_product')}
          htmlFor={`${prefix}-product`}
          {...(options.products === null ? { hint: t('web.rule_product_unreadable') } : {})}
        >
          {options.products === null ? (
            <input
              id={`${prefix}-product`}
              dir="ltr"
              value={state.productId}
              onChange={(event) => set('productId', event.target.value.trim())}
            />
          ) : (
            <select
              id={`${prefix}-product`}
              value={state.productId}
              onChange={(event) => set('productId', event.target.value)}
            >
              <option value="" />
              {options.products.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.title}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}

      {state.scopeKind === 'CATEGORY' && (
        <Field
          label={t('web.rule_scope_category')}
          htmlFor={`${prefix}-category`}
          {...(options.categories === null ? { hint: t('web.rule_category_unreadable') } : {})}
        >
          {options.categories === null ? (
            <input
              id={`${prefix}-category`}
              dir="ltr"
              value={state.categoryId}
              onChange={(event) => set('categoryId', event.target.value.trim())}
            />
          ) : (
            <select
              id={`${prefix}-category`}
              value={state.categoryId}
              onChange={(event) => set('categoryId', event.target.value)}
            >
              <option value="" />
              {options.categories.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.emoji === null ? row.name : `${row.emoji} ${row.name}`}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}

      <Field
        label={t('web.rule_starts_at')}
        hint={t('web.rule_window_hint')}
        htmlFor={`${prefix}-starts`}
      >
        <input
          id={`${prefix}-starts`}
          type="datetime-local"
          value={state.startsAt}
          onChange={(event) => set('startsAt', event.target.value)}
        />
      </Field>
      <Field label={t('web.rule_ends_at')} htmlFor={`${prefix}-ends`}>
        <input
          id={`${prefix}-ends`}
          type="datetime-local"
          value={state.endsAt}
          onChange={(event) => set('endsAt', event.target.value)}
        />
      </Field>
    </>
  );
}

// ---------------------------------------------------------------------------
// The discount form, shared by create and edit
// ---------------------------------------------------------------------------

interface DiscountFormState {
  kind: DiscountKind;
  code: string;
  label: string;
  type: DiscountType;
  value: string;
  currency: CurrencyCode;
  customerId: string;
  firstPurchaseOnly: boolean;
  minimumSubtotal: string;
  totalLimit: string;
  perCustomerLimit: string;
  priority: string;
  stackable: boolean;
  scope: ScopeState;
}

const BLANK_DISCOUNT: DiscountFormState = {
  kind: 'CODE',
  code: '',
  label: '',
  type: 'PERCENTAGE',
  value: '',
  currency: 'IRT',
  customerId: '',
  firstPurchaseOnly: false,
  minimumSubtotal: '',
  totalLimit: '',
  perCustomerLimit: '',
  priority: '0',
  stackable: false,
  scope: BLANK_SCOPE,
};

function discountStateOf(rule: DiscountSummaryResponse): DiscountFormState {
  return {
    kind: rule.kind,
    code: rule.code ?? '',
    label: rule.label,
    type: rule.type,
    value: rule.value,
    currency: rule.currency ?? 'IRT',
    customerId: rule.customerId ?? '',
    firstPurchaseOnly: rule.firstPurchaseOnly,
    minimumSubtotal: rule.minimumSubtotalAmount ?? '',
    totalLimit: rule.totalRedemptionsLimit === null ? '' : String(rule.totalRedemptionsLimit),
    perCustomerLimit: rule.perCustomerLimit === null ? '' : String(rule.perCustomerLimit),
    priority: String(rule.priority),
    stackable: rule.stackable,
    scope: scopeStateOf(rule),
  };
}

const CODE_PATTERN = /^[A-Za-z0-9_-]+$/u;
const LIMIT_MAX = 1_000_000_000;

/**
 * The discount write body, or the field that is wrong.
 *
 * On an edit, `kind` and `code` are the STORED rule's, whatever the state holds: the
 * form draws them as text, and the server refuses a write that changes either.
 */
export function discountBodyFrom(
  state: DiscountFormState,
  stored?: DiscountSummaryResponse,
): { body: Omit<DiscountWriteInput, 'idempotencyKey'> } | { problem: WebKey } {
  const label = state.label.trim();
  if (label === '' || label.length > DISCOUNT_LABEL_MAX_LENGTH) {
    return { problem: 'web.rule_problem_label' };
  }

  const kind = stored?.kind ?? state.kind;
  let code: string | null = null;
  if (stored !== undefined) {
    code = stored.code;
  } else if (kind === 'CODE') {
    code = state.code.trim();
    if (
      code.length < DISCOUNT_CODE_MIN_LENGTH ||
      code.length > DISCOUNT_CODE_MAX_LENGTH ||
      !CODE_PATTERN.test(code)
    ) {
      return { problem: 'web.discount_problem_code' };
    }
  }

  const value = state.value.trim();
  if (state.type === 'PERCENTAGE') {
    if (wholeIn(value, DISCOUNT_PERCENTAGE_MIN, DISCOUNT_PERCENTAGE_MAX) === null) {
      return { problem: 'web.discount_problem_value_percentage' };
    }
  } else if (
    !/^\d{1,19}$/u.test(value) ||
    BigInt(value) <= 0n ||
    BigInt(value) > MAX_MONEY_AMOUNT_MINOR
  ) {
    return { problem: 'web.discount_problem_value_fixed' };
  }

  const scope = scopeBody(state.scope, stored);
  if ('problem' in scope) return scope;

  const customerId = state.customerId.trim();
  if (customerId !== '' && !isUuid(customerId)) {
    return { problem: 'web.discount_problem_customer' };
  }

  if (
    state.firstPurchaseOnly &&
    !(scope.body.appliesTo.length === 1 && scope.body.appliesTo[0] === 'NEW_SERVICE')
  ) {
    return { problem: 'web.discount_problem_first_purchase' };
  }

  const minimum = state.minimumSubtotal.trim();
  if (
    minimum !== '' &&
    (!/^\d{1,19}$/u.test(minimum) || BigInt(minimum) > MAX_MONEY_AMOUNT_MINOR)
  ) {
    return { problem: 'web.discount_problem_minimum' };
  }

  const totalLimit =
    state.totalLimit.trim() === '' ? null : wholeIn(state.totalLimit, 1, LIMIT_MAX);
  const perCustomerLimit =
    state.perCustomerLimit.trim() === '' ? null : wholeIn(state.perCustomerLimit, 1, LIMIT_MAX);
  if (
    (state.totalLimit.trim() !== '' && totalLimit === null) ||
    (state.perCustomerLimit.trim() !== '' && perCustomerLimit === null)
  ) {
    return { problem: 'web.discount_problem_limit' };
  }

  const priority = wholeIn(state.priority, DISCOUNT_PRIORITY_MIN, DISCOUNT_PRIORITY_MAX);
  if (priority === null) return { problem: 'web.discount_problem_priority' };

  return {
    body: {
      kind,
      code,
      label,
      type: state.type,
      // Stripped of leading zeros so `010` and `10` are one payload and one fingerprint.
      value: value.replace(/^0+(?=\d)/u, ''),
      // The pair moves together: a percentage carries no currency, a fixed amount one.
      currency: state.type === 'PERCENTAGE' ? null : state.currency,
      appliesTo: scope.body.appliesTo,
      productId: scope.body.productId,
      categoryId: scope.body.categoryId,
      customerId: customerId === '' ? null : customerId,
      firstPurchaseOnly: state.firstPurchaseOnly,
      minimumSubtotalAmount: minimum === '' ? null : minimum.replace(/^0+(?=\d)/u, ''),
      startsAt: scope.body.startsAt,
      endsAt: scope.body.endsAt,
      totalRedemptionsLimit: totalLimit,
      perCustomerLimit,
      priority,
      stackable: state.stackable,
    },
  };
}

function DiscountForm({
  rule,
  options,
  onDone,
}: {
  /** Absent for create; the stored rule for edit. */
  rule?: DiscountSummaryResponse;
  options: ScopeOptions;
  onDone: () => void;
}) {
  const mode = rule === undefined ? 'create' : 'edit';
  const prefix = `discount-${mode}`;
  const notify = useToast();
  const queries = useQueryClient();
  const submission = useSubmissionKey();
  const [state, setState] = useState<DiscountFormState>(
    rule === undefined ? BLANK_DISCOUNT : discountStateOf(rule),
  );
  const set = <K extends keyof DiscountFormState>(key: K, value: DiscountFormState[K]) =>
    setState((current) => ({ ...current, [key]: value }));

  const checked = discountBodyFrom(state, rule);
  const problem = 'problem' in checked ? checked.problem : null;

  const save = useMutation({
    mutationFn: () => {
      if ('problem' in checked) throw new Error('unreachable: guarded by the submit button');
      // Bound to the payload AND the rule, so a corrected field is a NEW command.
      const idempotencyKey = submission.current({ id: rule?.id ?? null, ...checked.body });
      return rule === undefined
        ? createDiscount({ ...checked.body, idempotencyKey })
        : updateDiscount({ ...checked.body, id: rule.id, idempotencyKey });
    },
    onSuccess: () => {
      submission.settle();
      notify({
        tone: 'ok',
        message: mode === 'create' ? t('web.discount_created') : t('web.discount_saved'),
      });
      if (mode === 'create') setState(BLANK_DISCOUNT);
      void queries.invalidateQueries({ queryKey: ['discounts'] });
      onDone();
    },
    onError: (error) => submission.settleOn(error),
  });

  /** A stored currency outside the sales list stays selectable, so an edit keeps it. */
  const currencies: readonly CurrencyCode[] = (
    SALES_CURRENCY_CODES as readonly CurrencyCode[]
  ).concat(
    rule?.currency != null && !(SALES_CURRENCY_CODES as readonly string[]).includes(rule.currency)
      ? [rule.currency]
      : [],
  );

  return (
    <Card title={mode === 'create' ? t('web.discount_new_title') : t('web.discount_edit_title')}>
      {rule === undefined ? (
        <>
          <Field
            label={t('web.discount_kind')}
            hint={t('web.discount_kind_hint')}
            htmlFor={`${prefix}-kind`}
          >
            <select
              id={`${prefix}-kind`}
              value={state.kind}
              onChange={(event) => set('kind', event.target.value as DiscountKind)}
            >
              <option value="CODE">{t('web.discount_kind_code')}</option>
              <option value="AUTOMATIC">{t('web.discount_kind_automatic')}</option>
            </select>
          </Field>
          {state.kind === 'CODE' && (
            <Field
              label={t('web.discount_code')}
              hint={t('web.discount_code_hint')}
              htmlFor={`${prefix}-code`}
            >
              <input
                id={`${prefix}-code`}
                dir="ltr"
                value={state.code}
                maxLength={DISCOUNT_CODE_MAX_LENGTH}
                onChange={(event) => set('code', event.target.value)}
              />
            </Field>
          )}
        </>
      ) : (
        /*
         * TEXT, not a disabled input. A disabled control says "you may not change this
         * now"; the truth is that nobody ever may, and the sentence below says why.
         */
        <>
          <KV
            items={[
              [t('web.discount_kind'), t(KIND_LABELS[rule.kind])],
              [
                t('web.discount_code'),
                rule.code === null ? <Dash key="c" /> : <Ltr key="c">{rule.code}</Ltr>,
              ],
            ]}
          />
          <p className="muted small">{t('web.discount_kind_locked')}</p>
        </>
      )}

      <Field
        label={t('web.rule_label')}
        hint={t('web.rule_label_hint')}
        htmlFor={`${prefix}-label`}
      >
        <input
          id={`${prefix}-label`}
          value={state.label}
          maxLength={DISCOUNT_LABEL_MAX_LENGTH}
          onChange={(event) => set('label', event.target.value)}
        />
      </Field>

      <Field label={t('web.discount_type')} htmlFor={`${prefix}-type`}>
        <select
          id={`${prefix}-type`}
          value={state.type}
          onChange={(event) => set('type', event.target.value as DiscountType)}
        >
          <option value="PERCENTAGE">{t('web.discount_type_percentage')}</option>
          <option value="FIXED_AMOUNT">{t('web.discount_type_fixed')}</option>
        </select>
      </Field>

      <Field
        label={t('web.discount_value')}
        hint={t(
          state.type === 'PERCENTAGE'
            ? 'web.discount_value_hint_percentage'
            : 'web.discount_value_hint_fixed',
        )}
        htmlFor={`${prefix}-value`}
      >
        <input
          id={`${prefix}-value`}
          dir="ltr"
          inputMode="numeric"
          value={state.value}
          onChange={(event) => set('value', event.target.value.trim())}
        />
      </Field>

      {state.type === 'FIXED_AMOUNT' && (
        <Field label={t('web.discount_currency')} htmlFor={`${prefix}-currency`}>
          <select
            id={`${prefix}-currency`}
            value={state.currency}
            onChange={(event) => set('currency', event.target.value as CurrencyCode)}
          >
            {currencies.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </Field>
      )}

      <ScopeFields
        prefix={prefix}
        value={state.scope}
        onChange={(next) => set('scope', next)}
        options={options}
      />

      <Field
        label={t('web.discount_customer')}
        hint={t('web.discount_customer_hint')}
        htmlFor={`${prefix}-customer`}
      >
        <input
          id={`${prefix}-customer`}
          dir="ltr"
          value={state.customerId}
          onChange={(event) => set('customerId', event.target.value.trim())}
        />
      </Field>

      <Field
        label={t('web.discount_first_purchase')}
        hint={t('web.discount_first_purchase_hint')}
        htmlFor={`${prefix}-first`}
      >
        <input
          id={`${prefix}-first`}
          type="checkbox"
          checked={state.firstPurchaseOnly}
          onChange={(event) => set('firstPurchaseOnly', event.target.checked)}
        />
      </Field>

      <Field
        label={t('web.discount_minimum')}
        hint={t('web.discount_minimum_hint')}
        htmlFor={`${prefix}-minimum`}
      >
        <input
          id={`${prefix}-minimum`}
          dir="ltr"
          inputMode="numeric"
          value={state.minimumSubtotal}
          onChange={(event) => set('minimumSubtotal', event.target.value.trim())}
        />
      </Field>

      <Field
        label={t('web.discount_total_limit')}
        hint={t('web.discount_limit_hint')}
        htmlFor={`${prefix}-total-limit`}
      >
        <input
          id={`${prefix}-total-limit`}
          dir="ltr"
          inputMode="numeric"
          value={state.totalLimit}
          onChange={(event) => set('totalLimit', event.target.value.trim())}
        />
      </Field>
      <Field label={t('web.discount_per_customer_limit')} htmlFor={`${prefix}-customer-limit`}>
        <input
          id={`${prefix}-customer-limit`}
          dir="ltr"
          inputMode="numeric"
          value={state.perCustomerLimit}
          onChange={(event) => set('perCustomerLimit', event.target.value.trim())}
        />
      </Field>

      <Field
        label={t('web.discount_priority')}
        hint={t('web.discount_priority_hint')}
        htmlFor={`${prefix}-priority`}
      >
        <input
          id={`${prefix}-priority`}
          dir="ltr"
          inputMode="numeric"
          value={state.priority}
          onChange={(event) => set('priority', event.target.value.trim())}
        />
      </Field>
      <Field
        label={t('web.discount_stackable')}
        hint={t('web.discount_stackable_hint')}
        htmlFor={`${prefix}-stackable`}
      >
        <input
          id={`${prefix}-stackable`}
          type="checkbox"
          checked={state.stackable}
          onChange={(event) => set('stackable', event.target.checked)}
        />
      </Field>

      {problem !== null && <Banner tone="warn">{t(problem)}</Banner>}

      <div className="toolbar">
        <button
          type="button"
          className="btn primary sm"
          disabled={problem !== null || save.isPending}
          onClick={() => save.mutate()}
        >
          {mode === 'create' ? t('web.discount_create') : t('web.rule_save')}
        </button>
        {mode === 'edit' && (
          <button type="button" className="btn sm" disabled={save.isPending} onClick={onDone}>
            {t('web.rule_cancel_edit')}
          </button>
        )}
      </div>
      {mode === 'create' && <p className="muted small">{t('web.rule_created_inactive')}</p>}
      {save.error !== null && <Banner tone="danger">{messageFor(save.error)}</Banner>}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Cashback rules
// ---------------------------------------------------------------------------

function CashbackRules({
  denied,
  mayEdit,
  options,
}: {
  denied: boolean;
  mayEdit: boolean;
  options: ScopeOptions;
}) {
  const queries = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();

  const [status, setStatus] = useState<StatusFilter>('ALL');
  const trail = useTrail(status);

  const rules = useQuery({
    queryKey: ['cashback-rules', status, trail.cursor ?? null],
    queryFn: () =>
      fetchCashbackRules({
        ...(trail.cursor === undefined ? {} : { cursor: trail.cursor }),
        ...(status === 'ALL' ? {} : { status }),
      }),
    enabled: !denied,
  });
  const rows = rules.data?.rules ?? [];
  const nextCursor = rules.data?.nextCursor ?? null;

  const [editing, setEditing] = useState<CashbackRuleSummaryResponse | null>(null);

  const transition = useMutation({
    mutationFn: (input: { id: string; which: 'activate' | 'deactivate' }) =>
      transitionCashbackRule({ ...input, idempotencyKey: submission.current(input) }),
    onSuccess: (_response, input) => {
      submission.settle();
      notify({
        tone: 'ok',
        message:
          input.which === 'activate' ? t('web.cashback_activated') : t('web.cashback_deactivated'),
      });
      void queries.invalidateQueries({ queryKey: ['cashback-rules'] });
    },
    onError: (error) => submission.settleOn(error),
  });

  const columns: readonly Column<CashbackRuleSummaryResponse>[] = [
    { key: 'label', header: t('web.rule_label'), render: (row) => <strong>{row.label}</strong> },
    {
      key: 'percent',
      header: t('web.cashback_percent'),
      render: (row) => (
        <span className="nowrap">
          <Ltr>{String(row.percent)}</Ltr> {t('web.discount_percent_unit')}
        </span>
      ),
    },
    {
      key: 'scope',
      header: t('web.rule_scope'),
      render: (row) => (
        <ScopeCell
          appliesTo={row.appliesTo}
          productId={row.productId}
          categoryId={row.categoryId}
          options={options}
        />
      ),
    },
    {
      key: 'window',
      header: t('web.rule_window'),
      render: (row) => <WindowCell startsAt={row.startsAt} endsAt={row.endsAt} />,
    },
    { key: 'status', header: t('web.status'), render: (row) => <StatusBadge value={row.status} /> },
    {
      key: 'actions',
      header: t('web.rule_actions'),
      align: 'end',
      render: (row) =>
        !mayEdit ? null : (
          <div className="toolbar">
            <button
              type="button"
              className="btn sm"
              disabled={transition.isPending}
              onClick={() => setEditing(row)}
            >
              {t('web.rule_edit')}
            </button>
            <button
              type="button"
              className={row.status === 'ACTIVE' ? 'btn danger sm' : 'btn primary sm'}
              disabled={transition.isPending}
              onClick={() =>
                transition.mutate({
                  id: row.id,
                  which: row.status === 'ACTIVE' ? 'deactivate' : 'activate',
                })
              }
            >
              {t(row.status === 'ACTIVE' ? 'web.rule_deactivate' : 'web.rule_activate')}
            </button>
          </div>
        ),
    },
  ];

  return (
    <>
      <Card title={t('web.cashback_rules_title')} hint={t('web.cashback_rules_hint')}>
        <div className="toolbar" hidden={!mayRequest(rules, denied)}>
          <Pills
            value={status}
            onChange={setStatus}
            items={[
              { id: 'ALL' as const, label: t('web.rule_status_all') },
              { id: 'ACTIVE' as const, label: t('web.rule_status_active') },
              { id: 'INACTIVE' as const, label: t('web.rule_status_inactive') },
            ]}
          />
        </div>

        <StateSwitch
          query={rules}
          denied={denied}
          isEmpty={rows.length === 0 && trail.depth === 0}
          empty={
            status !== 'ALL' ? (
              <Empty title={t('web.discounts_filter_empty')} icon="inbox" />
            ) : (
              <Empty title={t('web.cashback_empty')} icon="discounts" />
            )
          }
        >
          <DataTable
            caption={t('web.cashback_rules_title')}
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
          />
          <CursorPager
            shown={rows.length}
            hasPrevious={trail.depth > 0}
            hasNext={nextCursor !== null}
            onPrevious={trail.pop}
            onNext={() => nextCursor !== null && trail.push(nextCursor)}
            nextLabel="web.newer"
            previousLabel="web.older"
          />
        </StateSwitch>

        {transition.error !== null && <Banner tone="danger">{messageFor(transition.error)}</Banner>}
      </Card>

      {!mayEdit ? (
        <Card title={t('web.cashback_new_title')}>
          <Banner tone="info">{t('web.cashback_edit_denied')}</Banner>
        </Card>
      ) : editing !== null ? (
        <CashbackForm
          key={editing.id}
          rule={editing}
          options={options}
          onDone={() => setEditing(null)}
        />
      ) : (
        <CashbackForm options={options} onDone={() => undefined} />
      )}
    </>
  );
}

interface CashbackFormState {
  label: string;
  percent: string;
  scope: ScopeState;
}

const BLANK_CASHBACK: CashbackFormState = { label: '', percent: '', scope: BLANK_SCOPE };

export function cashbackBodyFrom(
  state: CashbackFormState,
  stored?: CashbackRuleSummaryResponse,
): { body: Omit<CashbackRuleWriteInput, 'idempotencyKey'> } | { problem: WebKey } {
  const label = state.label.trim();
  if (label === '' || label.length > DISCOUNT_LABEL_MAX_LENGTH) {
    return { problem: 'web.rule_problem_label' };
  }
  const percent = wholeIn(state.percent, CASHBACK_PERCENT_MIN, CASHBACK_PERCENT_MAX);
  if (percent === null) return { problem: 'web.cashback_problem_percent' };
  const scope = scopeBody(state.scope, stored);
  if ('problem' in scope) return scope;
  return { body: { label, percent, ...scope.body } };
}

function CashbackForm({
  rule,
  options,
  onDone,
}: {
  rule?: CashbackRuleSummaryResponse;
  options: ScopeOptions;
  onDone: () => void;
}) {
  const mode = rule === undefined ? 'create' : 'edit';
  const prefix = `cashback-${mode}`;
  const notify = useToast();
  const queries = useQueryClient();
  const submission = useSubmissionKey();
  const [state, setState] = useState<CashbackFormState>(
    rule === undefined
      ? BLANK_CASHBACK
      : { label: rule.label, percent: String(rule.percent), scope: scopeStateOf(rule) },
  );

  const checked = cashbackBodyFrom(state, rule);
  const problem = 'problem' in checked ? checked.problem : null;

  const save = useMutation({
    mutationFn: () => {
      if ('problem' in checked) throw new Error('unreachable: guarded by the submit button');
      const idempotencyKey = submission.current({ id: rule?.id ?? null, ...checked.body });
      return rule === undefined
        ? createCashbackRule({ ...checked.body, idempotencyKey })
        : updateCashbackRule({ ...checked.body, id: rule.id, idempotencyKey });
    },
    onSuccess: () => {
      submission.settle();
      notify({
        tone: 'ok',
        message: mode === 'create' ? t('web.cashback_created') : t('web.cashback_saved'),
      });
      if (mode === 'create') setState(BLANK_CASHBACK);
      void queries.invalidateQueries({ queryKey: ['cashback-rules'] });
      onDone();
    },
    onError: (error) => submission.settleOn(error),
  });

  return (
    <Card title={mode === 'create' ? t('web.cashback_new_title') : t('web.cashback_edit_title')}>
      <Field
        label={t('web.rule_label')}
        hint={t('web.rule_label_hint')}
        htmlFor={`${prefix}-label`}
      >
        <input
          id={`${prefix}-label`}
          value={state.label}
          maxLength={DISCOUNT_LABEL_MAX_LENGTH}
          onChange={(event) => setState({ ...state, label: event.target.value })}
        />
      </Field>
      <Field
        label={t('web.cashback_percent')}
        hint={t('web.cashback_percent_hint')}
        htmlFor={`${prefix}-percent`}
      >
        <input
          id={`${prefix}-percent`}
          dir="ltr"
          inputMode="numeric"
          value={state.percent}
          onChange={(event) => setState({ ...state, percent: event.target.value.trim() })}
        />
      </Field>
      <ScopeFields
        prefix={prefix}
        value={state.scope}
        onChange={(next) => setState({ ...state, scope: next })}
        options={options}
      />

      {problem !== null && <Banner tone="warn">{t(problem)}</Banner>}

      <div className="toolbar">
        <button
          type="button"
          className="btn primary sm"
          disabled={problem !== null || save.isPending}
          onClick={() => save.mutate()}
        >
          {mode === 'create' ? t('web.cashback_create') : t('web.rule_save')}
        </button>
        {mode === 'edit' && (
          <button type="button" className="btn sm" disabled={save.isPending} onClick={onDone}>
            {t('web.rule_cancel_edit')}
          </button>
        )}
      </div>
      {mode === 'create' && <p className="muted small">{t('web.rule_created_inactive')}</p>}
      {save.error !== null && <Banner tone="danger">{messageFor(save.error)}</Banner>}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The price preview
// ---------------------------------------------------------------------------

interface PreviewQuery {
  purpose: DiscountablePurpose;
  productId?: string;
  addonId?: string;
  customerId?: string;
  code?: string;
}

/** A purchase or a renewal is priced from a product; the other two from an add-on. */
function pricedFromProduct(purpose: DiscountablePurpose): boolean {
  return purpose === 'NEW_SERVICE' || purpose === 'RENEW';
}

function PricePreview({ denied, options }: { denied: boolean; options: ScopeOptions }) {
  const [purpose, setPurpose] = useState<DiscountablePurpose>('NEW_SERVICE');
  const [productId, setProductId] = useState('');
  const [addonId, setAddonId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [code, setCode] = useState('');
  /** What was last ASKED. The form can change without re-asking; the answer cannot. */
  const [asked, setAsked] = useState<PreviewQuery | null>(null);

  const preview = useQuery({
    queryKey: ['price-preview', asked],
    queryFn: () => fetchPricePreview(asked as PreviewQuery),
    enabled: !denied && asked !== null,
  });

  let problem: WebKey | null = null;
  if (pricedFromProduct(purpose) && !isUuid(productId.trim())) {
    problem = 'web.rule_problem_product';
  } else if (!pricedFromProduct(purpose) && !isUuid(addonId.trim())) {
    problem = 'web.preview_problem_addon';
  } else if (customerId.trim() !== '' && !isUuid(customerId.trim())) {
    problem = 'web.discount_problem_customer';
  }

  const run = () => {
    if (problem !== null) return;
    setAsked({
      purpose,
      ...(pricedFromProduct(purpose)
        ? { productId: productId.trim() }
        : { addonId: addonId.trim() }),
      ...(customerId.trim() === '' ? {} : { customerId: customerId.trim() }),
      ...(code.trim() === '' ? {} : { code: code.trim() }),
    });
  };

  if (denied) {
    return (
      <Card title={t('web.preview_title')}>
        <Empty title={t('web.no_permission')} hint={t('web.no_permission_hint')} icon="lock" />
      </Card>
    );
  }

  return (
    <Card title={t('web.preview_title')} hint={t('web.preview_hint')}>
      <Field label={t('web.preview_purpose')} htmlFor="preview-purpose">
        <select
          id="preview-purpose"
          value={purpose}
          onChange={(event) => setPurpose(event.target.value as DiscountablePurpose)}
        >
          {DISCOUNTABLE_PURPOSES.map((one) => (
            <option key={one} value={one}>
              {t(PURPOSE_LABELS[one])}
            </option>
          ))}
        </select>
      </Field>

      {pricedFromProduct(purpose) ? (
        <Field
          label={t('web.preview_product')}
          htmlFor="preview-product"
          {...(options.products === null ? { hint: t('web.rule_product_unreadable') } : {})}
        >
          {options.products === null ? (
            <input
              id="preview-product"
              dir="ltr"
              value={productId}
              onChange={(event) => setProductId(event.target.value.trim())}
            />
          ) : (
            <select
              id="preview-product"
              value={productId}
              onChange={(event) => setProductId(event.target.value)}
            >
              <option value="" />
              {options.products.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.title}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : (
        <Field
          label={t('web.preview_addon')}
          hint={t('web.preview_addon_hint')}
          htmlFor="preview-addon"
        >
          <input
            id="preview-addon"
            dir="ltr"
            value={addonId}
            onChange={(event) => setAddonId(event.target.value.trim())}
          />
        </Field>
      )}

      <Field
        label={t('web.preview_customer')}
        hint={t('web.preview_customer_hint')}
        htmlFor="preview-customer"
      >
        <input
          id="preview-customer"
          dir="ltr"
          value={customerId}
          onChange={(event) => setCustomerId(event.target.value.trim())}
        />
      </Field>
      <Field label={t('web.preview_code')} hint={t('web.preview_code_hint')} htmlFor="preview-code">
        <input
          id="preview-code"
          dir="ltr"
          value={code}
          maxLength={DISCOUNT_CODE_MAX_LENGTH}
          onChange={(event) => setCode(event.target.value)}
        />
      </Field>

      <div className="toolbar">
        <button type="button" className="btn primary sm" disabled={problem !== null} onClick={run}>
          {t('web.preview_run')}
        </button>
      </div>

      {asked !== null && (
        <StateSwitch query={preview}>
          {preview.data === undefined ? null : <PreviewResult result={preview.data} />}
        </StateSwitch>
      )}
    </Card>
  );
}

function PreviewResult({ result }: { result: PricePreviewResponse }) {
  const cashback = result.quote.cashback;
  const columns: readonly Column<PricePreviewResponse['rules'][number]>[] = [
    { key: 'label', header: t('web.rule_label'), render: (row) => row.label },
    {
      key: 'kind',
      header: t('web.discount_kind'),
      render: (row) => t(KIND_LABELS[row.kind]),
    },
    {
      key: 'outcome',
      header: t('web.preview_outcome'),
      render: (row) => (
        <Badge tone={OUTCOME_TONES[row.outcome]}>{t(OUTCOME_LABELS[row.outcome])}</Badge>
      ),
    },
    {
      key: 'reason',
      header: t('web.preview_reason'),
      render: (row) => (row.reason === null ? <Dash /> : t(REASON_LABELS[row.reason])),
    },
  ];

  return (
    <>
      <KV
        items={[
          [
            t('web.order_subtotal'),
            <Money
              key="s"
              value={{ amountMinor: result.subtotalAmount, currency: result.currency }}
            />,
          ],
          [
            t('web.order_discount'),
            <Money
              key="d"
              value={{ amountMinor: result.discountAmount, currency: result.currency }}
            />,
          ],
          [
            t('web.order_total'),
            <Money
              key="t"
              value={{ amountMinor: result.totalAmount, currency: result.currency }}
            />,
          ],
          [
            t('web.preview_cashback'),
            cashback === undefined ? (
              <span key="c" className="muted">
                {t('web.preview_no_cashback')}
              </span>
            ) : (
              <span key="c">
                {cashback.ruleLabel} — <Ltr>{String(cashback.percent)}</Ltr>{' '}
                {t('web.discount_percent_unit')} — <Money value={cashback.amount} />
              </span>
            ),
          ],
          ...(result.code === null
            ? []
            : [
                [
                  t('web.preview_code_verdict'),
                  <span key="v">
                    <Badge tone={result.code.accepted ? 'ok' : 'danger'}>
                      {t(
                        result.code.accepted
                          ? 'web.preview_code_accepted'
                          : 'web.preview_code_refused',
                      )}
                    </Badge>
                    {result.code.reason !== null && <> {t(REASON_LABELS[result.code.reason])}</>}
                  </span>,
                ] as [ReactNode, ReactNode],
              ]),
        ]}
      />

      <h3>{t('web.preview_rules_title')}</h3>
      {result.rules.length === 0 ? (
        <Empty title={t('web.preview_rules_empty')} />
      ) : (
        <DataTable
          caption={t('web.preview_rules_title')}
          columns={columns}
          rows={result.rules}
          rowKey={(row) => row.discountId}
        />
      )}
      <p className="muted small">{t('web.preview_reason_note')}</p>
    </>
  );
}
