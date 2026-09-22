import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProductCategoryListingResponse } from '@nexa/contracts';
import {
  createProductCategory,
  deleteProductCategory,
  fetchProductCategories,
  reorderProductCategories,
  transitionProductCategory,
  updateProductCategory,
  ApiError,
} from '../api/client';
import { useSubmissionKey } from '../submission-key';
import { queryState } from '../view-state';
import { t } from '../i18n/web.fa';
import { messageFor } from './settings';
import {
  Badge,
  Banner,
  Card,
  DataTable,
  Empty,
  Field,
  PageHead,
  StateSwitch,
  useToast,
  type Column,
} from '../ui/kit';

/**
 * Product categories — the one place a tenant arranges what it sells.
 *
 * **Status and visibility are two buttons, not one.** `docs/wp5-categories-audit.md`
 * §6.3 is explicit that they answer different questions: INACTIVE means the whole group
 * is unavailable for new purchases INCLUDING through a direct reference a customer
 * already holds, while HIDDEN only removes it from browsing and leaves its products
 * buyable by anyone holding a link. A single "enabled" switch would have collapsed the
 * two, and the collapse is invisible until a customer who was never meant to lose
 * access does.
 *
 * **The product count is the one the server computed.** It counts every product filed
 * under the category, withdrawn ones included, because the question it answers is "may I
 * delete this" — and an inactive product blocks a delete exactly as an active one does.
 * It is deliberately not the number a customer would see; that is a different predicate
 * decided in SQL, and using this count to guess at it would be the second interpretation
 * the audit forbids.
 *
 * **Delete is refused while products remain, and the refusal carries the count.** The
 * screen renders the server's sentence rather than its own, because the server is what
 * looked: `details.productCount` is the number an operator acts on, where "cannot
 * delete" leaves them hunting.
 *
 * **Reorder sends the WHOLE order.** The server refuses a short match rather than
 * reordering what it recognises, so up/down rebuilds the complete list and sends all of
 * it. A subset believed complete would otherwise be half-applied under a success
 * message.
 *
 * **No paging.** A category list is a handful of rows an operator arranges by hand, and
 * paging it would make "move this to the top" a question about which page the top is on.
 * The server's `listForOperator` makes the same decision for the same reason.
 */

const EMPTY_FORM = { name: '', description: '', emoji: '', sortOrder: '0' };
type FormState = typeof EMPTY_FORM;

function formOf(category: ProductCategoryListingResponse): FormState {
  return {
    name: category.name,
    description: category.description ?? '',
    emoji: category.emoji ?? '',
    sortOrder: String(category.sortOrder),
  };
}

/**
 * The refusal an operator most needs a number in.
 *
 * `CATEGORY_NOT_EMPTY` carries `details.productCount`, and the server's own message
 * already says what happened — so this appends the count rather than replacing the
 * sentence. Falling back to `messageFor` when the shape is not what we expect keeps a
 * malformed detail from swallowing the whole error.
 */
function deleteMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === 'commerce.category_not_empty') {
    const count = (error.details as { productCount?: unknown } | null)?.productCount;
    if (typeof count === 'number') return `${error.message} (${count})`;
  }
  return messageFor(error);
}

export function ProductCategoriesPage({ denied, mayEdit }: { denied: boolean; mayEdit: boolean }) {
  const queries = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();

  const categories = useQuery({
    queryKey: ['product-categories'],
    queryFn: () => fetchProductCategories(),
    enabled: !denied,
  });

  /** Null while adding; a category id while editing one. ONE form, two intents. */
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const rows = categories.data?.categories ?? [];

  const reset = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
  };

  const refresh = () => {
    void queries.invalidateQueries({ queryKey: ['product-categories'] });
    // The products list renders a category column, so it is stale the moment a
    // category is renamed or removed.
    void queries.invalidateQueries({ queryKey: ['products'] });
  };

  const payload = () => ({
    name: form.name.trim(),
    description: form.description.trim() === '' ? null : form.description.trim(),
    emoji: form.emoji.trim() === '' ? null : form.emoji.trim(),
  });

  const save = useMutation({
    mutationFn: () => {
      const fields = payload();
      /*
       * Bound to the whole payload AND to which category is being written, so
       * correcting a typo and pressing save again is a NEW command rather than a replay
       * the store refuses as a payload mismatch.
       */
      const idempotencyKey = submission.current({ editing, ...fields, sort: form.sortOrder });
      return editing === null
        ? createProductCategory({
            ...fields,
            idempotencyKey,
            sortOrder: Number(form.sortOrder) || 0,
          })
        : updateProductCategory({ ...fields, idempotencyKey, id: editing });
    },
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.category_saved') });
      reset();
      refresh();
    },
    // A 5xx may have committed. A fresh key on the retry would be a second category.
    onError: (error) => submission.settleOn(error),
  });

  const transition = useMutation({
    mutationFn: (input: { id: string; which: 'activate' | 'deactivate' | 'show' | 'hide' }) =>
      transitionProductCategory({
        ...input,
        idempotencyKey: submission.current({ transition: input.id, which: input.which }),
      }),
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.category_saved') });
      refresh();
    },
    onError: (error) => submission.settleOn(error),
  });

  const reorder = useMutation({
    mutationFn: (positions: readonly { id: string; sortOrder: number }[]) =>
      reorderProductCategories({
        positions,
        idempotencyKey: submission.current({ reorder: positions }),
      }),
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.category_reordered') });
      refresh();
    },
    onError: (error) => submission.settleOn(error),
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      deleteProductCategory({ id, idempotencyKey: submission.current({ remove: id }) }),
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.category_deleted') });
      reset();
      refresh();
    },
    onError: (error) => submission.settleOn(error),
  });

  const busy = save.isPending || transition.isPending || reorder.isPending || remove.isPending;
  const failure = save.error ?? transition.error ?? reorder.error;

  /**
   * Swaps a row with its neighbour and sends the COMPLETE new order.
   *
   * Positions are renumbered from zero over the whole list rather than swapping two
   * `sortOrder` values, because two categories can legitimately share a position — the
   * column has no unique index — and swapping equal values is a move that changes
   * nothing while reporting success.
   */
  const move = (index: number, delta: number) => {
    const next = [...rows];
    const target = index + delta;
    const a = next[index];
    const b = next[target];
    if (a === undefined || b === undefined) return;
    next[index] = b;
    next[target] = a;
    reorder.mutate(next.map((row, position) => ({ id: row.id, sortOrder: position })));
  };

  const columns: readonly Column<ProductCategoryListingResponse>[] = [
    {
      key: 'name',
      header: t('web.category_name'),
      render: (row) => (
        <>
          {row.emoji !== null && <span aria-hidden="true">{row.emoji} </span>}
          {row.name}
        </>
      ),
    },
    {
      key: 'products',
      header: t('web.category_products'),
      render: (row) => row.productCount,
    },
    {
      key: 'status',
      header: t('web.category_status'),
      render: (row) => (
        <Badge tone={row.status === 'ACTIVE' ? 'ok' : 'neutral'}>
          {t(row.status === 'ACTIVE' ? 'web.category_active' : 'web.category_inactive')}
        </Badge>
      ),
    },
    {
      key: 'visibility',
      header: t('web.category_visibility'),
      render: (row) => (
        <Badge tone={row.visibility === 'VISIBLE' ? 'ok' : 'neutral'}>
          {t(row.visibility === 'VISIBLE' ? 'web.category_visible' : 'web.category_hidden')}
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: t('web.category_actions'),
      align: 'end',
      // Nothing at all for a view-only role. The column header stays, because a table
      // whose columns depend on the reader is a table two operators describe differently.
      render: (row) => {
        if (!mayEdit) return null;
        /*
         * The position is looked up by ID rather than taken from a render index.
         * `Column.render` is given the row alone, and threading an index through would
         * have tied "which neighbour to swap with" to the order the table happened to
         * iterate in — which is the same array, until somebody sorts the view.
         */
        const index = rows.findIndex((candidate) => candidate.id === row.id);
        return (
          <div className="toolbar">
            <button
              type="button"
              className="btn sm"
              disabled={busy}
              onClick={() => {
                setEditing(row.id);
                setForm(formOf(row));
              }}
            >
              {t('web.category_edit')}
            </button>
            <button
              type="button"
              className="btn sm"
              disabled={busy}
              onClick={() =>
                transition.mutate({
                  id: row.id,
                  which: row.status === 'ACTIVE' ? 'deactivate' : 'activate',
                })
              }
            >
              {t(row.status === 'ACTIVE' ? 'web.category_deactivate' : 'web.category_activate')}
            </button>
            <button
              type="button"
              className="btn sm"
              disabled={busy}
              onClick={() =>
                transition.mutate({
                  id: row.id,
                  which: row.visibility === 'VISIBLE' ? 'hide' : 'show',
                })
              }
            >
              {t(row.visibility === 'VISIBLE' ? 'web.category_hide' : 'web.category_show')}
            </button>
            <button
              type="button"
              className="btn sm"
              disabled={busy || index === 0}
              onClick={() => move(index, -1)}
            >
              {t('web.category_move_up')}
            </button>
            <button
              type="button"
              className="btn sm"
              disabled={busy || index === rows.length - 1}
              onClick={() => move(index, 1)}
            >
              {t('web.category_move_down')}
            </button>
            {/*
              Drawn whatever the count says, and refused by the SERVER when products
              remain. Hiding it on a non-zero count would make the button's absence the
              enforcement — and the count is a read that is stale the moment a product
              is created into the category. The refusal carries the number.
            */}
            <button
              type="button"
              className="btn sm danger"
              disabled={busy}
              onClick={() => {
                if (!window.confirm(t('web.category_delete_confirm'))) return;
                remove.mutate(row.id);
              }}
            >
              {t('web.category_delete')}
            </button>
          </div>
        );
      },
    },
  ];

  return (
    <>
      <PageHead
        title={t('web.categories_title')}
        subtitle={t('web.categories_subtitle')}
        maturity="now"
      />

      <StateSwitch
        query={categories}
        denied={denied}
        isEmpty={queryState(categories) === 'ready' && rows.length === 0}
        empty={<Empty title={t('web.categories_empty')} hint={t('web.categories_empty_hint')} />}
      >
        <Card title={t('web.categories_title')}>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            caption={t('web.categories_title')}
          />
          <p className="muted small">{t('web.category_inactive_note')}</p>
          <p className="muted small">{t('web.category_hidden_note')}</p>
        </Card>
      </StateSwitch>

      {/*
        Outside the StateSwitch on purpose: a tenant with NO category still needs the
        form, and that is exactly the installation whose first product would otherwise
        be refused by a rule nothing offered a way to satisfy.
      */}
      {mayEdit && (
        <Card
          title={t(editing === null ? 'web.category_new' : 'web.category_editing')}
          hint={t('web.category_form_hint')}
        >
          <Field label={t('web.category_name')} htmlFor="cat-name">
            <input
              id="cat-name"
              value={form.name}
              maxLength={120}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </Field>
          <Field label={t('web.category_description')} htmlFor="cat-description">
            <input
              id="cat-description"
              value={form.description}
              maxLength={500}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
            />
          </Field>
          <Field
            label={t('web.category_emoji')}
            htmlFor="cat-emoji"
            hint={t('web.category_emoji_hint')}
          >
            <input
              id="cat-emoji"
              value={form.emoji}
              maxLength={40}
              onChange={(event) => setForm({ ...form, emoji: event.target.value })}
            />
          </Field>
          {/*
            Only on create. An existing category is reordered with the up/down buttons,
            which send the whole arrangement; a number typed here as well would be two
            ways to express the same thing that can disagree.
          */}
          {editing === null && (
            <Field label={t('web.category_sort')} htmlFor="cat-sort">
              <input
                id="cat-sort"
                value={form.sortOrder}
                inputMode="numeric"
                onChange={(event) => setForm({ ...form, sortOrder: event.target.value })}
              />
            </Field>
          )}

          <div className="toolbar">
            <button
              type="button"
              className="btn primary sm"
              disabled={busy || form.name.trim() === ''}
              onClick={() => save.mutate()}
            >
              {t('web.category_save')}
            </button>
            {editing !== null && (
              <button type="button" className="btn sm" disabled={busy} onClick={reset}>
                {t('web.category_cancel_edit')}
              </button>
            )}
          </div>

          {failure != null && <Banner tone="danger">{messageFor(failure)}</Banner>}
          {/*
            The delete refusal has its own banner, because it is the one an operator
            most needs to read the NUMBER out of — and a shared banner would have shown
            whichever of the two mutations failed most recently.
          */}
          {remove.error != null && <Banner tone="danger">{deleteMessage(remove.error)}</Banner>}
        </Card>
      )}
    </>
  );
}
