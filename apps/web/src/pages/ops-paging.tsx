import { useState } from 'react';
import { CursorPager, LIST_PAGE_SIZE, type KeysetOrder } from '../ui/kit';

/**
 * W1.8 for a list drawn from rows already in memory (a whole response, or the pages an
 * infinite query has read so far): ten rows a page, previous and next. The page index is keyed
 * by `resetKey` (the filters), so a new filter starts at the first page. Nothing is counted
 * that the server did not send.
 */
export function useClientPaging<T>(
  rows: readonly T[],
  resetKey: string,
  size: number = LIST_PAGE_SIZE,
): {
  readonly rows: readonly T[];
  readonly page: number;
  readonly hasPrevious: boolean;
  /** Another page is already in memory. */
  readonly hasNextLoaded: boolean;
  readonly go: (page: number) => void;
} {
  const [state, setState] = useState({ key: resetKey, page: 0 });
  const wanted = state.key === resetKey ? state.page : 0;
  const lastPage = Math.max(0, Math.ceil(rows.length / size) - 1);
  const page = Math.min(wanted, lastPage);
  return {
    rows: rows.slice(page * size, page * size + size),
    page,
    hasPrevious: page > 0,
    hasNextLoaded: page < lastPage,
    go: (next) => setState({ key: resetKey, page: Math.max(0, next) }),
  };
}

/**
 * The pager for `useClientPaging` (the kit's `usePagedRows` cannot read on): `onNext` may
 * first read another page from the server.
 */
export function ClientPager({
  order,
  shown,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
}: {
  /** The order the rows are in (`CursorPager`): it names the two buttons. */
  order: KeysetOrder;
  shown: number;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  if (!hasPrevious && !hasNext) return null;
  return (
    <CursorPager
      order={order}
      shown={shown}
      hasPrevious={hasPrevious}
      hasNext={hasNext}
      onPrevious={onPrevious}
      onNext={onNext}
    />
  );
}
