import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ListTotal } from '@nexa/contracts';
import { useKeptTotal } from '../../apps/web/src/ui/paging';

/**
 * The server counts the first page of a list only, so a later page carries no total: the
 * chip keeps the one the same list showed, and drops it the moment a filter changes.
 */
const TOTAL: ListTotal = { value: 200_000, estimated: true };

describe('useKeptTotal', () => {
  it('keeps the first page’s total over a page turn of the same list', () => {
    const { result, rerender } = renderHook(
      ({ total, list }: { total: ListTotal | undefined; list: string }) =>
        useKeptTotal(total, list),
      { initialProps: { total: TOTAL as ListTotal | undefined, list: 'a' } },
    );
    expect(result.current).toEqual(TOTAL);
    rerender({ total: undefined, list: 'a' });
    expect(result.current).toEqual(TOTAL);
  });

  it('drops it when the list changes and the new one has none yet', () => {
    const { result, rerender } = renderHook(
      ({ total, list }: { total: ListTotal | undefined; list: string }) =>
        useKeptTotal(total, list),
      { initialProps: { total: TOTAL as ListTotal | undefined, list: 'a' } },
    );
    rerender({ total: undefined, list: 'b' });
    expect(result.current).toBeUndefined();
  });
});
