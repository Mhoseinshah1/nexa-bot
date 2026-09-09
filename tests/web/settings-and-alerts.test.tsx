import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { SettingsPage } from '../../apps/web/src/pages/settings';
import { AlertsPage } from '../../apps/web/src/pages/alerts';
import { SystemPage } from '../../apps/web/src/pages/system';
import { event, renderPage, setting, stubApi } from './harness';
import { CURRENCY_CODES, MANAGEMENT_EVENT_CODES } from '@nexa/contracts';
import { t } from '../../apps/web/src/i18n/web.fa';

const settings = (rows: unknown[]) => [{ url: '/settings', body: { settings: rows } }];

describe('the settings screen', () => {
  /**
   * Owner revision 22 — several support accounts, with add, remove, reorder and
   * validate. None of those is expressible in a text field, which is why the
   * key gets a control of its own rather than a JSON blob to type.
   */
  it('edits support accounts as an ordered list', async () => {
    stubApi(
      settings([
        setting({
          key: 'support.accounts',
          value: ['@Support1', '@Support2'],
          zeroMeaning: 'DISABLES',
          configures: null,
          consumer: 'PLANNED',
        }),
      ]),
    );
    renderPage(<SettingsPage mayEdit denied={false} />);

    await screen.findByText('support.accounts');
    // One label per row, distinguished by its position: three identically
    // labelled fields are indistinguishable to a screen reader.
    expect((screen.getByLabelText('شناسهٔ پشتیبانی 1') as HTMLInputElement).value).toBe(
      '@Support1',
    );
    expect((screen.getByLabelText('شناسهٔ پشتیبانی 2') as HTMLInputElement).value).toBe(
      '@Support2',
    );
    expect(screen.getByRole('button', { name: 'افزودن حساب پشتیبانی' })).toBeInTheDocument();
    // Reordering is real, and keyboard-reachable: move buttons rather than a
    // drag handle a keyboard user cannot operate.
    //
    // And each row's controls are told apart by their POSITION. Three rows of
    // identically named "move up" / "move down" / "remove" buttons are one
    // undifferentiated list to a screen reader — the operator hears "remove"
    // three times and cannot tell which row they are about to delete. Asserted
    // over the accessible names rather than over the presence of a button.
    const names = screen
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? button.textContent ?? '');
    expect(names).toEqual(expect.arrayContaining(['انتقال به پایین — 1', 'انتقال به بالا — 2']));
    const rowControls = names.filter((name) =>
      /^(انتقال به بالا|انتقال به پایین|حذف) — /.test(name),
    );
    expect(new Set(rowControls).size).toBe(rowControls.length);
    expect(screen.getAllByRole('button', { name: /^حذف — / }).length).toBe(2);
  });

  it('sends the reordered list, in the new order', async () => {
    const api = stubApi([
      ...settings([
        setting({
          key: 'support.accounts',
          value: ['@Support1', '@Support2'],
          zeroMeaning: 'DISABLES',
          configures: null,
          consumer: 'PLANNED',
          version: 3,
          source: 'TENANT',
        }),
      ]),
      {
        url: '/settings/support.accounts',
        body: {
          setting: setting({ key: 'support.accounts', value: ['@Support2', '@Support1'] }),
          changed: true,
        },
      },
    ]);
    renderPage(<SettingsPage mayEdit denied={false} />);
    await screen.findByText('support.accounts');

    // The SECOND row's "move up", named by its position rather than found by
    // index into an ambiguous list.
    fireEvent.click(screen.getByRole('button', { name: 'انتقال به بالا — 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));

    await waitFor(() => {
      const write = api.calls.find((call) => call.method === 'POST');
      expect(write?.body).toMatchObject({
        value: ['@Support2', '@Support1'],
        expectedVersion: 3,
      });
    });
  });

  /** Owner revision 23 — channels, each with a required-membership flag. */
  it('edits channels with a mandatory flag per channel', async () => {
    stubApi(
      settings([
        setting({
          key: 'telegram.channels',
          value: [{ handle: '@Channel1', mandatory: true }],
          zeroMeaning: 'DISABLES',
          configures: null,
          consumer: 'PLANNED',
        }),
      ]),
    );
    renderPage(<SettingsPage mayEdit denied={false} />);

    await screen.findByText('telegram.channels');
    expect((screen.getByLabelText('شناسهٔ کانال 1') as HTMLInputElement).value).toBe('@Channel1');
    const flag = screen.getByRole('switch', { name: 'عضویت اجباری 1' });
    expect(flag).toHaveAttribute('aria-checked', 'true');
  });

  /**
   * Owner revision 24 — an amount AND a currency, plus the precedence rule.
   *
   * The per-gateway override cannot be expressed: no payment gateway is
   * registered anywhere in this system, so there is nothing for an override to
   * be keyed by. The screen says that rather than leaving the gap.
   */
  it('edits the top-up minimum as money and states the precedence it cannot yet honour', async () => {
    stubApi(
      settings([
        setting({
          key: 'wallet.topup.minimum',
          value: { amountMinor: '20000', currency: 'IRT' },
          zeroMeaning: 'DISABLES',
          configures: null,
          consumer: 'PLANNED',
        }),
      ]),
    );
    renderPage(<SettingsPage mayEdit denied={false} />);

    await screen.findByText('wallet.topup.minimum');
    expect((screen.getByLabelText('مبلغ به کوچک‌ترین واحد') as HTMLInputElement).value).toBe(
      '20000',
    );
    expect(
      (screen.getByLabelText('واحد پول — کمینهٔ شارژ کیف پول') as HTMLSelectElement).value,
    ).toBe('IRT');
    expect(screen.getByText(/حداقلِ مخصوص هر درگاه/)).toBeInTheDocument();
    expect(screen.getByText(/هیچ درگاه پرداختی ثبت نشده/)).toBeInTheDocument();
  });

  /**
   * Codex, review five: `wallet.topup.minimum` is `moneySchema`, which accepts
   * five currencies, and this select offered two. A minimum written through
   * the API in dollars was a valid stored value the screen could neither show
   * nor keep — a controlled select with no matching option shows its first,
   * and saving rewrote the currency to Toman. The screen offers what the
   * server accepts; narrowing the server is a product decision, not an
   * omission in a dropdown.
   */
  it('offers every currency the top-up minimum accepts, and keeps a stored dollar minimum', async () => {
    stubApi(
      settings([
        setting({
          key: 'wallet.topup.minimum',
          value: { amountMinor: '500', currency: 'USD' },
          zeroMeaning: 'DISABLES',
          configures: null,
          consumer: 'PLANNED',
        }),
      ]),
    );
    renderPage(<SettingsPage mayEdit denied={false} />);
    await screen.findByText('wallet.topup.minimum');

    const select = screen.getByLabelText('واحد پول — کمینهٔ شارژ کیف پول') as HTMLSelectElement;
    expect(select.value).toBe('USD');
    expect([...select.options].map((option) => option.value)).toEqual([...CURRENCY_CODES]);
  });

  /** Owner revision 1 — the currency every amount inherits. */
  it('offers Toman and Rial as the store currency, and nothing else', async () => {
    stubApi(
      settings([
        setting({ key: 'sales.currency', value: 'IRT', configures: null, consumer: 'PLANNED' }),
      ]),
    );
    renderPage(<SettingsPage mayEdit denied={false} />);
    await screen.findByText('sales.currency');

    const select = screen.getByLabelText('واحد پول — واحد پول فروشگاه') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(['IRT', 'IRR']);
    expect([...select.options].map((option) => option.text)).toEqual(['تومان', 'ریال']);
  });

  /**
   * A setting nothing reads must SAY nothing reads it.
   *
   * An operator who configures required channel membership has to know that
   * nothing enforces it yet; a screen that answers "saved" for a change with no
   * observable effect is the legacy defect the whole registry exists to end.
   */
  it('warns that a setting with no consumer changes no behaviour', async () => {
    stubApi(
      settings([
        setting({ key: 'sales.currency', value: 'IRT', configures: null, consumer: 'PLANNED' }),
        setting({ key: 'ops.notifications.max_attempts', value: 5, consumer: 'ACTIVE' }),
      ]),
    );
    renderPage(<SettingsPage mayEdit denied={false} />);
    await screen.findByText('sales.currency');

    // Exactly one of the two rows carries the warning.
    expect(screen.getAllByText(/چیزی آن را نمی‌خواند/)).toHaveLength(1);
  });

  it('offers no save control without the edit permission', async () => {
    stubApi(settings([setting()]));
    renderPage(<SettingsPage mayEdit={false} denied={false} />);
    await screen.findByText('ops.notifications.max_attempts');
    expect(screen.queryByRole('button', { name: 'ذخیره' })).toBeNull();
  });

  it('says a save that changed nothing changed nothing', async () => {
    stubApi([
      ...settings([setting({ version: 2, source: 'TENANT' })]),
      {
        url: '/settings/ops.notifications.max_attempts',
        body: { setting: setting({ version: 2, source: 'TENANT' }), changed: false },
      },
    ]);
    renderPage(<SettingsPage mayEdit denied={false} />);
    await screen.findByText('ops.notifications.max_attempts');
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));
    expect(await screen.findByText('ثبت شد، اما مقداری تغییر نکرد.')).toBeInTheDocument();
  });

  /**
   * X6 — `messageFor`'s fall-through was a third copy of the same wrong arm,
   * and the fix for it shipped with no test until a mutation run said so.
   *
   * `post()` schema-parses a mutation's response, so a save can throw a
   * `ZodError` — a tab holding a previous release across a deploy, which
   * `polling.ts` calls its headline case. This returned "خطا در ارتباط با
   * سرور": the transport worked, the server answered 200, and the sentence
   * blamed the connection. `errorCopy` collapsed the two query-view sites into
   * one rule and never reached the mutation path.
   *
   * Driven through a real save with a 200 the response schema rejects, rather
   * than by calling the function, so the assertion covers the wiring too.
   *
   * NOT to be confused with `app.tsx`'s own `messageFor`, which is a different
   * rule with a different purpose: it collapses every credential failure to one
   * message so that this screen cannot distinguish an unknown username from a
   * wrong password. That one is correct as it stands.
   */
  it('does not blame the connection for a save the server answered', async () => {
    stubApi([
      ...settings([setting({ version: 2, source: 'TENANT' })]),
      {
        url: '/settings/ops.notifications.max_attempts',
        // A 200 from another release: the shape this bundle cannot read.
        body: { unexpected: true },
      },
    ]);
    renderPage(<SettingsPage mayEdit denied={false} />);
    await screen.findByText('ops.notifications.max_attempts');
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));

    expect(await screen.findByText(t('web.rejected'))).toBeInTheDocument();
    expect(screen.queryByText(t('web.error'))).toBeNull();
  });

  /**
   * 1e — the OTHER arm of the fix round 30 made, untested in the round that is
   * about untested halves.
   *
   * `messageFor` returns the rejected copy on a final answer and the
   * connection copy otherwise, and only the first had a test. Widening it to
   * `finalAnswer(error) || error instanceof TypeError` was lint-clean,
   * prettier-clean and suite-green — and it tells an operator whose save never
   * reached the server that "the server answered and retrying will not change
   * it", which is false twice and advises against the one thing that would
   * work.
   *
   * A `fetch` that rejects is what a dropped connection actually looks like
   * here, so that is what this drives.
   */
  it('does blame the connection when the request never arrived', async () => {
    stubApi(settings([setting({ version: 2, source: 'TENANT' })]));
    renderPage(<SettingsPage mayEdit denied={false} />);
    await screen.findByText('ops.notifications.max_attempts');

    // The save leaves the browser and dies on the wire.
    const failing = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    const previous = globalThis.fetch;
    vi.stubGlobal('fetch', failing);
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));

    expect(await screen.findByText(t('web.error'))).toBeInTheDocument();
    expect(screen.queryByText(t('web.rejected'))).toBeNull();
    vi.stubGlobal('fetch', previous);
  });

  it('reports a stored value the registry no longer accepts', async () => {
    stubApi(settings([setting({ storedValueInvalid: true, version: 4, source: 'DEFAULT' })]));
    renderPage(<SettingsPage mayEdit denied={false} />);
    expect(
      await screen.findByText(/مقدار ذخیره‌شده با تعریف این کلید نمی‌خواند/),
    ).toBeInTheDocument();
  });
});

describe('management alerts', () => {
  /**
   * Owner revision 21 — the narrowing is the SERVER's.
   *
   * Filtering fifty fetched rows down to two in the browser would leave the
   * cursor having already walked past the other forty-eight, so paging would
   * drop rows silently.
   */
  /**
   * The page's own Refresh button goes when the answer is final.
   *
   * `PageHead` renders ABOVE `StateSwitch`, so the state never reached this
   * control: after a revoked permission the error card below correctly offered
   * no retry while the most obvious button on the page went on firing the
   * refused request — one `access.permission_denied` operational event and one
   * DENIED audit row per press, two in production because `main.tsx` retries
   * once. Exactly the shape the round before this one fixed on the panel
   * detail, left standing here.
   */
  it('withdraws its own refresh once the refusal is final', async () => {
    const route = {
      url: '/ops-log',
      body: { events: [event()], nextCursor: null } as unknown,
      status: 200,
    };
    const api = stubApi([route]);
    renderPage(<AlertsPage denied={false} />);
    await screen.findByText('Roles changed.');
    const refresh = screen.getByRole('button', { name: 'تازه‌سازی' });
    expect(refresh).toBeInTheDocument();

    // The permission is revoked. Pressing Refresh is what delivers the answer.
    route.status = 403;
    route.body = {
      error: {
        kind: 'forbidden',
        code: 'access.permission_denied',
        message: 'no',
        correlationId: 'test',
      },
    };
    fireEvent.click(refresh);

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'تازه‌سازی' })).toBeNull();
    });
    /*
     * And nothing else on the page can fire it either — PRESSED, not asserted
     * about.
     *
     * This read `const after = api.calls.length;` then queried the DOM then
     * asserted the count was unchanged. Nothing between the two reads could
     * change it: `queryByRole` is a pure DOM read. Three lines that could not
     * fail, under a comment claiming the strongest thing on the page.
     *
     * The first attempt at fixing it pressed `queryAllByRole('button')`, which
     * on this screen is the EMPTY LIST — so it pressed nothing and compared a
     * number to itself exactly as before. It also could not have covered the
     * `<select>` severity filter (role `combobox`) or anything inside a
     * `hidden` toolbar, which is where the controls this rule withdraws
     * actually go.
     *
     * So the claim is stated as a SET: no operable control remains. `hidden`
     * subtrees are excluded because a person cannot press them — that is the
     * whole mechanism — and the emptiness is asserted by NAME so a failure
     * says which control came back.
     */
    expect(screen.queryByRole('button', { name: 'تلاش دوباره' })).toBeNull();
    const operable = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          /*
           * Widened twice, and the second time is the instructive one.
           *
           * The first widening added exactly the two shapes the evidence used
           * — `[role="button"]` and `textarea` — and a `<summary>` still
           * survived all of these tests. `<summary>` is not hypothetical here:
           * `content.tsx` records that `setShowHistory(open)` "made the
           * `<summary>` element a retry button", so this codebase has shipped
           * that exact shape once already.
           *
           * `[tabindex]` is narrowed in the other direction: `kit.tsx` renders
           * `<div role="tabpanel" tabIndex={0}>` as a scroll container, which
           * issues nothing. Counting it would fail these tests for a div, and
           * then click it. The claim is "no operable control", not "no element
           * with a tabindex".
           *
           * What this still cannot see, stated rather than implied: a bare
           * `<div onClick={…}>`. React attaches the listener rather than an
           * attribute, so no selector can find it. That shape is a11y-broken
           * on its own terms and `check:boundaries` is where it belongs.
           */
          'button, select, input, textarea, summary, a[href],' +
            ' [role="button"], [role="link"], [role="menuitem"], [contenteditable],' +
            ' [tabindex]:not([role="tabpanel"])',
        ),
      ).filter((element) => element.closest('[hidden]') === null);
    expect(operable().map((element) => element.textContent ?? element.tagName)).toEqual([]);
    const after = api.calls.length;
    for (const control of operable()) fireEvent.click(control);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.calls.length).toBe(after);
  });

  /**
   * A DENIED page draws no control that would issue a request.
   *
   * `retryOf` alone cannot decide this, and gating on it was wrong twice. A
   * denied query is `enabled: false`, so it is `isPending` for ever and never
   * `isError` — `retryOf` hands back a callback, the control is drawn above the
   * "you do not have access" card, and pressing it calls `refetch()`, which
   * DOES fetch a disabled query in react-query 5. Two refused requests and two
   * `access.permission_denied` events per press, on a route reachable directly:
   * `navPermitted` only hides the link.
   *
   * No test in this suite had ever rendered `AlertsPage` with `denied`, which
   * is why the control survived the round that claimed to have removed it.
   */
  it('draws no request-issuing control at all when the actor is denied', async () => {
    const api = stubApi([{ url: '/ops-log', body: { events: [], nextCursor: null } }]);
    renderPage(<AlertsPage denied />);
    await screen.findByText('شما به این بخش دسترسی ندارید.');

    expect(screen.queryByRole('button', { name: 'تازه‌سازی' })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'حل‌نشده' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'قدیمی‌تر' })).toBeNull();
    // Nothing on the page can have asked the server anything.
    expect(api.calls).toHaveLength(0);
  });

  /**
   * The filters mint a NEW query key, which is a fresh request against a
   * question the card below has just said cannot be answered.
   */
  it('withdraws its filters once the refusal is final', async () => {
    const route = {
      url: '/ops-log',
      body: { events: [event()], nextCursor: null } as unknown,
      status: 200,
    };
    const api = stubApi([route]);
    renderPage(<AlertsPage denied={false} />);
    await screen.findByText('Roles changed.');
    expect(screen.getByRole('combobox')).toBeInTheDocument();

    route.status = 403;
    route.body = {
      error: {
        kind: 'forbidden',
        code: 'access.permission_denied',
        message: 'no',
        correlationId: 'test',
      },
    };
    fireEvent.click(screen.getByRole('button', { name: 'تازه‌سازی' }));

    await waitFor(() => {
      expect(screen.queryByRole('combobox')).toBeNull();
    });
    // The same non-assertion as the refresh test above, and the same fix: the
    // set of operable controls, by name, rather than a count compared to
    // itself. `select` is in the query because the control this test is named
    // for IS one.
    expect(screen.queryByRole('button', { name: 'حل‌نشده' })).toBeNull();
    const operable = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          /*
           * Widened twice, and the second time is the instructive one.
           *
           * The first widening added exactly the two shapes the evidence used
           * — `[role="button"]` and `textarea` — and a `<summary>` still
           * survived all of these tests. `<summary>` is not hypothetical here:
           * `content.tsx` records that `setShowHistory(open)` "made the
           * `<summary>` element a retry button", so this codebase has shipped
           * that exact shape once already.
           *
           * `[tabindex]` is narrowed in the other direction: `kit.tsx` renders
           * `<div role="tabpanel" tabIndex={0}>` as a scroll container, which
           * issues nothing. Counting it would fail these tests for a div, and
           * then click it. The claim is "no operable control", not "no element
           * with a tabindex".
           *
           * What this still cannot see, stated rather than implied: a bare
           * `<div onClick={…}>`. React attaches the listener rather than an
           * attribute, so no selector can find it. That shape is a11y-broken
           * on its own terms and `check:boundaries` is where it belongs.
           */
          'button, select, input, textarea, summary, a[href],' +
            ' [role="button"], [role="link"], [role="menuitem"], [contenteditable],' +
            ' [tabindex]:not([role="tabpanel"])',
        ),
      ).filter((element) => element.closest('[hidden]') === null);
    expect(operable().map((element) => element.textContent ?? element.tagName)).toEqual([]);
    const after = api.calls.length;
    for (const control of operable()) fireEvent.click(control);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.calls.length).toBe(after);
  });

  /**
   * F8 — a refusal is not the only final answer, and the others said the wrong
   * thing at every site that draws an error card.
   *
   * The previous round widened the copy for `refused()` — a 403 — and stopped
   * there. `finalAnswer` is broader: it also covers a `ZodError` thrown on the
   * SUCCESS path, which `polling.ts` calls its headline case ("a tab holding a
   * previous release across a deploy hits it on every tick"), plus a 404 and a
   * 400. For all of those the card said "خطا در ارتباط با سرور" and
   * "ارتباط با سرور برقرار نشد. دوباره تلاش کنید." — two false statements,
   * since the server answered correctly and fast — beside no retry button at
   * all, because `retryOf` withholds it on a final answer. The hint instructed
   * the reader to do the one thing the screen had removed the means to do.
   *
   * Driven with a 200 whose body the response schema rejects, which is that
   * exact deploy-skew case rather than an approximation of it.
   */
  it('does not call a rejected answer a connection failure', async () => {
    // A 200. The transport worked; the body is from another release.
    stubApi([{ url: '/ops-log', body: { unexpected: true } }]);
    renderPage(<AlertsPage denied={false} />);

    expect(await screen.findByText(t('web.rejected'))).toBeInTheDocument();
    expect(screen.getByText(t('web.rejected_hint'))).toBeInTheDocument();

    // The two sentences that were false, and the button the old hint named.
    expect(screen.queryByText(t('web.error'))).toBeNull();
    expect(screen.queryByText(t('web.error_hint'))).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.retry') })).toBeNull();

    // …and it is not mistaken for a refusal either. The server did not say no.
    expect(screen.queryByText(t('web.no_permission'))).toBeNull();
  });

  /**
   * The alerts PAGER's final-answer half, which had no test either.
   *
   * Round 29's prose treated this pager as the one already covered. What
   * covered it was `draws no request-issuing control at all when the actor is
   * denied` — the `denied` half only. `{!denied && (` was therefore lint-clean,
   * prettier-clean and suite-clean, and it puts the pager back over a finally
   * refused list. Three of the five gates had exactly half a test; this is the
   * third of the three.
   */
  it('withdraws the pager once the refusal is final', async () => {
    stubApi([
      {
        url: '/ops-log',
        body: {
          error: {
            kind: 'forbidden',
            code: 'access.permission_denied',
            message: 'no',
            correlationId: 'test',
          },
        },
        status: 403,
      },
    ]);
    renderPage(<AlertsPage denied={false} />);
    await screen.findByText(t('web.no_permission'));

    expect(screen.queryByRole('button', { name: 'قدیمی‌تر' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'تازه‌تر' })).toBeNull();
    expect(screen.queryByText('نمایش')).toBeNull();
  });

  /**
   * 1b/1c for the alerts pager — the same two untested states, one screen over.
   *
   * Deleting `denied ? 'denied' :` from this gate, and widening it to accept
   * `'loading'`, both left all 290 tests green. The mid-session revocation is
   * the case the rule exists for: the shell's 60-second permission poll turns
   * `denied` true while the rows fetched a moment ago are still on screen.
   */
  it('withdraws the pager when the permission is lost over rows already shown', async () => {
    stubApi([{ url: '/ops-log', body: { events: [event()], nextCursor: null } }]);
    const { rerender } = renderPage(<AlertsPage denied={false} />);
    await screen.findByText('Roles changed.');
    expect(screen.getByText('نمایش')).toBeInTheDocument();

    rerender(<AlertsPage denied />);

    expect(screen.queryByText('نمایش')).toBeNull();
    expect(screen.queryByRole('button', { name: 'قدیمی‌تر' })).toBeNull();
  });

  it('draws no pager before the first page of alerts has arrived', () => {
    stubApi([{ url: '/ops-log', body: { events: [event()], nextCursor: null } }]);
    renderPage(<AlertsPage denied={false} />);
    expect(screen.queryByText('نمایش')).toBeNull();
  });

  /**
   * F3 at the alerts gate — same rule, same untested arm.
   */
  it('keeps the way back when an alerts page turns out to be empty', async () => {
    stubApi([{ url: '/ops-log', body: { events: [], nextCursor: null } }]);
    renderPage(<AlertsPage denied={false} />);
    // The page defaults to HISTORY, so this is the filtered emptiness.
    await screen.findByText(t('web.alerts_empty_filtered'));
    expect(screen.getByText('نمایش')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'تازه‌تر' })).toBeInTheDocument();
  });

  it('asks the server for the management scope', async () => {
    const api = stubApi([{ url: '/ops-log', body: { events: [event()], nextCursor: null } }]);
    renderPage(<AlertsPage denied={false} />);
    await screen.findByText('Roles changed.');

    // The EXACT scope, parsed. `toContain('scope=MANAGEMENT')` is satisfied by
    // `scope=MANAGEMENT_CONDITIONS` too, so it could not tell this page's
    // history view from the dashboard's narrower card — the same defect that
    // was fixed on the dashboard assertion and left here.
    const params = new URL(api.calls[0]?.url ?? '', 'https://admin.example.test').searchParams;
    expect(params.get('scope')).toBe('MANAGEMENT');
    // The default view is history, so no open filter is sent at all.
    expect(params.get('open')).toBeNull();
  });

  /**
   * A filter change starts again from the newest page.
   *
   * Deleting `setTrail([])` from `filter()` left all 963 tests green. Without
   * it the stale `before`/`beforeId` is reused, so the narrowed query returns
   * only rows OLDER than the cursor and every matching newer row is silently
   * omitted — page three of a list whose page one was never shown, on the
   * surface whose stated rule is that silence is the one outcome it may not
   * produce.
   */
  it('starts again from the newest page when the filter changes', async () => {
    const api = stubApi([
      {
        url: '/ops-log',
        body: {
          events: [event({ message: 'first page' })],
          nextCursor: { at: '2026-09-06T07:00:00.000Z', id: 'cursor-1' },
        },
      },
    ]);
    renderPage(<AlertsPage denied={false} />);
    await screen.findByText('first page');

    fireEvent.click(screen.getByRole('button', { name: 'قدیمی‌تر' }));
    await waitFor(() => {
      expect(api.calls.some((call) => call.url.includes('beforeId='))).toBe(true);
    });

    fireEvent.change(screen.getByLabelText('شدت'), { target: { value: 'ERROR' } });
    await waitFor(() => {
      expect(api.calls.at(-1)?.url).toContain('severity=ERROR');
    });
    const narrowed = new URL(api.calls.at(-1)?.url ?? '', 'https://admin.example.test');
    expect(narrowed.searchParams.get('beforeId')).toBeNull();
    expect(narrowed.searchParams.get('before')).toBeNull();
  });

  it('pages with the SERVER cursor pair rather than an offset', async () => {
    // The cursor is the server's, not a guess from the last row on screen. The
    // reader over-fetches one row and hands back the pair it actually stopped
    // at, so the browser never has to reconstruct it.
    const full = Array.from({ length: 25 }, (_, index) =>
      event({ id: `e${index}`, lastSeenAt: `2026-09-06T08:00:0${index % 10}.000Z` }),
    );
    const api = stubApi([
      {
        url: '/ops-log',
        body: { events: full, nextCursor: { at: '2026-09-06T08:00:04.000Z', id: 'e24' } },
      },
    ]);
    renderPage(<AlertsPage denied={false} />);
    await screen.findAllByText('Roles changed.');

    fireEvent.click(screen.getByRole('button', { name: 'قدیمی‌تر' }));
    await waitFor(() => {
      const paged = api.calls.find((call) => call.url.includes('beforeId'));
      expect(paged?.url).toContain('beforeId=e24');
      // Both halves of the cursor: `firstSeenAt` alone is not unique, and a
      // strict comparison on it skips the tail of a group that straddles a page.
      expect(paged?.url).toContain('before=2026-09-06T08%3A00%3A04.000Z');
    });
  });

  /**
   * The false negative this page could produce, and the reason `hasNext` reads
   * the server's `nextCursor` rather than the page's own length.
   *
   * A page can come back FULL and still be the last one: with exactly
   * `ALERTS_PAGE_SIZE` matching rows, `events.length === limit` while nothing
   * lies behind it. Deriving "older" from the length therefore offered a page
   * that did not exist, and one press past the end rendered "there are no open
   * alerts" over alerts that existed one page back — a silence, in the
   * subsystem whose stated rule is that silence is the one outcome it may not
   * produce. The reader over-fetches one row so the question is answered by
   * the server, and a full-but-final page reports `nextCursor: null`.
   */
  it('offers no older page on a FULL page the server reports as the last one', async () => {
    const full = Array.from({ length: 25 }, (_, index) =>
      event({ id: `e${index}`, lastSeenAt: `2026-09-06T08:00:0${index % 10}.000Z` }),
    );
    const api = stubApi([{ url: '/ops-log', body: { events: full, nextCursor: null } }]);
    renderPage(<AlertsPage denied={false} />);
    await screen.findAllByText('Roles changed.');

    // A page-length comparison would have enabled this: 25 rows, limit 25.
    expect(screen.getByRole('button', { name: 'قدیمی‌تر' })).toBeDisabled();
    // And it asked for a bounded page, which is what makes the case reachable.
    expect(api.calls[0]?.url).toContain('limit=25');
  });

  it('offers no older page when the page came back short', async () => {
    const api = stubApi([{ url: '/ops-log', body: { events: [event()], nextCursor: null } }]);
    renderPage(<AlertsPage denied={false} />);
    await screen.findByText('Roles changed.');

    expect(screen.getByRole('button', { name: 'قدیمی‌تر' })).toBeDisabled();
    expect(api.calls[0]?.url).toContain('limit=25');
  });

  /**
   * T16 — a one-shot record is HISTORY, not outstanding work.
   *
   * `resolvedAt` is permanently null for a denial, a lockout and an
   * administrator change, by design: there is no recovery, and there is
   * deliberately no "mark as seen". Rendering the same resolved/unresolved
   * badge over those framed every denial ever recorded as a live backlog — the
   * exact reading this page exists to prevent, and the reason the dashboard
   * asks a narrower scope.
   */
  it('marks a one-shot record as recorded rather than unresolved', async () => {
    stubApi([
      {
        url: '/ops-log',
        body: {
          nextCursor: null,
          events: [
            event({ code: 'access.permission_denied', message: 'A denial.', resolvedAt: null }),
            event({
              id: '01a05e35-c9ad-7e93-bef3-1ed9b55292d0',
              code: 'settings.stored_value_invalid',
              message: 'A condition.',
              resolvedAt: null,
            }),
          ],
        },
      },
    ]);
    const { container } = renderPage(<AlertsPage denied={false} />);
    await screen.findByText('A denial.');

    // Read off the ROWS, because "باز" is also the open-filter pill's label.
    const rows = Array.from(container.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(2);
    const stateOf = (row: Element) => (row.querySelectorAll('td')[6]?.textContent ?? '').trim();

    // The one-shot row: a neutral statement of record.
    expect(stateOf(rows[0] as Element)).toBe('ثبت‌شده');
    // The condition row, with the same null `resolvedAt`, still reads as open —
    // so this is not simply "the badge was removed".
    expect(stateOf(rows[1] as Element)).toBe('باز');
  });

  /**
   * THREE kinds, not two — and this is the third.
   *
   * A recovery row is inserted with its own `resolvedAt` null: it closes the
   * failure above it and nothing ever closes a recovery. Treating every
   * non-one-shot null as an open failure therefore put a warning "unresolved"
   * badge on the row whose message announces the problem ended. Same defect as
   * the one-shot case, one classification along.
   */
  it('marks a recovery as recovered rather than unresolved', async () => {
    stubApi([
      {
        url: '/ops-log',
        body: {
          nextCursor: null,
          events: [
            event({
              code: 'settings.stored_value_valid',
              severity: 'INFO',
              message: 'A recovery.',
              resolvedAt: null,
            }),
            event({
              id: '01a05e35-c9ad-7e93-bef3-1ed9b55292d1',
              code: 'settings.stored_value_invalid',
              message: 'An open failure.',
              resolvedAt: null,
            }),
          ],
        },
      },
    ]);
    const { container } = renderPage(<AlertsPage denied={false} />);
    await screen.findByText('A recovery.');

    const rows = Array.from(container.querySelectorAll('tbody tr'));
    const stateOf = (row: Element) => (row.querySelectorAll('td')[6]?.textContent ?? '').trim();
    // The recovery: over, not outstanding.
    expect(stateOf(rows[0] as Element)).toBe('برطرف شد');
    // The failure beside it, with the identical null `resolvedAt`, still open —
    // so this is not "the badge was removed".
    expect(stateOf(rows[1] as Element)).toBe('باز');
  });

  it('still marks a RESOLVED condition resolved', async () => {
    stubApi([
      {
        url: '/ops-log',
        body: {
          nextCursor: null,
          events: [
            event({
              code: 'settings.stored_value_invalid',
              message: 'A closed condition.',
              resolvedAt: '2026-09-06T09:00:00.000Z',
            }),
          ],
        },
      },
    ]);
    const { container } = renderPage(<AlertsPage denied={false} />);
    await screen.findByText('A closed condition.');
    const cells = container.querySelectorAll('tbody tr td');
    expect((cells[6]?.textContent ?? '').trim()).toBe('برطرف شد');
  });

  it('says plainly that it is not the operational history', async () => {
    stubApi([{ url: '/ops-log', body: { events: [], nextCursor: null } }]);
    renderPage(<AlertsPage denied={false} />);
    expect(await screen.findByText('این صفحه تاریخچهٔ عملیاتی نیست')).toBeInTheDocument();
    expect(screen.getByText(/گروه گزارش تلگرام/)).toBeInTheDocument();
  });

  /**
   * The default is HISTORY, not open items — and the reason is C1.
   *
   * Most of the management scope is one-shot records: a denial, a lockout, an
   * administrator added. None of them is ever resolved, because there is
   * deliberately no "mark as seen". Defaulting to `open=true` therefore showed
   * every denial ever recorded, for ever, framed as outstanding work. The
   * conditions that genuinely ARE outstanding have the dashboard's own card,
   * which asks the server for `MANAGEMENT_CONDITIONS`.
   */
  it('defaults to the management history and can be narrowed to open items', async () => {
    const api = stubApi([{ url: '/ops-log', body: { events: [], nextCursor: null } }]);
    renderPage(<AlertsPage denied={false} />);
    // The FILTERED empty state, because the default view is history and did not
    // ask whether anything is open. This assertion used to name the open-alert
    // copy, which pinned the wrong string in place: the page said "there is no
    // open alert" over a view that had not asked the question.
    await screen.findByText('چیزی با این پالایه‌ها پیدا نشد.');
    expect(screen.queryByText('هشدار بازی وجود ندارد.')).toBeNull();
    expect(api.calls[0]?.url).not.toContain('open=');

    fireEvent.click(screen.getByRole('button', { name: 'باز' }));
    await waitFor(() => {
      expect(api.calls.some((call) => call.url.includes('open=true'))).toBe(true);
    });
  });

  /**
   * The strong claim is made only by the view that earns it.
   *
   * "There is no open alert" is a statement about the whole management
   * condition set. The page can only make it from the unfiltered open-only
   * view, because that is the only one that asked.
   */
  it('claims that nothing is open only from the unfiltered open view', async () => {
    stubApi([{ url: '/ops-log', body: { events: [], nextCursor: null } }]);
    renderPage(<AlertsPage denied={false} />);
    await screen.findByText('چیزی با این پالایه‌ها پیدا نشد.');

    fireEvent.click(screen.getByRole('button', { name: 'باز' }));
    // Now it has asked, so now it may answer.
    await screen.findByText('هشدار بازی وجود ندارد.');
    expect(screen.queryByText('چیزی با این پالایه‌ها پیدا نشد.')).toBeNull();
  });

  /**
   * The concrete falsehood, at the state that produced it.
   *
   * `settings.stored_value_invalid` is a WARN. An operator on the open view who
   * selects severity ERROR empties the table — and the page then declared that
   * no open management condition had been recorded, over one that was open and
   * merely filtered out. Silence is the one outcome this subsystem may not
   * produce, and that was silence with a reassurance printed on top.
   */
  it('does not deny that anything is open when a severity filter emptied the page', async () => {
    stubApi([{ url: '/ops-log', body: { events: [], nextCursor: null } }]);
    renderPage(<AlertsPage denied={false} />);
    await screen.findByText('چیزی با این پالایه‌ها پیدا نشد.');
    fireEvent.click(screen.getByRole('button', { name: 'باز' }));
    await screen.findByText('هشدار بازی وجود ندارد.');

    fireEvent.change(screen.getByLabelText('شدت'), { target: { value: 'ERROR' } });

    // `findBy`, not `getBy`: the filter change refetches, and asserting during
    // the skeleton would pass for any implementation — the strong copy is
    // absent while loading too.
    expect(await screen.findByText('چیزی با این پالایه‌ها پیدا نشد.')).toBeInTheDocument();
    expect(screen.queryByText('هشدار بازی وجود ندارد.')).toBeNull();
  });

  /**
   * An empty page three says nothing about pages one and two.
   *
   * The pager only offers "older" when the server sent a cursor, so an empty
   * older page needs a condition to resolve between the two requests — but it
   * is reachable, and the claim it produced was the strong one: "there is no
   * open alert", printed by a view that had just shown several.
   */
  it('does not deny that anything is open from a page after the first', async () => {
    stubApi([
      {
        url: '/ops-log',
        body: {
          events: [event({ message: 'A budget filled up.' })],
          nextCursor: {
            at: '2026-09-06T08:00:00.000Z',
            id: '01a05e35-c9ad-7e93-bef3-1ed9b55292c9',
          },
        },
      },
    ]);
    renderPage(<AlertsPage denied={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'باز' }));
    await screen.findByText('A budget filled up.');

    // Page two, and by then the condition has been resolved elsewhere.
    stubApi([{ url: '/ops-log', body: { events: [], nextCursor: null } }]);
    fireEvent.click(screen.getByRole('button', { name: 'قدیمی‌تر' }));

    expect(await screen.findByText('چیزی با این پالایه‌ها پیدا نشد.')).toBeInTheDocument();
    expect(screen.queryByText('هشدار بازی وجود ندارد.')).toBeNull();
  });

  /**
   * The banner may not promise a class of alert this scope cannot return.
   *
   * It listed «ازکارافتادن کانال اعلان» — the notification channel failing —
   * and no management code is notification-related.
   * `notification.attempts_exhausted` is a delivery-attempt `errorCode`, never
   * an `operational_events.code`, and the one real notification code is
   * deliberately excluded. An operator whose Telegram destination was
   * misconfigured would have opened this page on the banner's promise, seen
   * their admin history, and concluded the channel was fine.
   *
   * Joined to the codes rather than asserted as a string: the first assertion
   * is the fact that makes the second one required, so if a notification code
   * is ever admitted to the scope, this test is where the copy gets revisited.
   */
  it('promises no alert class the management scope cannot return', () => {
    const notificationCodes = MANAGEMENT_EVENT_CODES.filter((code) =>
      code.startsWith('notification.'),
    );
    expect(notificationCodes).toEqual([]);

    // The banner has two clauses: what arrives HERE, and what goes to the
    // Telegram report group instead. Only the first is a promise this page has
    // to keep, and asserting over the whole string would forbid naming the
    // notification channel at all — which would make the banner less useful,
    // not more honest.
    const body = t('web.alerts_scope_body');
    const [arrivesHere, goesElsewhere] = body.split('جریان روتین');
    expect(goesElsewhere, 'the banner no longer says where the routine stream goes').toBeDefined();
    expect(arrivesHere).not.toContain('کانال اعلان');
    expect(goesElsewhere).toContain('کانال اعلان');
  });

  /**
   * The SCOPE follows the filter, which was the unimplemented half of the
   * one-shot rule.
   *
   * A denial, a lockout and an administrator change have a permanently null
   * `resolvedAt` by design. Asking the WIDE scope for `open=true` therefore
   * returned every one of them ever recorded, framed as outstanding work — and
   * the page then rendered each with the neutral "recorded" badge the other
   * half of the fix had added, contradicting itself in that one state. "Open"
   * narrows to the codes something can actually close.
   */
  it('asks for the conditions scope when narrowed to open items', async () => {
    const api = stubApi([{ url: '/ops-log', body: { events: [], nextCursor: null } }]);
    renderPage(<AlertsPage denied={false} />);
    // The default view is history, so this is the filtered empty state.
    await screen.findByText('چیزی با این پالایه‌ها پیدا نشد.');

    const scopeOf = (url: string) =>
      new URL(url, 'https://admin.example.test').searchParams.get('scope');
    expect(scopeOf(api.calls[0]?.url ?? '')).toBe('MANAGEMENT');

    fireEvent.click(screen.getByRole('button', { name: 'باز' }));
    await waitFor(() => {
      const open = api.calls.find((call) => call.url.includes('open=true'));
      expect(open, 'no open request was made').toBeDefined();
      // The exact value, parsed: `MANAGEMENT` is a substring of this one, and
      // that is how the same defect went unnoticed on the dashboard.
      expect(scopeOf(open?.url ?? '')).toBe('MANAGEMENT_CONDITIONS');
    });

    // ...and going back to history restores the wide scope, so the narrowing
    // is a filter rather than a one-way door.
    fireEvent.click(screen.getByRole('button', { name: 'همه' }));
    await waitFor(() => {
      const last = api.calls[api.calls.length - 1];
      expect(scopeOf(last?.url ?? '')).toBe('MANAGEMENT');
    });
  });
});

describe('system and operations', () => {
  /**
   * The capacity note may not claim an alarm that does not exist.
   *
   * Two of the three ceilings have a condition behind them —
   * `tenantFreshPanelCeiling` raises `panel.monitor.tenant_budget_exceeded`,
   * `installationFreshPanelCeiling` raises the scheduler condition. The third,
   * `tenantTurnCeiling`, has exactly one production caller: this response. The
   * number of tenants is not configuration — it grows — so nothing can refuse a
   * fleet that outgrows the rotation, and no condition fires on it.
   *
   * The note said the server computes "these numbers" with the same functions
   * that issue the capacity warnings, over all three. An installation with 140
   * single-panel tenants sits far under the 900-panel scheduler ceiling, shows a
   * green within-capacity badge beside it, and silently never rotates eighty of
   * them inside the freshness window.
   */
  it('says which ceilings have an alarm behind them and which does not', () => {
    const note = t('web.monitor_capacity_ceiling_note');
    // Named, so the reader knows which two the claim covers.
    expect(note).toContain(t('web.monitor_tenant_ceiling'));
    expect(note).toContain(t('web.monitor_installation_ceiling'));
    // And the third is excluded from it explicitly, not by omission.
    expect(note).toContain(t('web.monitor_tenant_turn_ceiling'));
    expect(note).toContain('هیچ هشداری پشت آن نیست');
  });

  const route = { path: '/system', query: new URLSearchParams() };

  /**
   * Codex, review five: the installation capacity condition is written by the
   * monitor on its own cycle and this profile is the only Web Admin surface
   * that can show it. Without an interval the tab said "within capacity"
   * through an overload, or kept a resolved alarm until navigation.
   */
  it('re-reads the monitor profile while the monitor tab stays open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = stubApi([
      {
        url: '/system/monitor',
        body: {
          monitor: {
            enabled: true,
            tickMs: 30000,
            healthyIntervalMs: 180000,
            retryableIntervalMs: 120000,
            nonRetryableIntervalMs: 3600000,
            batchSize: 150,
            concurrency: 4,
            tenantsPerTick: 10,
            probeTenantLimit: 100,
            probeTenantWindowMs: 300000,
            probeCooldownMs: 10000,
            budgetReservePercent: 40,
            freshForMs: 900000,
            tenantFreshPanelCeiling: 60,
            installationFreshPanelCeiling: 900,
            tenantTurnCeiling: 60,
            schedulerCapacityExceeded: false,
          },
        },
      },
    ]);
    const monitorRoute = { path: '/system', query: new URLSearchParams('section=monitor') };
    renderPage(<SystemPage route={monitorRoute} permissions={['panels.view', 'admins.view']} />);
    await screen.findByText(t('web.monitor_within_capacity'));

    const countOf = () => api.calls.filter((call) => call.url.includes('/system/monitor')).length;
    const before = countOf();
    expect(before).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(65_000);
    await waitFor(() => {
      expect(countOf()).toBeGreaterThan(before);
    });
    vi.useRealTimers();
  });

  /** Owner revision 25 — the general logs surface does not exist. */
  it('has no logs page, and says its absence is a decision', async () => {
    stubApi([
      { url: '/system/readiness', body: { status: 'ok', dependencies: [] } },
      {
        url: '/health/info',
        body: {
          name: 'nexa',
          version: '1.0.0',
          commit: 'abc123',
          buildTime: '2026-09-06T00:00:00.000Z',
          nodeVersion: 'v22.11.0',
          environment: 'production',
        },
      },
    ]);
    renderPage(<SystemPage route={route} permissions={['panels.view', 'admins.view']} />);

    expect(await screen.findByText('صفحهٔ لاگ عمومی وجود ندارد')).toBeInTheDocument();
    // No tab leads to one, and nothing on the page is a log browser.
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(tabs).toEqual(['وضعیت', 'پایش', 'مدیران']);
    expect(screen.getByText(/گروه گزارش تلگرام/)).toBeInTheDocument();
  });
});
