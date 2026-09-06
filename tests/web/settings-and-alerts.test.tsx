import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { SettingsPage } from '../../apps/web/src/pages/settings';
import { AlertsPage } from '../../apps/web/src/pages/alerts';
import { SystemPage } from '../../apps/web/src/pages/system';
import { event, renderPage, setting, stubApi } from './harness';
import { MANAGEMENT_EVENT_CODES } from '@nexa/contracts';
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
      // Both halves of the cursor: `lastSeenAt` alone is not unique, and a
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
