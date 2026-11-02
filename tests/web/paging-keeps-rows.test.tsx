import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { AuditLogPage } from '../../apps/web/src/pages/audit-log';
import { keepPageWhileTurning } from '../../apps/web/src/ui/paging';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage } from './harness';

/**
 * B3 (PR #285 review): «قبلی / بعدی» on a server-paged list used to empty the list for the
 * length of the request, and the view jumped. A turn of the page now keeps the rows on screen
 * until the next page lands; a new FILTER is a new list and never shows the old filter's rows
 * as its answer.
 */

const ORDER_ID = '019350ab-cdef-7012-8345-6789abcdef01';
const CUSTOMER_ID = '019320ab-cdef-7012-8345-6789abcdef01';
const none = { customerId: null, orderId: null, paymentId: null, serviceId: null };

const entry = (overrides: Record<string, unknown> = {}) => ({
  id: '019360ab-cdef-7012-8345-6789abcdef01',
  occurredAt: '2026-09-20T10:00:00.000Z',
  actorType: 'WEB_ADMIN',
  actorId: '019330ab-cdef-7012-8345-6789abcdef01',
  actorLabel: 'owner',
  surface: 'WEB',
  action: 'order.confirm',
  entityType: 'Order',
  entityId: ORDER_ID,
  result: 'SUCCESS',
  reason: null,
  correlationId: 'corr-1',
  before: null,
  after: null,
  security: [],
  links: { ...none, orderId: ORDER_ID },
  ...overrides,
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/**
 * The first page answers at once; every later read waits until the test releases it, so
 * the test can look at the screen WHILE the next page is being read.
 */
function stubSlowSecondRead() {
  const urls: string[] = [];
  const held: ((response: Response) => void)[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      urls.push(url);
      if (urls.length === 1)
        return Promise.resolve(json({ entries: [entry()], nextCursor: 'CURSOR-1' }));
      return new Promise<Response>((resolve) => held.push(resolve));
    }),
  );
  return { urls, held };
}

const route = (query = '') => ({ path: '/audit-log', query: new URLSearchParams(query) });

describe('a server-paged list while the next page is read', () => {
  it('keeps the rows it shows on screen, and offers no second «بعدی» meanwhile', async () => {
    const api = stubSlowSecondRead();
    renderPage(<AuditLogPage route={route()} denied={false} mayExport={false} />);
    await screen.findByRole('link', { name: t('web.audit_link_order') });

    fireEvent.click(screen.getByRole('button', { name: t('web.page_older') }));
    await waitFor(() => expect(api.urls.some((url) => url.includes('cursor=CURSOR-1'))).toBe(true));

    // The request is in flight: the page-one row is still drawn, with no skeleton in its place.
    expect(screen.getByRole('link', { name: t('web.audit_link_order') })).toBeInTheDocument();
    expect(document.querySelector('.skel')).toBeNull();
    // A second press would push the same cursor twice; «قبلی» is still there.
    expect(screen.getByRole('button', { name: t('web.page_older') })).toBeDisabled();
    expect(screen.getByRole('button', { name: t('web.page_newer') })).toBeEnabled();

    // The next page lands and replaces the rows.
    api.held.shift()!(
      json({
        entries: [
          entry({
            id: '019360ab-cdef-7012-8345-6789abcdef02',
            entityType: 'Customer',
            entityId: CUSTOMER_ID,
            links: { ...none, customerId: CUSTOMER_ID },
          }),
        ],
        nextCursor: null,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: t('web.audit_link_order') })).toBeNull(),
    );
    expect(screen.getByRole('link', { name: t('web.audit_link_customer') })).toBeInTheDocument();
  });

  it('never shows the old filter’s rows as the answer to a new filter', async () => {
    const api = stubSlowSecondRead();
    const view = renderPage(<AuditLogPage route={route()} denied={false} mayExport={false} />);
    await screen.findByRole('link', { name: t('web.audit_link_order') });

    view.rerender(<AuditLogPage route={route('result=DENIED')} denied={false} mayExport={false} />);
    await waitFor(() => expect(api.urls.some((url) => url.includes('result=DENIED'))).toBe(true));
    expect(screen.queryByRole('link', { name: t('web.audit_link_order') })).toBeNull();
  });
});

describe('keepPageWhileTurning', () => {
  const placeholder = (key: readonly unknown[], cursorAt?: readonly number[]) => {
    const fn = keepPageWhileTurning({ queryKey: key, queryFn: () => null }, cursorAt)
      .placeholderData as (
      previous: unknown,
      query: { queryKey: readonly unknown[] } | undefined,
    ) => unknown;
    return fn;
  };
  const page = { rows: [1, 2], nextCursor: 'NEXT' };

  it('keeps the previous page of the same list, without its «بعدی»', () => {
    expect(
      placeholder(['orders', 'a|b', 'C2'])(page, { queryKey: ['orders', 'a|b', 'C1'] }),
    ).toEqual({ rows: [1, 2], nextCursor: null });
  });

  it('keeps nothing across a filter, or with no previous query', () => {
    expect(placeholder(['orders', 'a|c', 'C2'])(page, { queryKey: ['orders', 'a|b', 'C1'] })).toBe(
      undefined,
    );
    expect(placeholder(['orders', 'a|b', 'C2'])(page, undefined)).toBe(undefined);
  });

  it('reads the cursor where the key keeps it', () => {
    // services and payments keep the cursor second; alerts keep it in the last two places.
    const services = placeholder(['services', 'C2', 'ACTIVE', ''], [1]);
    expect(services(page, { queryKey: ['services', null, 'ACTIVE', ''] })).not.toBe(undefined);
    expect(services(page, { queryKey: ['services', null, 'EXPIRED', ''] })).toBe(undefined);
    const alerts = placeholder(['ops-log', 'm', 'WARN', true, 'at2', 'id2'], [-2, -1]);
    expect(
      alerts(page, { queryKey: ['ops-log', 'm', 'WARN', true, undefined, undefined] }),
    ).not.toBe(undefined);
    expect(alerts(page, { queryKey: ['ops-log', 'm', 'INFO', true, 'at2', 'id2'] })).toBe(
      undefined,
    );
  });
});

describe('every server-paged list keeps its page while turning', () => {
  /*
   * A page that draws the shared «قبلی / بعدی» pager over a server cursor reads it through
   * `keepPageWhileTurning` (or, for an unfiltered list, TanStack's `keepPreviousData`). A new
   * list added without it brings the jump back; this names it.
   */
  const PAGES = join(import.meta.dirname, '../../apps/web/src/pages');
  // Pages whose pager walks rows already in memory (usePagedRows / useClientPaging; content.tsx
  // pages the whole catalogue the server returned at once).
  const IN_MEMORY = new Set(['ops-paging.tsx', 'content.tsx']);

  it('names no paged page without it', () => {
    const files = readdirSync(PAGES, { recursive: true, encoding: 'utf8' }).filter((file) =>
      file.endsWith('.tsx'),
    );
    const missing = files.filter((file) => {
      if (IN_MEMORY.has(file)) return false;
      const source = readFileSync(join(PAGES, file), 'utf8');
      if (!source.includes('<CursorPager')) return false;
      return !source.includes('keepPageWhileTurning(') && !source.includes('keepPreviousData');
    });
    expect(missing).toEqual([]);
  });
});

describe('the no-scroll check clicks the pager too', () => {
  /*
   * Commit e99e4c1 left «قبلی / بعدی» out of `pnpm web:no-scroll` because turning a page
   * jumped the view. With the rows kept, the pager is held to the same rule as every button.
   */
  it('does not exclude .pager from the buttons it clicks', () => {
    const script = readFileSync(
      join(import.meta.dirname, '../../scripts/web-shots/no-scroll.mjs'),
      'utf8',
    );
    const buttons = /const BUTTONS = `([\s\S]*?)`;/.exec(script);
    expect(buttons).not.toBeNull();
    expect(buttons![1]).not.toContain('pager');
  });
});
