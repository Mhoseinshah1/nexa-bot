import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { UsersPage } from '../../apps/web/src/pages/users';
import { LIST_SEARCH_DEBOUNCE_MS } from '../../apps/web/src/ui/list-search';
import { navigate, useRoute } from '../../apps/web/src/router';
import { t } from '../../apps/web/src/i18n/web.fa';
import { customer, renderPage, stubApi } from './harness';

/**
 * Customer Search (UX batch 02, issues 12 and 13).
 *
 * Rendered through the LIVE route, unlike most of `users.test.tsx`: auto-search applies the
 * box by navigating, and only a page that re-reads the URL can show what that navigation
 * asked the server. `LiveUsers` is the app's own wiring in miniature.
 *
 * Fake timers with `shouldAdvanceTime`, so the debounce is stepped by hand while react-query
 * and Testing Library keep their real clocks. Every boundary is asserted with a margin
 * (well short of the debounce, then well past it) so a slow CI machine cannot move it.
 */

function LiveUsers({
  maySearch = true,
  denied = false,
}: {
  maySearch?: boolean;
  denied?: boolean;
}) {
  const route = useRoute();
  return <UsersPage route={route} maySearch={maySearch} denied={denied} />;
}

const box = () => screen.getByLabelText(t('web.list_search_label')) as HTMLInputElement;
const type = (value: string) => fireEvent.change(box(), { target: { value } });
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
/** Short of the debounce by a margin no machine's scheduling can eat. */
const SHORT = LIST_SEARCH_DEBOUNCE_MS - 250;
/** Past the debounce by the same margin. */
const PAST = LIST_SEARCH_DEBOUNCE_MS + 250;

const searches = (calls: readonly { url: string }[]) =>
  calls
    .filter((call) => call.url.includes('/users'))
    .map((call) => new URL(call.url, 'http://x').searchParams.get('q'));

const list = (customers: unknown[]) => [{ url: '/users', body: { customers, nextCursor: null } }];

beforeEach(() => {
  navigate('/users', { replace: true, force: true });
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('customer search applies itself (issue 13)', () => {
  it('sends ONE request for a burst of keystrokes, after the debounce, trimmed', async () => {
    const api = stubApi(list([customer()]));
    renderPage(<LiveUsers />);
    await screen.findByText('5551234567');
    const before = api.calls.length;

    // Typed one character at a time, each well inside the debounce of the last.
    for (const draft of ['a', 'al', 'ali', 'ali ']) {
      type(draft);
      await advance(SHORT / 2);
    }
    expect(api.calls.length, 'a keystroke issued a request').toBe(before);
    await advance(SHORT);
    expect(api.calls.length, 'the debounce fired early').toBe(before);

    await advance(PAST);
    await waitFor(() => expect(searches(api.calls.slice(before))).toEqual(['ali']));
    expect(new URLSearchParams(window.location.search).get('q')).toBe('ali');
    // The draft keeps what was typed — the trailing space included — so typing on works.
    expect(box().value).toBe('ali ');
  });

  it('treats a paste exactly as typing: one request, whitespace trimmed, as a Telegram id', async () => {
    const api = stubApi(list([customer()]));
    renderPage(<LiveUsers />);
    await screen.findByText('5551234567');
    const before = api.calls.length;

    // A paste is one change event carrying the whole value, copied with its padding.
    fireEvent.paste(box());
    type('  5551234567\n');
    expect(screen.getByTestId('list-search-kind').textContent).toBe(
      t('web.list_search_reads_telegram'),
    );
    await advance(PAST);
    await waitFor(() => expect(searches(api.calls.slice(before))).toEqual(['5551234567']));
  });

  it('sends an @username as the server reads it, by shape', async () => {
    const api = stubApi(list([customer()]));
    renderPage(<LiveUsers />);
    await screen.findByText('5551234567');
    const before = api.calls.length;

    type('@ali_teh');
    expect(screen.getByTestId('list-search-kind').textContent).toBe(
      t('web.list_search_reads_username'),
    );
    await advance(PAST);
    await waitFor(() => expect(searches(api.calls.slice(before))).toEqual(['@ali_teh']));
  });

  it('sends nothing for whitespace, and emptying the box returns to the unsearched list', async () => {
    const api = stubApi(list([customer()]));
    renderPage(<LiveUsers />);
    await screen.findByText('5551234567');
    const before = api.calls.length;

    type('   ');
    await advance(PAST);
    expect(api.calls.length, 'whitespace alone became a request').toBe(before);
    expect(window.location.search).toBe('');

    type('ali');
    await advance(PAST);
    await waitFor(() => expect(searches(api.calls.slice(before))).toEqual(['ali']));

    type('');
    await advance(PAST);
    await waitFor(() => expect(window.location.search).toBe(''));
    // Never an empty `q` (the server refuses one as a 400): absent is "no search".
    expect(searches(api.calls.slice(before)).every((q) => q === null || q.trim() !== '')).toBe(
      true,
    );
  });

  it('applies at once on Enter, without waiting for the debounce', async () => {
    const api = stubApi(list([customer()]));
    renderPage(<LiveUsers />);
    await screen.findByText('5551234567');
    const before = api.calls.length;

    type('5551234567');
    fireEvent.submit(box());
    await waitFor(() => expect(searches(api.calls.slice(before))).toEqual(['5551234567']));
    // And the debounce that was pending does not send it a second time.
    await advance(PAST);
    expect(searches(api.calls.slice(before))).toEqual(['5551234567']);
  });

  it('cancels the pending apply on Enter, so a Clear right after it stays cleared', async () => {
    /*
     * Enter applies the term; the debounce scheduled by the same typing must die with it.
     * A timer that outlived Enter would fire after the operator pressed Clear and put the
     * search they had just removed back into the URL.
     */
    stubApi(list([customer()]));
    renderPage(<LiveUsers />);
    await screen.findByText('5551234567');

    type('5551234567');
    fireEvent.submit(box());
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get('q')).toBe('5551234567'),
    );
    fireEvent.click(screen.getByRole('button', { name: t('web.users_search_clear') }));
    await waitFor(() => expect(window.location.search).toBe(''));

    await advance(PAST);
    expect(window.location.search, 'a timer that outlived Enter re-applied the search').toBe('');
  });

  it('does not carry a half-typed term into a list the operator navigated to', async () => {
    /*
     * The sidebar «کاربران» link from a filtered list, pressed inside the debounce: the
     * link resets the list, and the term typed under the old URL must not be applied to the
     * new one 400 ms later. The text stays, unapplied; the next keystroke applies it here.
     */
    navigate('/users?status=BLOCKED', { replace: true, force: true });
    const api = stubApi(list([customer()]));
    renderPage(<LiveUsers />);
    await screen.findByText('5551234567');

    type('ali');
    await advance(SHORT);
    act(() => navigate('/users'));
    const before = api.calls.length;
    await advance(PAST);
    await advance(PAST);
    expect(window.location.search, 'the half-typed term defeated the reset link').toBe('');
    expect(searches(api.calls.slice(before)).every((q) => q === null)).toBe(true);
    expect(box().value).toBe('ali');

    type('alir');
    await advance(PAST);
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('q')).toBe('alir'));
  });

  it('waits for an input method to finish composing before it searches', async () => {
    const api = stubApi(list([customer()]));
    renderPage(<LiveUsers />);
    await screen.findByText('5551234567');
    const before = api.calls.length;

    fireEvent.compositionStart(box());
    type('سل');
    await advance(PAST);
    expect(searches(api.calls.slice(before)), 'a half-composed word was searched').toEqual([]);

    type('سلام');
    fireEvent.compositionEnd(box());
    await advance(PAST);
    await waitFor(() => expect(searches(api.calls.slice(before))).toEqual(['سلام']));
  });

  it('never draws an older, slower answer over a newer one', async () => {
    /*
     * `ali` is asked first and answered LAST. Its response must not replace the rows the
     * newer `alireza` search already drew — the page draws only the query key of the search
     * currently applied, so the late answer lands in its own cache entry and stays there.
     */
    const ali = customer({ telegramUserId: '111111111', username: 'ali' });
    const alireza = customer({
      id: '019210ab-cdef-7012-8345-6789abcdef02',
      telegramUserId: '222222222',
      username: 'alireza',
    });
    const respond = (customers: unknown[]) =>
      new Response(JSON.stringify({ customers, nextCursor: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    let releaseAli: () => void = () => undefined;
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) => {
        const url = String(input);
        urls.push(url);
        const q = new URL(url, 'http://x').searchParams.get('q');
        if (q === 'ali') {
          return new Promise<Response>((resolve) => {
            releaseAli = () => resolve(respond([ali]));
          });
        }
        if (q === 'alireza') return Promise.resolve(respond([alireza]));
        return Promise.resolve(respond([customer()]));
      }),
    );
    renderPage(<LiveUsers />);
    await screen.findByText('5551234567');

    type('ali');
    await advance(PAST);
    await waitFor(() => expect(searches(urls.map((url) => ({ url })))).toContain('ali'));

    type('alireza');
    await advance(PAST);
    await screen.findByText('222222222');

    releaseAli();
    await advance(50);
    expect(screen.getByText('222222222')).toBeInTheDocument();
    expect(screen.queryByText('111111111'), 'the stale answer replaced the newer one').toBeNull();
    expect(new URLSearchParams(window.location.search).get('q')).toBe('alireza');
  });

  it('applies nothing by itself while the list is refused (users.view)', async () => {
    const api = stubApi(list([customer()]));
    renderPage(<LiveUsers denied />);
    // The box is in the document, hidden; a value forced into it must not navigate.
    type('5551234567');
    await advance(PAST);
    expect(api.calls).toHaveLength(0);
    expect(window.location.search).toBe('');
  });

  it('draws no box at all without users.search, so nothing can apply itself', async () => {
    const api = stubApi(list([customer()]));
    renderPage(<LiveUsers maySearch={false} />);
    await screen.findByText('5551234567');
    expect(screen.queryByLabelText(t('web.list_search_label'))).toBeNull();
    await advance(PAST);
    expect(searches(api.calls).every((q) => q === null)).toBe(true);
  });
});

describe('the activity columns (issue 12)', () => {
  it('names first and last ACTIVITY, and says which events move them', async () => {
    stubApi(list([customer()]));
    renderPage(<LiveUsers />);
    await screen.findByText('5551234567');

    const headers = screen.getAllByRole('columnheader').map((cell) => cell.textContent ?? '');
    expect(headers).toContain(t('web.user_first_seen'));
    expect(headers).toContain(t('web.user_last_seen'));
    expect(t('web.user_first_seen')).toBe('اولین فعالیت');
    expect(t('web.user_last_seen')).toBe('آخرین فعالیت');
    // "Contact" read as a call or a support request; it is gone from the list.
    expect(headers.join(' ')).not.toContain('تماس');
    expect(screen.getByText(t('web.users_activity_note'))).toBeVisible();
    // An imported customer: BOTH columns are the import time until they first use the bot.
    expect(t('web.users_activity_note')).toContain('«اولین فعالیت» و، تا نخستین پیام او');
    expect(t('web.users_activity_note')).toContain('«آخرین فعالیت» هم زمان انتقال است');
  });
});
