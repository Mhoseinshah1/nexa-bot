import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { match, setQueries, setQuery } from '../../apps/web/src/router';
import { resolve } from '../../apps/web/src/app';
import { PERMISSION_KEYS } from '@nexa/contracts';
import { panel as panelBase, renderPage, stubApi } from './harness';

const panelFixture = (id: string, name: string) => ({ ...panelBase({ id, name }) });

/**
 * The router, at the boundary where a URL an operator can type meets code.
 *
 * `match` runs inside `resolve` during render, and there is no error boundary
 * above it. Anything it throws is not a bad page — it is the whole signed-in
 * admin gone, from one address bar.
 */
describe('route matching', () => {
  it('extracts a parameter and decodes it', () => {
    expect(match('/panels/:id', '/panels/01a05e35-c9ad-7e93-bef3-1ed9b55292c8')).toEqual({
      id: '01a05e35-c9ad-7e93-bef3-1ed9b55292c8',
    });
    // A legitimately encoded value still arrives decoded.
    expect(match('/panels/:id', '/panels/a%20b')).toEqual({ id: 'a b' });
  });

  it('matches on segment COUNT, so a list never renders over a detail', () => {
    expect(match('/panels', '/panels/abc')).toBeNull();
    expect(match('/panels/:id', '/panels')).toBeNull();
  });

  /**
   * T19 — a malformed escape is an unmatched route, not a crash.
   *
   * `decodeURIComponent('%E0')` throws `URIError`: `%E0` introduces a
   * multi-byte UTF-8 sequence and the continuation bytes are missing. Every
   * shape below throws the same way, and each of them is a URL a person can
   * type or a link can carry.
   */
  it.each(['%E0', '%', '%zz', '%C3%28', '%F0%9F', 'a%2', '%E0%A4%A'])(
    'treats /panels/%s as unmatched rather than throwing',
    (bad) => {
      // The premise: this really is a value that throws.
      expect(() => decodeURIComponent(bad)).toThrow();
      expect(() => match('/panels/:id', `/panels/${bad}`)).not.toThrow();
      expect(match('/panels/:id', `/panels/${bad}`)).toBeNull();
    },
  );

  it('leaves a malformed literal segment alone rather than decoding it', () => {
    // The non-parameter branch compares raw text, so a malformed escape there
    // simply does not equal the pattern.
    expect(match('/panels', '/%E0')).toBeNull();
  });
});

describe('the shell, given a URL an operator typed', () => {
  it('serves the not-found page for a malformed panel id instead of crashing', () => {
    stubApi([]);
    const resolved = resolve(
      { path: '/panels/%E0', query: new URLSearchParams() },
      PERMISSION_KEYS,
    );
    const { container } = renderPage(resolved.element as ReactElement);

    // Something rendered at all — which is the finding. Before the fix this
    // threw out of `resolve` and took the admin down with it.
    expect(container.textContent).toBeTruthy();
    // And it is the 404, not a panel detail asking the API for '%E0'.
    expect(screen.queryByText('اعتبارنامه‌ها')).toBeNull();
  });
});

/**
 * Navigating between two panel details must not carry a draft across.
 *
 * React reconciles by position and type. Without a key on the detail element,
 * `/panels/A` -> `/panels/B` keeps one `PanelDetailPage` mounted: the query key
 * changes and the heading follows B, while every `useState` initialiser in the
 * subtree still holds A. Pressing Save then writes A's name onto B.
 *
 * Reachable only when both panels are cached — a pending query renders a
 * skeleton, which unmounts the subtree — and browser history between two
 * visited panels is exactly that. So this test primes BOTH queries before
 * navigating, which is the production state the defect needs.
 *
 * Driven through `resolve`, not by rendering `PanelDetailPage` directly: the
 * key lives on the element the router returns, so a test that constructs the
 * page itself cannot see it.
 */
describe('navigating between two panel details', () => {
  const A = '01a05e35-c9ad-7e93-bef3-1ed9b55292c8';
  const B = '01a05e35-c9ad-7e93-bef3-1ed9b55292d9';

  const routeTo = (id: string): ReactElement =>
    resolve({ path: `/panels/${id}`, query: new URLSearchParams() }, PERMISSION_KEYS)
      .element as ReactElement;

  it('does not carry one panel’s draft onto another', async () => {
    stubApi([
      { url: `/panels/${A}`, body: { panel: panelFixture(A, 'Frankfurt A') } },
      { url: `/panels/${B}`, body: { panel: panelFixture(B, 'Helsinki B') } },
      { url: '/providers', body: { providers: [] } },
    ]);

    // BOTH panels must be in the query cache before the jump that matters.
    // A panel visited for the first time is `pending`, which renders a skeleton
    // and unmounts the subtree — that unmount resets the draft on its own and
    // hides the defect entirely. The first version of this test navigated
    // A -> B with B uncached and passed with the key removed, which is to say
    // it proved nothing. Visiting B, then A, then B is what an operator's
    // history does and is the only state where the bug is reachable.
    const view = renderPage(routeTo(B));
    await screen.findByText('Helsinki B');
    view.rerender(routeTo(A));
    await screen.findByText('Frankfurt A');

    // The operator types over A's name and does NOT save.
    const nameOf = () => screen.getByLabelText('نام') as HTMLInputElement;
    fireEvent.change(nameOf(), { target: { value: 'Edited A' } });
    expect(nameOf().value).toBe('Edited A');

    // History jump back to B. Both are cached, so nothing renders a skeleton
    // and nothing unmounts unless the key says so.
    view.rerender(routeTo(B));
    await screen.findByText('Helsinki B');

    // B's own value, not A's abandoned edit.
    expect(nameOf().value).toBe('Helsinki B');
  });

  /**
   * The credential draft and the selected tab travel with the same instance.
   *
   * The identity fields are the ones that can be SAVED onto the wrong panel, so
   * they are the sharp end — but they are not the only per-panel state in the
   * subtree. A typed-but-unsent credential surviving onto another panel is a
   * secret sitting in a form aimed at a row it was never meant for, and the
   * open tab following the operator across panels is how they would fail to
   * notice.
   *
   * This is the test that makes the KEY the fix rather than resetting two
   * fields: nothing here would be covered by remembering to clear `name` and
   * `baseUrl`.
   */
  it('does not carry a credential draft or the open tab across panels', async () => {
    const sanaei = (id: string, name: string) => ({
      ...panelBase({ id, name, providerType: 'sanaei', providerName: 'Sanaei (3X-UI)' }),
    });
    stubApi([
      { url: `/panels/${A}`, body: { panel: sanaei(A, 'Frankfurt A') } },
      { url: `/panels/${B}`, body: { panel: sanaei(B, 'Helsinki B') } },
      { url: '/providers', body: { providers: [] } },
    ]);

    // Cache both, as history requires.
    const view = renderPage(routeTo(B));
    await screen.findByText('Helsinki B');
    view.rerender(routeTo(A));
    await screen.findByText('Frankfurt A');

    // On A: open the credentials tab and half-type a username.
    fireEvent.click(screen.getByRole('tab', { name: 'اعتبارنامه‌ها' }));
    const username = await screen.findByLabelText('نام کاربری');
    fireEvent.change(username, { target: { value: 'half-typed-secret' } });

    view.rerender(routeTo(B));
    await screen.findByText('Helsinki B');

    // The tab went back to the overview, so the identity card is on screen...
    expect(screen.getByLabelText('نشانی پایه')).toBeInTheDocument();
    // ...and the half-typed credential is nowhere, not merely hidden.
    expect(screen.queryByDisplayValue('half-typed-secret')).toBeNull();
  });

  /**
   * And the same instance is genuinely reused when the id does NOT change, so
   * the key is not silently remounting on every render and quietly discarding
   * the draft-basis behaviour the previous round added.
   */
  it('keeps the draft when the route did not change panel', async () => {
    stubApi([
      { url: `/panels/${A}`, body: { panel: panelFixture(A, 'Frankfurt A') } },
      { url: '/providers', body: { providers: [] } },
    ]);

    const view = renderPage(routeTo(A));
    await screen.findByText('Frankfurt A');
    const nameOf = () => screen.getByLabelText('نام') as HTMLInputElement;
    fireEvent.change(nameOf(), { target: { value: 'Half typed' } });

    view.rerender(routeTo(A));
    await screen.findByText('Frankfurt A');
    expect(nameOf().value).toBe('Half typed');
  });
});

describe('a filter change is not a place the operator navigated to', () => {
  /**
   * `setQuery` REPLACES the history entry, and the panels page's comment used
   * to claim the opposite — that putting the archive filter in the URL let an
   * operator "use Back". It does not: switching mode overwrites the `/panels`
   * entry, so Back leaves the page entirely.
   *
   * Replacing is the behaviour to want for a filter, and `/system` argues for
   * its section correctly by stopping at linking and refresh. What was wrong
   * was the claim, and a claim about behaviour needs something that fails when
   * the behaviour changes.
   */
  it('treats an empty value as removing the parameter', () => {
    /*
     * `setQuery(route, key, '')` DELETES the key rather than writing `key=`.
     *
     * The rule had no test, and no caller passes `''` today — so its only
     * definition was the line itself, and removing the `|| value === ''` half
     * left the whole suite green. It matters the moment a filter is driven by
     * a text input, because `?q=` is a filter the server now refuses: every
     * empty query parameter on the list endpoints answers 400 rather than
     * widening the read. Writing `key=` into the URL would turn a cleared
     * search box into an error.
     */
    window.history.replaceState(null, '', '/panels?archived=only&q=frankfurt');
    setQuery({ path: '/panels', query: new URLSearchParams('archived=only&q=frankfurt') }, 'q', '');
    expect(window.location.search).toBe('?archived=only');
    expect(window.location.search).not.toContain('q=');

    // `null` is the other way of saying it, and a real value still writes.
    setQuery({ path: '/panels', query: new URLSearchParams('archived=only') }, 'archived', null);
    expect(window.location.search).toBe('');
    setQuery({ path: '/panels', query: new URLSearchParams() }, 'archived', 'only');
    expect(window.location.search).toBe('?archived=only');
  });

  it('applies EVERY parameter of a multi-field filter, in one navigation', () => {
    /*
     * The defect this function exists for, stated as behaviour.
     *
     * Two `setQuery` calls in one handler apply ONE change: each builds its
     * `URLSearchParams` from `route.query`, which is the prop captured at render and is
     * not updated by the first call's navigation. So the second overwrites the first.
     * `/orders` lost `customerId` and `/users` lost `telegramUserId`, both silently —
     * the operator saw a filter chip they had typed and a list that ignored it.
     *
     * The stale-prop half is asserted FIRST, so this test fails if `setQueries` is ever
     * reduced to a loop of `setQuery` calls — which is precisely the regression that
     * would look like a tidy-up.
     */
    const route = { path: '/orders', query: new URLSearchParams() };
    window.history.replaceState(null, '', '/orders');

    setQuery(route, 'customerId', 'c-1');
    setQuery(route, 'productId', 'p-1');
    expect(window.location.search, 'two setQuery calls still drop the first').toBe(
      '?productId=p-1',
    );

    window.history.replaceState(null, '', '/orders');
    setQueries(route, [
      ['customerId', 'c-1'],
      ['productId', 'p-1'],
    ]);
    const applied = new URLSearchParams(window.location.search);
    expect(applied.get('customerId')).toBe('c-1');
    expect(applied.get('productId')).toBe('p-1');

    // Clearing both is the same shape, and the clear handler had the same bug.
    const filtered = {
      path: '/orders',
      query: new URLSearchParams('customerId=c-1&productId=p-1'),
    };
    setQueries(filtered, [
      ['customerId', null],
      ['productId', null],
    ]);
    expect(window.location.search).toBe('');

    // Parameters it was not given are KEPT, so clearing a search does not silently
    // drop the state filter beside it.
    const mixed = { path: '/orders', query: new URLSearchParams('state=DRAFT&customerId=c-1') };
    setQueries(mixed, [['customerId', null]]);
    expect(window.location.search).toBe('?state=DRAFT');
  });

  it('replaces the history entry rather than pushing one', () => {
    const pushed: unknown[] = [];
    const replaced: unknown[] = [];
    const realPush = window.history.pushState.bind(window.history);
    const realReplace = window.history.replaceState.bind(window.history);
    window.history.pushState = (...args: unknown[]) => {
      pushed.push(args);
      return realPush(...(args as Parameters<typeof realPush>));
    };
    window.history.replaceState = (...args: unknown[]) => {
      replaced.push(args);
      return realReplace(...(args as Parameters<typeof realReplace>));
    };
    try {
      setQuery({ path: '/panels', query: new URLSearchParams() }, 'archived', 'only');
      expect(window.location.search).toBe('?archived=only');
      expect(replaced, 'a filter change replaces').toHaveLength(1);
      expect(pushed, 'and never pushes — Back would otherwise leave the page').toHaveLength(0);
    } finally {
      window.history.pushState = realPush;
      window.history.replaceState = realReplace;
    }
  });
});
