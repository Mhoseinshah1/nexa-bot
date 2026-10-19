import { useState, type ClipboardEvent } from 'react';
import { useInfiniteQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import {
  MAX_MONEY_AMOUNT_MINOR,
  RESELLER_TIER_PRICES_PAGE_DEFAULT,
  RESELLER_TIER_PRICES_WRITE_MAX,
  type MoneyWire,
  type ResellerTierProductPriceRow,
  type ResellerTierProductPricesWriteRequest,
  type ResellerTierSummaryResponse,
} from '@nexa/contracts';
import { fetchResellerTierPrices, setResellerTierPrices } from '../api/client';
import { useSubmissionKey, type SubmissionKey } from '../submission-key';
import { t, type WebKey } from '../i18n/web.fa';
import { messageFor } from './settings';
import {
  Badge,
  Banner,
  Button,
  Card,
  DataTable,
  Empty,
  Money,
  Num,
  StateSwitch,
  useReportDirty,
  useToast,
  useUnsavedChanges,
  type Column,
} from '../ui/kit';
import { formatNumber } from '../format';
import { SaveBar } from './editor-layout';
import { ErrorRef } from '../ui/technical-details';
import { latinDigits } from '../ui/jalali';

/**
 * «قیمت محصولات» — a `FIXED_PRICE_TABLE` tier's exact price per product (Round 4 PR-G).
 *
 * Every product, grouped by category in the server's keyset order (category, then product;
 * «بارگذاری بیشتر» reads the next page by its cursor — never an offset, never a client
 * count). Beside each: the list price, the tier price as an editable figure, and the margin
 * `list − tier`, which is a display: what a reseller is CHARGED is the pricing boundary's
 * answer at checkout, and a tier price above list charges the list.
 *
 * A category's «اعمال به همه» fills the tier price of every LOADED product of that category
 * with one figure; pasting a column copied from a spreadsheet into a price fills that row and
 * the ones below it, one line each. Neither saves anything: the operator reviews the column
 * and saves, and the save sends only the rows that changed. An empty figure clears the
 * tier's price (the product becomes unpriced for the tier).
 *
 * `resellers.view` and `catalog.view` read; `resellers.edit` saves. A page without
 * `catalog.view` issues no request and says which permission it lacks.
 */

// ---------------------------------------------------------------------------
// Pure helpers (tested)
// ---------------------------------------------------------------------------

/**
 * A typed tier price: `null` for an empty figure (clear the price), the amount in whole
 * minor units as a digit string, or `'INVALID'`. Persian and Arabic digits and the grouping
 * a spreadsheet adds (`,` `٬` spaces) are accepted; never parsed to a `number`.
 */
export function tierPriceAmountOf(raw: string): string | null | 'INVALID' {
  const text = latinDigits(raw).replace(/[\s,\u066C]/gu, '');
  if (text === '') return null;
  if (!/^\d{1,19}$/u.test(text)) return 'INVALID';
  const amount = BigInt(text);
  if (amount < 1n || amount > MAX_MONEY_AMOUNT_MINOR) return 'INVALID';
  return amount.toString();
}

/**
 * A column pasted from a spreadsheet: one figure per line, the LAST non-empty cell of each
 * (a copied «title ⇥ price» pair gives its price). A trailing empty line — what a copied
 * range ends with — is dropped.
 */
export function pastedColumn(text: string): string[] {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  if (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop();
  return lines.map((line) => {
    const cells = line.split('\t').map((cell) => cell.trim());
    for (let i = cells.length - 1; i >= 0; i -= 1) {
      if (cells[i] !== '') return cells[i] as string;
    }
    return '';
  });
}

/** `list − tier`, in the list's currency; null when either is missing or not a figure. */
export function marginOf(
  list: { readonly amount: string; readonly currency: MoneyWire['currency'] } | null,
  tierAmount: string | null,
): MoneyWire | null {
  if (list === null || tierAmount === null) return null;
  return {
    amountMinor: (BigInt(list.amount) - BigInt(tierAmount)).toString(),
    currency: list.currency,
  };
}

export interface CategoryGroup {
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly rows: readonly ResellerTierProductPriceRow[];
}

/** The rows in their server order, one group per run of one category. */
export function groupByCategory(rows: readonly ResellerTierProductPriceRow[]): CategoryGroup[] {
  const groups: {
    categoryId: string | null;
    categoryName: string | null;
    rows: ResellerTierProductPriceRow[];
  }[] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.categoryId === row.categoryId) last.rows.push(row);
    else groups.push({ categoryId: row.categoryId, categoryName: row.categoryName, rows: [row] });
  }
  return groups;
}

/** The server's figure for a row, as the editor draws it. */
function storedText(row: ResellerTierProductPriceRow): string {
  return row.tierPrice === null ? '' : row.tierPrice.amount;
}

/**
 * The edits to send: every row whose typed figure differs from the stored one, in the list
 * price's currency (the server refuses any other), or the problem that blocks saving.
 */
export function priceChangesOf(
  rows: readonly ResellerTierProductPriceRow[],
  drafts: ReadonlyMap<string, string>,
):
  | { readonly prices: ResellerTierProductPricesWriteRequest['prices'] }
  | { readonly problem: WebKey } {
  const prices: ResellerTierProductPricesWriteRequest['prices'][number][] = [];
  for (const row of rows) {
    const draft = drafts.get(row.productId);
    if (draft === undefined) continue;
    const amount = tierPriceAmountOf(draft);
    if (amount === 'INVALID') return { problem: 'web.tier_prices_problem_amount' };
    const stored = row.tierPrice === null ? null : row.tierPrice.amount;
    if (amount === stored) continue;
    if (amount === null) {
      prices.push({ productId: row.productId, price: null });
      continue;
    }
    if (row.listPrice === null) return { problem: 'web.tier_prices_problem_unpriced' };
    prices.push({
      productId: row.productId,
      price: { amount, currency: row.listPrice.currency },
    });
  }
  if (prices.length > RESELLER_TIER_PRICES_WRITE_MAX) {
    return { problem: 'web.tier_prices_problem_too_many' };
  }
  return { prices };
}

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

export function TierPricesEditor({
  tier,
  mayEdit,
  mayViewCatalog,
  held,
  onDirtyChange,
}: {
  tier: ResellerTierSummaryResponse;
  /** `resellers.edit`. */
  mayEdit: boolean;
  /** `catalog.view` — the table lists the catalogue's products and list prices. */
  mayViewCatalog: boolean;
  /** Held by the always-mounted page: a retry after a 5xx keeps its key. */
  held?: SubmissionKey | undefined;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const notify = useToast();
  const queries = useQueryClient();
  const own = useSubmissionKey();
  const submission = held ?? own;
  const pages = useInfiniteQuery({
    queryKey: ['reseller-tier-prices', tier.id],
    queryFn: ({ pageParam }) =>
      fetchResellerTierPrices(tier.id, {
        limit: RESELLER_TIER_PRICES_PAGE_DEFAULT,
        ...(pageParam === undefined ? {} : { cursor: pageParam }),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: mayViewCatalog,
  });
  const rows = (pages.data?.pages ?? []).flatMap((page) => page.items);
  const groups = groupByCategory(rows);

  /** Typed figures, by product; a product absent here shows its stored figure. */
  const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(new Map());
  /** The bulk-fill figure of each category, by category id (`''` for none). */
  const [fills, setFills] = useState<ReadonlyMap<string, string>>(new Map());
  const changes = priceChangesOf(rows, drafts);
  const dirty = 'prices' in changes ? changes.prices.length > 0 : true;
  useUnsavedChanges(dirty);
  useReportDirty(dirty, onDirtyChange);

  const textOf = (row: ResellerTierProductPriceRow) => drafts.get(row.productId) ?? storedText(row);
  const setText = (updates: readonly (readonly [string, string])[]) =>
    setDrafts((current) => {
      const next = new Map(current);
      for (const [id, text] of updates) next.set(id, text);
      return next;
    });

  /** A pasted column fills this row and the editable rows after it, in table order. */
  const onPaste = (row: ResellerTierProductPriceRow, event: ClipboardEvent<HTMLInputElement>) => {
    const column = pastedColumn(event.clipboardData.getData('text/plain'));
    if (column.length < 2) return; // One figure: the browser's own paste is right.
    event.preventDefault();
    const editable = rows.filter((one) => one.listPrice !== null);
    const start = editable.findIndex((one) => one.productId === row.productId);
    if (start === -1) return;
    const targets = editable.slice(start, start + column.length);
    setText(targets.map((one, index) => [one.productId, column[index] ?? ''] as const));
    notify({
      tone: 'info',
      message: `${t('web.tier_prices_pasted')} ${formatNumber(targets.length)}`,
    });
  };

  const fillGroup = (group: CategoryGroup) => {
    const key = group.categoryId ?? '';
    const figure = fills.get(key) ?? '';
    const editable = group.rows.filter((one) => one.listPrice !== null);
    setText(editable.map((one) => [one.productId, figure] as const));
  };

  const save = useMutation({
    mutationFn: () => {
      if (!('prices' in changes)) throw new Error('unreachable: guarded by the submit button');
      const idempotencyKey = submission.current({ id: tier.id, prices: changes.prices });
      return setResellerTierPrices({ id: tier.id, idempotencyKey, prices: changes.prices });
    },
    onSuccess: (result) => {
      submission.settle();
      setDrafts(new Map());
      notify({
        tone: 'ok',
        message: [
          t('web.tier_prices_saved'),
          `${t('web.tier_prices_saved_set')} ${formatNumber(result.set)}`,
          `${t('web.tier_prices_saved_cleared')} ${formatNumber(result.cleared)}`,
        ].join(t('web.list_separator')),
      });
      void queries.invalidateQueries({ queryKey: ['reseller-tier-prices', tier.id] });
      void queries.invalidateQueries({ queryKey: ['reseller-tier-history'] });
    },
    onError: (error) => submission.settleOn(error),
  });

  if (!mayViewCatalog) {
    return (
      <Card title={`${t('web.tier_prices_title')} — ${tier.name}`}>
        <Banner tone="info">{t('web.tier_prices_catalog_denied')}</Banner>
      </Card>
    );
  }

  const problem = 'problem' in changes ? changes.problem : null;

  const columns: readonly Column<ResellerTierProductPriceRow>[] = [
    {
      key: 'product',
      header: t('web.tier_prices_product'),
      render: (row) => (
        <>
          <label htmlFor={`tier-price-${row.productId}`}>{row.title}</label>
          {row.status !== 'ACTIVE' && (
            <>
              {' '}
              <Badge tone="neutral">{t('web.tier_prices_inactive')}</Badge>
            </>
          )}
        </>
      ),
    },
    {
      key: 'list',
      header: t('web.tier_prices_list'),
      align: 'end',
      render: (row) =>
        row.listPrice === null ? (
          '—'
        ) : (
          <Money value={{ amountMinor: row.listPrice.amount, currency: row.listPrice.currency }} />
        ),
    },
    {
      key: 'tier',
      header: t('web.tier_prices_tier'),
      align: 'end',
      render: (row) => {
        const amount = tierPriceAmountOf(textOf(row));
        return (
          <input
            id={`tier-price-${row.productId}`}
            className={
              amount === 'INVALID'
                ? 'input sm tier-price-input invalid'
                : 'input sm tier-price-input'
            }
            dir="ltr"
            inputMode="numeric"
            aria-invalid={amount === 'INVALID'}
            disabled={!mayEdit || row.listPrice === null}
            value={textOf(row)}
            onChange={(event) => setText([[row.productId, event.target.value] as const])}
            onPaste={(event) => onPaste(row, event)}
          />
        );
      },
    },
    {
      key: 'margin',
      header: t('web.tier_prices_margin'),
      align: 'end',
      render: (row) => {
        const amount = tierPriceAmountOf(textOf(row));
        const margin = amount === 'INVALID' ? null : marginOf(row.listPrice, amount);
        if (margin === null) return '—';
        return BigInt(margin.amountMinor) < 0n ? (
          <span className="danger">
            <Money value={margin} /> {t('web.tier_prices_above_list')}
          </span>
        ) : (
          <Money value={margin} />
        );
      },
    },
  ];

  return (
    <Card
      className="tier-prices"
      title={`${t('web.tier_prices_title')} — ${tier.name}`}
      hint={t('web.tier_prices_hint')}
    >
      {tier.pricingMode !== 'FIXED_PRICE_TABLE' && (
        <Banner tone="warn">{t('web.tier_prices_mode_not_table')}</Banner>
      )}
      {tier.pricingMode === 'FIXED_PRICE_TABLE' && (
        <p className="muted small">
          {tier.unpricedListFallback
            ? t('web.tier_prices_fallback_on')
            : t('web.tier_prices_fallback_off')}
        </p>
      )}
      {!mayEdit && <Banner tone="info">{t('web.tier_prices_edit_denied')}</Banner>}
      <StateSwitch
        query={pages}
        denied={false}
        isEmpty={rows.length === 0}
        empty={<Empty title={t('web.tier_prices_empty')} icon="products" />}
      >
        {groups.map((group) => {
          const key = group.categoryId ?? '';
          const fillId = `tier-fill-${tier.id}-${key === '' ? 'none' : key}`;
          return (
            <section className="tier-prices-group" key={`${key}:${group.rows[0]?.productId ?? ''}`}>
              <div className="tier-prices-group-head">
                <h3 className="strong">{group.categoryName ?? t('web.tier_prices_no_category')}</h3>
                {mayEdit && (
                  <div className="tier-prices-fill">
                    <label htmlFor={fillId} className="muted small">
                      {t('web.tier_prices_fill_label')}
                    </label>
                    <input
                      id={fillId}
                      className="input sm"
                      dir="ltr"
                      inputMode="numeric"
                      value={fills.get(key) ?? ''}
                      onChange={(event) =>
                        setFills((current) => new Map(current).set(key, event.target.value))
                      }
                    />
                    <Button size="sm" onClick={() => fillGroup(group)}>
                      {t('web.tier_prices_fill_apply')}
                    </Button>
                  </div>
                )}
              </div>
              <DataTable
                stack="labelled"
                caption={group.categoryName ?? t('web.tier_prices_no_category')}
                columns={columns}
                rows={group.rows}
                rowKey={(row) => row.productId}
              />
            </section>
          );
        })}
        <div className="tier-prices-more">
          <span className="muted small">
            {t('web.showing')} <Num value={rows.length} />
          </span>
          {pages.hasNextPage && (
            <Button
              size="sm"
              disabled={pages.isFetchingNextPage}
              onClick={() => void pages.fetchNextPage()}
            >
              {t('web.tier_prices_more')}
            </Button>
          )}
        </div>
      </StateSwitch>
      {problem !== null && <Banner tone="warn">{t(problem)}</Banner>}
      {mayEdit && (
        <SaveBar dirty={dirty}>
          <span className="muted small">{t('web.tier_prices_save_note')}</span>
          <Button
            variant="primary"
            size="sm"
            icon="check"
            disabled={problem !== null || !dirty || save.isPending}
            onClick={() => save.mutate()}
          >
            {t('web.tier_prices_save')}
          </Button>
        </SaveBar>
      )}
      {save.error !== null && (
        <Banner tone="danger">
          {messageFor(save.error)}
          <ErrorRef error={save.error} />
        </Banner>
      )}
    </Card>
  );
}
